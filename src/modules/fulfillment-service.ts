import {createHash, randomUUID} from "node:crypto";
import type {CdkVoucher, Fulfillment, Order, TenantContext} from "../domain/model.js";
import type {Repository} from "../infra/repository.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import {AppError, notFound} from "../domain/errors.js";
import {assertFulfillmentTransition} from "../domain/state-machines.js";
import type {RechargeCredential, RechargeUpstreamProvider, UpstreamOrderState} from "../upstream/recharge-provider.js";
import {UpstreamRequestError} from "../upstream/recharge-provider.js";
import {WebhookService} from "./webhook-service.js";
import {LiveTestPolicy} from "./live-test-policy.js";
import {partnerFulfillmentMessage, partnerFulfillmentSnapshot, partnerProgressStage, safeResultMessage} from "./fulfillment-public.js";
import {latestFulfillmentOf, orderSyncMark} from "../domain/order-sync-mark.js";
import {canResubmitFulfillment, isConfirmedUnsuccessfulFulfillment} from "../domain/recharge-policy.js";

interface QueuedPayload {
  credential: RechargeCredential;
  upstreamCdkCode?: string;
}

export class FulfillmentService {
  constructor(
    private readonly repository: Repository,
    private readonly cipher: SensitivePayloadCipher,
    private readonly webhooks: WebhookService,
    private readonly upstream: RechargeUpstreamProvider,
    private readonly livePolicy?: LiveTestPolicy,
    private readonly onFinancialChange?: (orderId: string) => void,
  ) {}

  create(tenant: TenantContext, orderId: string, sessionData: Record<string, unknown>): Fulfillment {
    const order = this.repository.findOrder(tenant.merchantId, orderId);
    if (!order) throw notFound("order");
    if ((order.fulfillmentMode ?? "direct") !== "direct") {
      throw new AppError(409, "cdk_redemption_required", "该商品必须通过 Quefa CDK 兑换入口完成");
    }
    return this.createForOrder(order, {credential: normalizeCredential(sessionData)});
  }

  createDirectPublic(order: Order, credential: RechargeCredential): Fulfillment {
    if ((order.fulfillmentMode ?? "direct") !== "direct") throw new AppError(409, "invalid_fulfillment_mode", "该订单不是直接充值商品");
    return this.createForOrder(order, {credential});
  }

  createCdkPublic(order: Order, voucher: CdkVoucher, upstreamCdkCode: string, credential: RechargeCredential): Fulfillment {
    return this.repository.transaction(() => this.reserveAndCreateCdk(order, voucher, upstreamCdkCode, credential));
  }

  async preflightPublic(order: Order, credential: RechargeCredential, upstreamCdkCode?: string): Promise<{
    accountEmail: string; currentPlan: string | null; targetPlan: string | null;
  }> {
    if (this.repository.findOrderInternal(order.id)?.archivedAt) throw new AppError(410, "order_archived", "该测试订单已归档，不能继续充值");
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) {
      throw new AppError(409, "order_not_paid", "只有已支付订单可以提交充值");
    }
    try {
      if ((order.fulfillmentMode ?? "direct") === "cdk") {
        if (!upstreamCdkCode) throw new AppError(409, "voucher_unavailable", "兑换码不可用");
        const result = await this.upstream.preflightCdk({upstreamCode: upstreamCdkCode, credential, deviceId: deviceId(`preflight:${order.id}`)});
        return result;
      }
      const result = await this.upstream.preflightDirect({
        product: order.upstreamProduct ?? "gpt",
        plan: order.upstreamPlan ?? "plus",
        credential,
      });
      return result;
    } catch (error) {
      if (error instanceof UpstreamRequestError) {
        const code = publicFailureCode(error);
        throw new AppError(422, code, publicFailureMessage(code, error.message));
      }
      throw error;
    }
  }

  private reserveAndCreateCdk(order: Order, voucher: CdkVoucher, upstreamCdkCode: string, credential: RechargeCredential): Fulfillment {
    voucher = this.repository.findCdkVoucherByOrder(order.id) ?? voucher;
    if ((order.fulfillmentMode ?? "direct") !== "cdk") throw new AppError(409, "invalid_fulfillment_mode", "该订单不是CDK商品");
    if (voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "兑换码已使用或正在兑换");
    this.repository.updateCdkVoucher({...voucher, status: "reserved"});
    try {
      return this.createForOrder(order, {credential, upstreamCdkCode}, voucher.id);
    } catch (error) {
      this.repository.updateCdkVoucher(voucher);
      throw error;
    }
  }

  list(merchantId: string, orderId: string): Fulfillment[] {
    if (!this.repository.findOrder(merchantId, orderId)) throw notFound("order");
    return this.repository.listFulfillments(merchantId, orderId);
  }

  /** A failed historical attempt or a refunded order must not reopen the customer's input form. */
  canResubmit(value: Fulfillment): boolean {
    if (!canResubmitFulfillment(value)) return false;
    const order = this.repository.findOrder(value.merchantId, value.orderId);
    if (!order || !["paid", "partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor > 0n) return false;
    const attempts = this.repository.listFulfillments(value.merchantId, value.orderId);
    if (latestFulfillmentOf(attempts)?.id !== value.id || attempts.some(task => ["queued", "running", "succeeded"].includes(task.status))) return false;
    if (this.repository.listRefundsForOrder(value.merchantId, value.orderId).some(refund => ["requested", "approved", "processing"].includes(refund.status))) return false;
    if (value.voucherId) {
      const voucher = this.repository.findCdkVoucherByOrder(value.orderId);
      if (!voucher || voucher.id !== value.voucherId || voucher.status !== "unused" || !voucher.upstreamCodePayload.ciphertext) return false;
    }
    return true;
  }

  async processOne(): Promise<Fulfillment | null> {
    // Historical refunds may have stopped dispatch without closing the queued task.
    // Only close an attempt that has never crossed the persisted submission checkpoint.
    const now=new Date(),indexed=this.repository.findRefundedFulfillmentCleanupOrder?.(now);
    const refundedOrders=this.repository.findRefundedFulfillmentCleanupOrder?(indexed?[indexed]:[]):this.repository.listOrdersInternal();
    for (const order of refundedOrders) {
      if (order.paymentStatus !== "refunded") continue;
      const closed = this.closeRefundedOrder(order.id);
      if (closed) return closed;
    }
    const current = this.repository.transaction(() => {
      const now = new Date();
      const due = this.repository.listProcessableFulfillments(20, now)
        .find((item) => {
          if (item.leaseUntil && item.leaseUntil > now) return false;
          if (item.status !== "queued" || !this.livePolicy) return true;
          const order = this.repository.findOrderInternal(item.orderId);
          return !!order && this.livePolicy.canFulfill(order)
            && (!this.livePolicy.requiresApproval(order) || item.liveSubmissionApproved === true);
        });
      if (!due) return null;
      const claimed = {...due, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 300_000)};
      this.repository.updateFulfillment(claimed);
      return claimed;
    });
    if (!current) return null;
    if (current.status === "queued") return this.submit(current);
    return this.poll(current);
  }

  closeRefundedOrder(orderId: string): Fulfillment | null {
    return this.repository.transaction(() => {
      const order = this.repository.findOrderInternal(orderId);
      if (!order || order.paymentStatus !== "refunded") return null;
      if (order.fallbackRechargeAvailable) this.repository.updateOrder({...order, fallbackRechargeAvailable: false, updatedAt: new Date()});
      const task = this.repository.listFulfillments(order.merchantId, order.id).find(value =>
        value.status === "queued" && !value.upstreamOrderId && !value.upstreamProvider && !value.upstreamStatus
        && !value.upstreamLookupToken && !value.lookupPayload?.ciphertext
        && (!value.leaseToken || (!!value.leaseUntil && value.leaseUntil <= new Date())));
      if (!task) {
        const ended = this.repository.listFulfillments(order.merchantId, order.id)
          .find(value => isConfirmedUnsuccessfulFulfillment(value) && value.recoveryAction !== "refund");
        return ended ? this.saveProgress({...ended, recoveryAction: "refund", recoveryReason: "全额退款已确认，关闭重提入口",
          sessionPayload: this.cipher.clear(ended.sessionPayload)}) : null;
      }
      return this.finish({...task, status: "cancelled", failureCode: "cancelled", retryAllowed: true,
        recoveryAction: "refund", recoveryReason: "全额退款已确认，关闭尚未派发的充值任务",
        message: "订单已全额退款，充值任务已关闭", leaseToken: null, leaseUntil: null,
        sessionPayload: this.cipher.clear(task.sessionPayload), finishedAt: new Date()});
    });
  }

  applyUpstreamEvent(clientRequestId: string, state: UpstreamOrderState): Fulfillment | null {
    const current = this.repository.findFulfillmentByUpstreamClientRequestId(clientRequestId);
    if (!current || isTerminal(current.status)) return current;
    if (current.upstreamOrderId && state.orderId && current.upstreamOrderId !== state.orderId) {
      throw new AppError(409, "recharge_order_reference_conflict", "充值回调订单引用不匹配");
    }
    return this.applyState(current, state, false);
  }

  approveLiveSubmission(merchantId: string, fulfillmentId: string): Fulfillment {
    return this.repository.transaction(() => {
      const task = this.repository.findFulfillment(merchantId, fulfillmentId);
      if (!task || task.status !== "queued" || task.leaseToken) throw new AppError(409, "recharge_not_approvable", "仅可批准尚未派发的充值任务");
      const order = this.repository.findOrderInternal(task.orderId)!;
      const payment = this.repository.findPaymentAttemptByOrder(order.merchantId, order.id);
      if (!order.liveTest || !["paid", "partially_refunded"].includes(order.paymentStatus)
          || !payment || !["alipay_page", "dujiaopay", "agent_wallet"].includes(payment.provider) || payment.status !== "paid"
          || !this.livePolicy?.canFulfill(order)) throw new AppError(409, "live_payment_required", "必须是已真实付款的授权联调订单");
      const approved = {...task, liveSubmissionApproved: true};
      this.repository.updateFulfillment(approved);
      return approved;
    });
  }

  cancelQueued(merchantId: string, fulfillmentId: string, recoveryAction: "retry" | "refund" = "retry", reason = "平台取消未派发任务"): Fulfillment {
    return this.repository.transaction(() => {
      const task = this.repository.findFulfillment(merchantId, fulfillmentId);
      if (!task || task.status !== "queued" || task.leaseToken || task.upstreamOrderId || task.upstreamProvider || task.upstreamStatus
          || task.upstreamLookupToken || task.lookupPayload?.ciphertext) throw new AppError(409, "recharge_already_dispatched", "充值已开始派发，不能保证取消");
      return this.finish({...task, status: "cancelled", message: "平台已取消尚未派发的充值任务", failureCode: "cancelled", retryAllowed: true, recoveryAction, recoveryReason: reason,
        sessionPayload: this.cipher.clear(task.sessionPayload), finishedAt: new Date()});
    });
  }

  /** Called only by authenticated platform administration; never force-cancel a dispatched task. */
  prepareRecovery(merchantId: string, fulfillmentId: string, action: "retry" | "refund", reason = "平台处理充值异常"): Fulfillment {
    return this.repository.transaction(() => {
      const task = this.repository.findFulfillment(merchantId, fulfillmentId);
      if (!task) throw notFound("fulfillment");
      const order = this.repository.findOrder(merchantId, task.orderId);
      if (!order || !["paid", "partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor > 0n) {
        throw new AppError(409, "order_not_recoverable", "订单已退款或未确认付款，不能处理充值");
      }
      const attempts = this.repository.listFulfillments(merchantId, task.orderId);
      if (latestFulfillmentOf(attempts)?.id !== task.id || attempts.some(other => other.id !== task.id && ["queued", "running", "succeeded"].includes(other.status))) {
        throw new AppError(409, "recharge_attempt_changed", "订单已有更新或成功的尝试，请刷新后核对");
      }
      if (this.repository.listRefundsForOrder(merchantId, task.orderId).some(refund => ["requested", "approved", "processing"].includes(refund.status))) {
        throw new AppError(409, "refund_pending", "订单已进入退款流程，请核对原退款单");
      }
      if (task.status === "queued") return this.cancelQueued(merchantId, task.id, action, reason);
      if (!isConfirmedUnsuccessfulFulfillment(task)) {
        throw new AppError(409, "recharge_result_unconfirmed", "任务已派发或结果尚未确认；须先确认上游取消或明确失败，不能本地强制取消后退款或重提");
      }
      const voucher = task.voucherId ? this.repository.findCdkVoucherByOrder(order.id) : null;
      if (action === "retry" && task.voucherId && (!voucher || voucher.status !== "unused" || !voucher.upstreamCodePayload.ciphertext)) {
        throw new AppError(409, "voucher_unavailable", "原充值资源已停用或不可复用，请选择退款或联系支持");
      }
      this.repository.updateOrder({...order, fallbackRechargeAvailable: action === "retry" && order.deliveryMode === "auto_recharge" && !!voucher, updatedAt: new Date()});
      return this.saveProgress({...task, recoveryAction: action, recoveryReason: reason});
    });
  }

  /** A client may never cancel an in-flight upstream attempt. */
  cancelActiveForResubmit(merchantId: string, orderId: string): Fulfillment {
    if (!this.repository.findOrder(merchantId, orderId)) throw notFound("order");
    throw new AppError(403, "recharge_cancel_forbidden", "充值任务不能主动取消；仅在上游明确失败并结束后可重新提交原订单");
  }

  private createForOrder(order: Order, payload: QueuedPayload, voucherId: string | null = null): Fulfillment {
    return this.repository.transaction(() => this.insertForOrder(order, payload, voucherId));
  }

  private insertForOrder(order: Order, payload: QueuedPayload, voucherId: string | null): Fulfillment {
    order = this.repository.findOrderInternal(order.id) ?? order;
    if (order.archivedAt) throw new AppError(410, "order_archived", "该测试订单已归档，不能继续充值");
    if (order.paymentStatus !== "paid" && order.paymentStatus !== "partially_refunded") {
      throw new AppError(409, "order_not_paid", "只有已支付订单可以提交充值");
    }
    const refunds = this.repository.listRefundsForOrder(order.merchantId, order.id);
    if (order.ordinaryRefundedMinor > 0n) throw new AppError(409, "order_refunded", "已发生普通退款的订单不可提交充值");
    if (refunds.some((item) => ["requested", "approved", "processing"].includes(item.status))) {
      throw new AppError(409, "refund_pending", "订单已进入退款流程");
    }
    const previous = this.repository.listFulfillments(order.merchantId, order.id);
    if (previous.some((item) => ["queued", "running", "succeeded"].includes(item.status))) {
      throw new AppError(409, "fulfillment_already_exists", "订单已有进行中或成功的充值");
    }
    const latestAttempt = previous.at(-1);
    if (latestAttempt && !canResubmitFulfillment(latestAttempt)) {
      throw new AppError(409, "recharge_result_unconfirmed", "上次充值结果尚未明确，请等待核对，不要重复提交");
    }
    if (order.fallbackRechargeAvailable) {
      order = {...order, fallbackRechargeAvailable: false, updatedAt: new Date()};
      this.repository.updateOrder(order);
    }
    const id = `ful_${randomUUID().replaceAll("-", "")}`;
    const now = new Date();
    const fulfillment: Fulfillment = {
      id,
      merchantId: order.merchantId,
      orderId: order.id,
      attemptNo: previous.length + 1,
      status: "queued",
      failureCode: null,
      message: this.livePolicy?.requiresApproval(order) ? "已收到充值资料，等待平台确认后提交；尚未派发" : "充值任务已进入队列",
      accountEmailMasked: maskEmail(extractEmail(payload.credential)),
      sessionPayload: this.cipher.encrypt(payload, fulfillmentAad(order.merchantId, order.id, id)),
      mode: order.fulfillmentMode ?? "direct",
      voucherId,
      upstreamProvider: null,
      upstreamOrderId: null,
      upstreamClientRequestId: id,
      upstreamLookupToken: null,
      upstreamStatus: null,
      upstreamStage: null,
      upstreamQuoteMinor: null,
      upstreamCurrency: null,
      nextCheckAt: now,
      createdAt: now,
      finishedAt: null,
    };
    return this.saveProgress(fulfillment, true);
  }

  private async submit(current: Fulfillment): Promise<Fulfillment> {
    const order = this.repository.findOrder(current.merchantId, current.orderId);
    if (!order) return this.fail(current, "other", "订单不存在");
    const aad = fulfillmentAad(current.merchantId, current.orderId, current.id);
    const onSubmitting = (lookupToken: string | null) => this.repository.transaction(() => {
      const latest = this.repository.findFulfillment(current.merchantId, current.id)!;
      if (isTerminal(latest.status) || latest.leaseToken !== current.leaseToken) throw new Error("submission_superseded");
      if (this.repository.findOrderInternal(current.orderId)?.paymentStatus === "refunded") throw new Error("refunded_submission_blocked");
      this.saveProgress({
        ...latest, status: "running", upstreamProvider: this.upstream.name, upstreamStatus: "submission_pending",
        message: "正在提交充值，请勿重复提交",
        upstreamLookupToken: null,
        ...(lookupToken ? {lookupPayload: this.cipher.encrypt({token: lookupToken}, `${aad}:lookup`)} : {}),
        sessionPayload: this.cipher.clear(latest.sessionPayload),
      });
    });
    try {
      const payload = this.cipher.decrypt(current.sessionPayload, aad) as QueuedPayload;
      const state = (current.mode ?? "direct") === "cdk"
        ? await this.upstream.submitCdk({
            upstreamCode: requireCdkCode(payload),
            credential: payload.credential,
            clientRequestId: current.upstreamClientRequestId,
            deviceId: deviceId(current.id),
            onSubmitting,
          })
        : await this.upstream.submitDirect({
            product: order.upstreamProduct ?? "gpt",
            plan: order.upstreamPlan ?? "plus",
            credential: payload.credential,
            clientRequestId: current.upstreamClientRequestId,
            onSubmitting,
          });
      const submitted: Fulfillment = {
        ...current,
        status: "running",
        upstreamProvider: this.upstream.name,
        upstreamOrderId: state.orderId,
        upstreamLookupToken: state.lookupToken,
        sessionPayload: this.cipher.clear(current.sessionPayload),
      };
      return this.applyState(submitted, state);
    } catch (error) {
      return this.handleError(current, error);
    }
  }

  private async poll(current: Fulfillment): Promise<Fulfillment> {
    try {
      if (current.upstreamProvider && current.upstreamProvider !== this.upstream.name) throw new UpstreamRequestError("upstream_configuration_error", true);
      const lookup = current.lookupPayload?.ciphertext
        ? this.cipher.decrypt(current.lookupPayload, `${fulfillmentAad(current.merchantId, current.orderId, current.id)}:lookup`) as {token: string}
        : null;
      const state = await this.upstream.query({
        mode: current.mode ?? "direct",
        orderId: current.upstreamOrderId ?? "",
        lookupToken: lookup?.token ?? current.upstreamLookupToken,
        deviceId: deviceId(current.id),
        clientRequestId: current.upstreamClientRequestId,
      });
      return this.applyState(current, state);
    } catch (error) {
      return this.handleError(current, error, true);
    }
  }

  private applyState(current: Fulfillment, state: UpstreamOrderState, enforceLease = true): Fulfillment {
    return this.repository.transaction(() => {
      const latest = this.repository.findFulfillment(current.merchantId, current.id)!;
      if (isTerminal(latest.status) || (enforceLease && latest.leaseToken !== current.leaseToken)) return latest;
      return this.applyCurrentState(latest, state);
    });
  }

  private applyCurrentState(current: Fulfillment, state: UpstreamOrderState): Fulfillment {
    const resultCode = state.status.trim().toLowerCase();
    const resultStage = state.stage?.trim().toLowerCase() ?? null;
    const active: Fulfillment = current.status === "queued" ? {...current, status: "running"} : current;
    const common: Fulfillment = {
      ...active,
      upstreamProvider: active.upstreamProvider ?? this.upstream.name,
      upstreamOrderId: state.orderId || active.upstreamOrderId,
      upstreamLookupToken: null,
      ...(state.lookupToken ? {lookupPayload: this.cipher.encrypt({token: state.lookupToken}, `${fulfillmentAad(current.merchantId, current.orderId, current.id)}:lookup`)} : {}),
      sessionPayload: this.cipher.clear(active.sessionPayload),
      leaseToken: null,
      leaseUntil: null,
      upstreamStatus: resultCode,
      upstreamStage: resultStage,
      upstreamQuoteMinor: state.quotedAmountMinor,
      upstreamChargedMinor: state.chargedAmountMinor ?? active.upstreamChargedMinor ?? null,
      upstreamCardLastFour: state.cardLastFour ?? active.upstreamCardLastFour ?? null,
      upstreamCurrency: state.currency,
      accountEmailMasked: maskEmail(state.accountEmail) ?? active.accountEmailMasked,
    };
    if (resultCode === "completed") {
      assertFulfillmentTransition(active.status, "succeeded");
      return this.finish({...common, status: "succeeded", failureCode: null, message: safeResultMessage(state.message, "充值成功"), sessionPayload: this.cipher.clear(common.sessionPayload), finishedAt: new Date()});
    }
    if (resultCode === "declined") {
      return this.fail({...common, retryAllowed: true}, "payment_declined", safeResultMessage(state.message, "支付被拒，充值未成功"));
    }
    if (resultCode === "failed_precharge") {
      return this.fail({...common, retryAllowed: true}, "precharge_failed", safeResultMessage(state.message, "扣款前校验失败，充值未成功"));
    }
    if (resultCode === "cancelled") {
      assertFulfillmentTransition(active.status, "cancelled");
      return this.finish({...common, status: "cancelled", retryAllowed: true, failureCode: "cancelled", message: safeResultMessage(state.message, "充值已取消"), sessionPayload: this.cipher.clear(common.sessionPayload), finishedAt: new Date()});
    }
    const running: Fulfillment = {
      ...common,
      status: "running",
      failureCode: null,
      message: safeResultMessage(state.message, runningMessage(resultCode)),
      nextCheckAt: new Date(Date.now() + 5_000),
    };
    return this.saveProgress(running);
  }

  private handleError(current: Fulfillment, error: unknown, polling = false): Fulfillment {
    return this.repository.transaction(() => {
      const latest = this.repository.findFulfillment(current.merchantId, current.id)!;
      if (isTerminal(latest.status) || latest.leaseToken !== current.leaseToken) return latest;
      return this.handleCurrentError(latest, error, polling);
    });
  }

  private handleCurrentError(current: Fulfillment, error: unknown, polling: boolean): Fulfillment {
    const explicitRejection = error instanceof UpstreamRequestError && !error.retryable
      && ["session_invalid", "mailbox_login_failed", "account_has_subscription", "precheck_rejected", "subscription_required", "account_unavailable", "order_rejected", "product_unavailable", "upstream_product_unavailable"].includes(error.failureCode);
    if (polling || !explicitRejection) {
      const retrying: Fulfillment = {
        ...current,
        message: current.status === "running" ? "充值结果确认中，请勿重复提交" : "充值服务暂时繁忙，系统将自动重试",
        leaseToken: null,
        leaseUntil: null,
        nextCheckAt: new Date(Date.now() + 15_000),
      };
      return this.saveProgress(retrying);
    }
    const code = error instanceof UpstreamRequestError ? publicFailureCode(error) : "other";
    const message = publicFailureMessage(code, error instanceof UpstreamRequestError ? error.message : null);
    return this.fail({...current, retryAllowed: true}, code, message);
  }

  private fail(current: Fulfillment, failureCode: string, message: string): Fulfillment {
    if (current.status === "queued") assertFulfillmentTransition("queued", "running");
    const from = current.status === "queued" ? "running" : current.status;
    assertFulfillmentTransition(from, "failed");
    return this.finish({
      ...current,
      status: "failed",
      failureCode,
      message,
      sessionPayload: this.cipher.clear(current.sessionPayload),
      finishedAt: new Date(),
    });
  }

  private finish(terminal: Fulfillment): Fulfillment {
    return this.repository.transaction(() => this.finishLocked(terminal));
  }

  private finishLocked(terminal: Fulfillment): Fulfillment {
    terminal = {...terminal, leaseToken: null, leaseUntil: null,
      ...(terminal.lookupPayload ? {lookupPayload: this.cipher.clear(terminal.lookupPayload)} : {})};
    terminal = this.saveProgress(terminal);
    let fallbackRechargeAvailable = false;
    if (terminal.voucherId) {
      const voucher = this.repository.findCdkVoucherByOrder(terminal.orderId);
      if (voucher?.id === terminal.voucherId) {
        if (terminal.status === "succeeded") {
          this.repository.updateCdkVoucher({...voucher, status: "consumed", consumedAt: new Date(), upstreamCodePayload: this.cipher.clear(voucher.upstreamCodePayload)});
          const order = this.repository.findOrderInternal(terminal.orderId);
          if (order?.fallbackRechargeAvailable) {
            this.repository.updateOrder({...order, fallbackRechargeAvailable: false, updatedAt: new Date()});
          }
        } else if (voucher.status !== "consumed" && isConfirmedUnsuccessfulFulfillment(terminal)) {
          const order = this.repository.findOrderInternal(terminal.orderId);
          // Do not make a refunded order's resource redeemable again. The CDK cleanup
          // lane confirms upstream disable before clearing its encrypted code.
          if (order?.paymentStatus === "refunded") {
            if (["unused", "reserved"].includes(voucher.status)) this.repository.updateCdkVoucher({...voucher, status: "disabling", nextAttemptAt: new Date()});
          } else if (!["disabled", "disabling", "failed"].includes(voucher.status)) {
            this.repository.updateCdkVoucher({...voucher, status: "unused"});
          }
          if (order && ["paid", "partially_refunded"].includes(order.paymentStatus) && canResubmitFulfillment(terminal) && (order.deliveryMode ?? "cdk") === "auto_recharge" && order.voucherCode) {
            fallbackRechargeAvailable = true;
            this.repository.updateOrder({...order, fallbackRechargeAvailable: true, updatedAt: new Date()});
          }
        }
      }
    }
    if (terminal.status === "succeeded") this.onFinancialChange?.(terminal.orderId);
    this.webhooks.emit(
      terminal.merchantId,
      `${terminal.id}:fulfillment.${terminal.status}`,
      `fulfillment.${terminal.status}`,
      terminal.id,
      {event: `fulfillment.${terminal.status}`, order_id: terminal.orderId, fulfillment_id: terminal.id, redemption_id: terminal.id,
        ...(fallbackRechargeAvailable ? {fallback_recharge_available: true} : {}),
        sync_mark: orderSyncMark(
          this.repository.findOrderInternal(terminal.orderId)?.paymentStatus ?? "paid",
          terminal,
        ),
        ...partnerFulfillmentSnapshot(terminal, this.repository.getOperations("agent_profile", terminal.merchantId)?.orderVisibility, this.canResubmit(terminal))},
    );
    return terminal;
  }

  /** Persist progress and its outbox event in the same transaction, not on every polling tick. */
  private saveProgress(value: Fulfillment, insert = false): Fulfillment {
    return this.repository.transaction(() => {
      const previous = insert ? null : this.repository.findFulfillment(value.merchantId, value.id);
      const changed = !previous || progressSignature(previous) !== progressSignature(value);
      const saved: Fulfillment = {
        ...value,
        progressVersion: (previous?.progressVersion ?? 0) + (changed ? 1 : 0),
        progressUpdatedAt: changed ? new Date() : previous?.progressUpdatedAt ?? previous?.createdAt ?? value.createdAt,
      };
      if (insert) this.repository.insertFulfillment(saved);
      else this.repository.updateFulfillment(saved);
      if (changed && (!isTerminal(saved.status) || (previous && isTerminal(previous.status) && previous.recoveryAction !== saved.recoveryAction))) {
        this.webhooks.emit(saved.merchantId, `${saved.id}:fulfillment.updated:${saved.progressVersion}`,
          "fulfillment.updated", saved.id, {
            event: "fulfillment.updated", order_id: saved.orderId, fulfillment_id: saved.id, redemption_id: saved.id,
            ...partnerFulfillmentSnapshot(saved, this.repository.getOperations("agent_profile", saved.merchantId)?.orderVisibility, this.canResubmit(saved)),
          });
      }
      return saved;
    });
  }
}

function progressSignature(value: Fulfillment): string {
  return JSON.stringify([value.status, partnerProgressStage(value), value.upstreamStatus ?? null,
    value.failureCode, partnerFulfillmentMessage(value), canResubmitFulfillment(value), value.recoveryAction ?? null]);
}

function normalizeCredential(input: Record<string, unknown>): RechargeCredential {
  const nested = input.credential;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return normalizeCredential(nested as Record<string, unknown>);
  if (input.mode === "mailbox" && typeof input.email === "string" && typeof input.password === "string") {
    return {mode: "mailbox", email: input.email, password: input.password};
  }
  if ((input.mode === "access_token" || typeof input.accessToken === "string") && typeof input.accessToken === "string") {
    return {mode: "access_token", accessToken: input.accessToken};
  }
  if (typeof input.session === "string") return {mode: "session", session: input.session};
  if (typeof input.sessionToken === "string") return {mode: "session", session: input.sessionToken};
  return {mode: "session", session: JSON.stringify(input)};
}

function requireCdkCode(payload: QueuedPayload): string {
  if (!payload.upstreamCdkCode) throw new UpstreamRequestError("voucher_unavailable", false, "兑换码不可用");
  return payload.upstreamCdkCode;
}

function fulfillmentAad(merchantId: string, orderId: string, fulfillmentId: string): string {
  return `${merchantId}:${orderId}:${fulfillmentId}`;
}

function deviceId(fulfillmentId: string): string {
  return `quefa-${createHash("sha256").update(fulfillmentId).digest("hex").slice(0, 32)}`;
}

function extractEmail(credential: RechargeCredential): string {
  return credential.mode === "mailbox" ? credential.email : "";
}

function maskEmail(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local[0] ?? "*"}***${local.length > 1 ? local.at(-1) : ""}@${domain}`;
}

function isTerminal(status: Fulfillment["status"]): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function publicFailureCode(error: UpstreamRequestError): string {
  if (["session_invalid", "mailbox_login_failed", "account_has_subscription", "precheck_rejected", "subscription_required", "account_unavailable",
    "product_unavailable", "order_rejected", "payment_blocked", "verification_timeout"].includes(error.failureCode)) {
    return error.failureCode;
  }
  if (error.failureCode === "upstream_product_unavailable") return "product_unavailable";
  return error.retryable ? "service_unavailable" : "other";
}

function publicFailureMessage(code: string, detail: string | null = null): string {
  const fallback = code === "session_invalid" ? "账号凭据无效，请重新提交"
    : code === "mailbox_login_failed" ? "邮箱登录失败，请检查邮箱和密码，或改用 Session / Access Token 后重新提交"
    : code === "account_has_subscription" ? "账号已有有效订阅"
      : code === "precheck_rejected" ? "账号预检未通过"
        : code === "subscription_required" ? "当前账号不支持订购此套餐：需已有有效订阅"
          : code === "account_unavailable" ? "当前账号不可用于本次充值"
            : code === "product_unavailable" ? "当前套餐暂不支持订购"
              : code === "order_rejected" ? "充值请求未通过业务校验"
                : code === "payment_blocked" ? "充值未成功，请联系 Quefa 客服"
                  : code === "verification_timeout" ? "账号验证超时，请稍后重试"
                    : code === "service_unavailable" ? "充值服务暂时繁忙，系统将自动重试"
                      : "充值未成功，请联系 Quefa 客服";
  return code === "mailbox_login_failed" ? fallback : safeResultMessage(detail, fallback);
}

function runningMessage(code: string): string {
  if (code === "review") return "充值结果待人工对账，请勿重复提交";
  if (code === "pending") return "充值结果确认中，请勿重复提交";
  if (code === "requires_action") return "充值需要进一步确认，系统正在处理";
  if (code === "plus_paid") return "基础套餐已支付，升级处理中";
  if (code === "awaiting_card") return "正在分配充值资源";
  if (code === "funding_pending") return "充值资金准备中";
  if (code === "dispatching") return "充值正在派发";
  return "充值处理中";
}
