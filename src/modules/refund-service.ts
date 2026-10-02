import { randomUUID } from "node:crypto";
import type { Order, Refund, RefundType, TenantContext } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError, notFound } from "../domain/errors.js";
import { moneyToMinor, minorToMoney } from "../domain/money.js";
import { assertPaymentTransition, assertRefundTransition } from "../domain/state-machines.js";
import { latestFulfillmentOf, orderSyncMark } from "../domain/order-sync-mark.js";
import {isConfirmedUnsuccessfulFulfillment} from "../domain/recharge-policy.js";
import { LedgerService } from "./ledger-service.js";
import { WebhookService } from "./webhook-service.js";
import type { Actor } from "../operations/model.js";
import { isPlatform, requirePermission } from "../operations/accounts.js";
import {queryRecords} from "../infra/record-query.js";
import {hasUnreconciledProviderRefund} from "../domain/provider-refund-review.js";

export type RefundExecutor = {
  providerFor(orderId: string): string | null;
  execute(orderId: string, refund: Refund): Promise<string>;
  query?(orderId: string, refund: Refund): Promise<{status: "succeeded"; providerRefundNo: string} | {status: "not_confirmed"; bindingVerified?: boolean}>;
};

export type ProviderRefundObserver = {
  discrepancy(input:{merchantId:string;orderId:string;reportedMinor:bigint;recordedMinor:bigint;providerReference:string;capturedRecordedMinor?:bigint}):void;
  recorded(input:{merchantId:string;orderId:string;recordedMinor:bigint;reconciliationCreditMinor?:bigint}):void;
};

export class RefundService {
  constructor(
    private readonly repository: Repository,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookService,
    private readonly executor?: RefundExecutor,
    private readonly onFinancialChange?: (orderId: string) => void,
    private readonly providerRefundObserver?: ProviderRefundObserver,
  ) {}

  request(tenant: TenantContext, orderId: string, input: {merchantRefundNo: string; type: RefundType; amount: string; reason: string}): Refund {
    return this.repository.transaction(() => this.requestLocked(tenant, orderId, input));
  }

  private requestLocked(
    tenant: TenantContext,
    orderId: string,
    input: {merchantRefundNo: string; type: RefundType; amount: string; reason: string},
    opts: {recordingChannelFact?: boolean} = {},
  ): Refund {
    const existing = this.repository.findRefundByMerchantNo(tenant.merchantId, input.merchantRefundNo);
    if (existing) {
      const same = existing.orderId === orderId && existing.type === input.type && existing.amountMinor === moneyToMinor(input.amount);
      if (!same) throw new AppError(409, "refund_idempotency_conflict", "退款号已用于不同请求");
      return existing;
    }
    const order = this.repository.findOrder(tenant.merchantId, orderId);
    if (!order) throw notFound("order");
    // Only the private, evidence-backed bookkeeping path may cross this lock.
    // Creating or retrying an outbound refund must not spend unresolved money again.
    if (!opts.recordingChannelFact) this.assertProviderRefundReconciled(order);
    if (input.type === "price_adjustment" && this.repository.getOperations("order_cost", orderId)?.status === "confirmed") {
      throw new AppError(409, "cost_adjustment_path_exists", "已有独立成本补差记录，禁止再走旧差价退款路径重复支付");
    }
    if ((this.repository.getOperations("order_cost", orderId)?.paidUsdMinor ?? 0n) > 0n) {
      throw new AppError(409, "cost_payment_conflict", "本单已有真实补差付款，请先核对补差凭证，禁止重复发起客户退款");
    }
    if (order.collectionMode === "agent_collect") throw new AppError(409, "procurement_refund_required", "自收款订单请申请采购退款；客户退款由代理商自己的支付渠道处理");
    if (input.type !== "price_adjustment" && !opts.recordingChannelFact) {
      const voucher = this.repository.findCdkVoucherByOrder(orderId);
      const fulfillments = this.repository.listFulfillments(tenant.merchantId, orderId);
      const activeOrSucceeded = fulfillments.some((item) => ["queued", "running", "succeeded"].includes(item.status));
      if (activeOrSucceeded) {
        throw new AppError(409, "fulfillment_blocks_refund", "充值处理中或已成功，不能执行普通退款");
      }
      const terminalFailOrCancel = fulfillments.some(isConfirmedUnsuccessfulFulfillment);
      if (voucher && !["failed", "disabled", "consumed"].includes(voucher.status)) {
        // Only confirmed upstream failure releases a voucher for retry or refund.
        // Choosing refund instead: disable the code so money can be returned and commission clawed.
        if (!terminalFailOrCancel) {
          throw new AppError(409, "fulfillment_blocks_refund", "兑换码仍有效，不能执行普通退款");
        }
        this.repository.updateCdkVoucher({
          ...voucher,
          status: "disabled",
          failureCode: voucher.failureCode ?? "refund_requested",
        });
      }
    }
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) {
      throw new AppError(409, "order_not_refundable", "当前支付状态不可退款");
    }
    const amountMinor = moneyToMinor(input.amount);
    if (amountMinor <= 0n) throw new AppError(422, "invalid_refund_amount", "退款金额必须大于 0");
    const reserved = this.repository.listRefundsForOrder(tenant.merchantId, orderId)
      .filter((item) => !["rejected", "cancelled"].includes(item.status))
      .reduce((sum, item) => sum + item.amountMinor, 0n);
    if (amountMinor + reserved > order.saleAmountMinor) {
      throw new AppError(422, "refund_amount_exceeded", "累计退款金额超过可退金额");
    }
    if (input.type === "price_adjustment" && amountMinor + reserved >= order.saleAmountMinor) {
      throw new AppError(409, "use_customer_refund", "全额退款不能使用差价退款；请先安全处理充值任务，再选择客户退款");
    }
    const refund: Refund = {
      id: `rf_${randomUUID().replaceAll("-", "")}`,
      merchantId: tenant.merchantId,
      orderId,
      merchantRefundNo: input.merchantRefundNo,
      type: input.type,
      amountMinor,
      status: "requested",
      reason: input.reason,
      failureCode: null,
      providerRefundNo: null,
      createdAt: new Date(),
      refundedAt: null,
    };
    this.repository.insertRefund(refund);
    return refund;
  }

  get(merchantId: string, refundId: string): Refund {
    const refund = this.repository.findRefund(merchantId, refundId);
    if (!refund) throw notFound("refund");
    return refund;
  }

  completeForSandbox(merchantId: string, refundId: string): Refund {
    const refund = this.get(merchantId, refundId);
    if (this.repository.findPaymentAttemptByOrder(merchantId, refund.orderId)?.provider !== "mock") {
      throw new AppError(409, "real_refund_required", "真实支付不能通过模拟接口标记退款成功");
    }
    return this.repository.transaction(() => this.completeLocked(merchantId, refundId));
  }

  requestPriceAdjustment(actor: Actor, orderId: string, input: {amount: string; reason: string; requestKey: string}): Refund {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可登记补充退款");
    const order = this.repository.findOrderInternal(orderId);
    if (!order || order.collectionMode !== "platform_collect") throw new AppError(404, "refund_order_not_found", "仅平台代收订单可登记补充退款");
    const replay = this.repository.findRefundByMerchantNo(order.merchantId, "ws:padj:" + input.requestKey);
    if (replay) {
      if (replay.orderId !== orderId || replay.type !== "price_adjustment" || replay.amountMinor !== moneyToMinor(input.amount)) throw new AppError(409, "refund_idempotency_conflict", "退款号已用于不同请求");
      return replay;
    }
    const pending = this.repository.listRefundsForOrder(order.merchantId, order.id);
    const available = availableCustomerRefundMinor(order, pending);
    const amountMinor = moneyToMinor(input.amount);
    if (amountMinor <= 0n) throw new AppError(422, "invalid_refund_amount", "退款金额必须大于 0");
    if (amountMinor > available) throw new AppError(422, "price_adjustment_exceeds_refundable", "补充退款不能超过该订单剩余可退金额");
    const merchant = this.repository.findMerchantById(order.merchantId);
    if (!merchant) throw notFound("merchant");
    const tenant: TenantContext = {merchantId: order.merchantId, partnerId: merchant.partnerId, appId: "workspace", keyId: actor.id};
    return this.request(tenant, orderId, {merchantRefundNo: "ws:padj:" + input.requestKey, type: "price_adjustment", amount: input.amount, reason: input.reason.trim()});
  }

  /** Platform finance: full/partial customer refund for platform_collect (failed fulfillment / unused CDK). */
  requestCustomerRefund(actor: Actor, orderId: string, input: {amount?: string; reason: string; requestKey: string}): Refund {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可发起客户退款");
    const order = this.repository.findOrderInternal(orderId);
    if (!order || order.collectionMode !== "platform_collect") throw new AppError(404, "refund_order_not_found", "仅平台代收订单可退客户款");
    const replay = this.repository.findRefundByMerchantNo(order.merchantId, "ws:refund:" + input.requestKey);
    if (replay) {
      if (replay.orderId !== orderId || (input.amount && replay.amountMinor !== moneyToMinor(input.amount))) throw new AppError(409, "refund_idempotency_conflict", "退款号已用于不同请求");
      return replay;
    }
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) throw new AppError(409, "order_not_refundable", "当前支付状态不可退款");
    const reserved = this.repository.listRefundsForOrder(order.merchantId, order.id)
      .filter(item => !["rejected", "cancelled"].includes(item.status))
      .reduce((sum, item) => sum + item.amountMinor, 0n);
    const remaining = order.saleAmountMinor - reserved;
    if (remaining <= 0n) throw new AppError(409, "refund_amount_exceeded", "该订单已无可退金额");
    const amountMinor = input.amount ? moneyToMinor(input.amount) : remaining;
    if (amountMinor <= 0n || amountMinor > remaining) throw new AppError(422, "invalid_refund_amount", "退款金额无效");
    const type: RefundType = amountMinor >= remaining && reserved === 0n ? "full" : "partial";
    const merchant = this.repository.findMerchantById(order.merchantId);
    if (!merchant) throw notFound("merchant");
    const tenant: TenantContext = {merchantId: order.merchantId, partnerId: merchant.partnerId, appId: "workspace", keyId: actor.id};
    return this.request(tenant, orderId, {
      merchantRefundNo: "ws:refund:" + input.requestKey,
      type,
      amount: minorToMoney(amountMinor),
      reason: input.reason.trim() || "充值失败退款",
    });
  }

  listPendingPriceAdjustments(actor: Actor): Refund[] {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权查看退款队列");
    if(this.repository.listPendingRefunds)return this.repository.listPendingRefunds("price_adjustment");
    return this.repository.listOrdersInternal()
      .flatMap(order => this.repository.listRefundsForOrder(order.merchantId, order.id))
      .filter(refund => refund.type === "price_adjustment" && ["requested", "processing", "failed"].includes(refund.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Partner/API ordinary refunds awaiting platform Alipay approval. */
  listPendingCustomerRefunds(actor: Actor): Refund[] {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权查看退款队列");
    if(this.repository.listPendingRefunds)return this.repository.listPendingRefunds("customer");
    return this.repository.listOrdersInternal()
      .flatMap(order => this.repository.listRefundsForOrder(order.merchantId, order.id))
      .filter(refund => refund.type !== "price_adjustment" && ["requested", "processing", "failed"].includes(refund.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  pendingCategoryPage(actor: Actor, category: "customer" | "price_adjustment", page = 1, limit = 20) {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权查看退款队列");
    const filters = [
      {field: "status", op: "in" as const, value: ["requested", "processing", "failed"]},
      category === "price_adjustment"
        ? {field: "type", op: "eq" as const, value: "price_adjustment"}
        : {field: "type", op: "in" as const, value: ["full", "partial"]},
    ];
    return queryRecords(this.repository, "refund", {filters, page, limit, orderBy: "createdAt", direction: "desc"});
  }

  pendingPage(actor: Actor, limit = 8) {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权查看退款队列");
    const statuses = ["requested", "processing", "failed"], summary = queryRecords(this.repository, "refund", {
      filters: [{field: "status", op: "in", value: statuses}], page: 1, limit: 1, orderBy: "createdAt", direction: "asc"});
    const failed = queryRecords(this.repository, "refund", {filters: [{field: "status", value: "failed"}], page: 1, limit,
      orderBy: "createdAt", direction: "asc"}).data;
    const remaining = Math.max(0, limit - failed.length), ordinary = remaining ? queryRecords(this.repository, "refund", {
      filters: [{field: "status", op: "in", value: ["requested", "processing"]}], page: 1, limit: remaining,
      orderBy: "createdAt", direction: "asc"}).data : [];
    return {data: [...failed, ...ordinary], meta: {...summary.meta, limit, pages: Math.max(1, Math.ceil(summary.meta.total / limit))}};
  }

  /**
   * Bookkeeping when the channel already refunded the buyer outside Quefa
   * (e.g. Alipay console). Does not call Alipay again; disables unused CDK and
   * updates ordinary refund totals so released earnings can be clawed back.
   */
  recordExternalCustomerRefund(actor: Actor, orderId: string, input: {
    amount?: string;
    reason: string;
    requestKey: string;
    providerRefundNo: string;
    confirmAlreadyRefundedAtChannel: true;
  }): Refund {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可登记渠道已退款");
    if (!input.confirmAlreadyRefundedAtChannel) throw new AppError(422, "confirm_required", "须确认渠道侧已完成退款");
    const providerRefundNo = input.providerRefundNo.trim();
    if (providerRefundNo.length < 6) throw new AppError(422, "invalid_provider_refund_no", "请填写支付宝退款流水号或渠道退款单号");
    const reason = input.reason.trim() || "渠道已退款，系统补登";
    return this.repository.transaction(() => {
      const order = this.repository.findOrderInternal(orderId);
      if (!order || order.collectionMode !== "platform_collect") throw new AppError(404, "refund_order_not_found", "仅平台代收订单可登记渠道退款");
      const merchantRefundNo = "ws:ext-refund:" + input.requestKey;
      const replay = this.repository.findRefundByMerchantNo(order.merchantId, merchantRefundNo);
      if (replay) {
        if (replay.orderId !== orderId || replay.reason !== reason || replay.providerRefundNo !== providerRefundNo
            || (input.amount && replay.amountMinor !== moneyToMinor(input.amount))) {
          throw new AppError(409, "refund_idempotency_conflict", "退款号已用于不同请求");
        }
        return replay;
      }
      const refunds = this.repository.listRefundsForOrder(order.merchantId, order.id);
      if (refunds.some(item => item.providerRefundNo === providerRefundNo && item.status === "succeeded")) {
        throw new AppError(409, "provider_refund_reference_used", "退款流水号已登记，请核对原退款记录");
      }
      if (!["paid", "partially_refunded"].includes(order.paymentStatus)) throw new AppError(409, "order_not_refundable", "当前支付状态不可退款");
      const reserved = refunds
        .filter(item => !["rejected", "cancelled"].includes(item.status))
        .reduce((sum, item) => sum + item.amountMinor, 0n);
      const remaining = order.saleAmountMinor - reserved;
      if (remaining <= 0n) throw new AppError(409, "refund_amount_exceeded", "该订单已无可退金额");
      const amountMinor = input.amount ? moneyToMinor(input.amount) : remaining;
      if (amountMinor <= 0n || amountMinor > remaining) throw new AppError(422, "invalid_refund_amount", "退款金额无效");
      const type: RefundType = amountMinor >= remaining && reserved === 0n ? "full" : "partial";
      const merchant = this.repository.findMerchantById(order.merchantId);
      if (!merchant) throw notFound("merchant");
      const tenant: TenantContext = {merchantId: order.merchantId, partnerId: merchant.partnerId, appId: "workspace", keyId: actor.id};
      const pending = this.requestLocked(tenant, orderId, {
        merchantRefundNo,
        type,
        amount: minorToMoney(amountMinor),
        reason,
      }, {recordingChannelFact: true});
      const voucher = this.repository.findCdkVoucherByOrder(orderId);
      if (voucher && !["failed", "disabled", "consumed"].includes(voucher.status)) {
        this.repository.updateCdkVoucher({...voucher, status: "disabled", failureCode: voucher.failureCode ?? "external_refund"});
      }
      return this.completeLocked(order.merchantId, pending.id, providerRefundNo, false, true);
    });
  }

  /**
   * Reconcile provider facts under one write transaction. An aggregate trade
   * query never completes a refund because it has no exact out_request_no.
   * Exact completion happens only through reconcileOne/queryRefund; aggregate
   * deltas become review cases and leave the financial ledger unchanged.
   */
  syncProviderRefund(orderId: string, providerRefundedMinor: bigint, providerReference: string, capturedRecordedMinor?: bigint): Refund | null {
    if (providerRefundedMinor <= 0n) return null;
    return this.repository.transaction(() => {
      const order = this.repository.findOrderInternal(orderId);
      if (!order || order.collectionMode !== "platform_collect") return null;
      const reported = providerRefundedMinor > order.saleAmountMinor ? order.saleAmountMinor : providerRefundedMinor;
      const recorded = order.ordinaryRefundedMinor + order.priceAdjustmentRefundedMinor;
      this.providerRefundObserver?.discrepancy({merchantId:order.merchantId,orderId:order.id,
        reportedMinor:reported,recordedMinor:recorded,providerReference,
        ...(capturedRecordedMinor === undefined ? {} : {capturedRecordedMinor})});
      this.scheduleReconciliationRefresh(order);
      return null;
    });
  }

  /** Manual confirmation after off-platform payout (USDT / exceptional cases). */
  completeReviewed(actor: Actor, refundId: string, payoutReference: string): Refund {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可确认补充退款");
    const reference = payoutReference.trim().toLowerCase();
    if (reference.length < 6) throw new AppError(422, "invalid_payout_reference", "请填写已向客户实际打款的唯一流水号");
    const refund = this.findRefundById(refundId);
    if (!refund) throw notFound("refund");
    if (refund.type !== "price_adjustment") throw new AppError(409, "refund_type_invalid", "仅可确认补充退款");
    if (!["requested", "failed"].includes(refund.status)) throw new AppError(409, "refund_changed", "退款单已处理，请刷新");
    const provider = this.paymentProvider(refund.orderId);
    if (provider === "alipay_page") throw new AppError(409, "use_alipay_auto_refund", "支付宝订单请使用审核退款，由系统原路退回");
    return this.repository.transaction(() => this.completeLocked(refund.merchantId, refundId, "manual:" + reference));
  }

  /**
   * Finance clicks approve → look up the paid order by Quefa order id →
   * call Alipay trade.refund (out_trade_no = order.id) → reverse margin.
   */
  async approve(actor: Actor, refundId: string): Promise<Refund> {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可审核退款");
    const refund = this.findRefundById(refundId);
    if (!refund) throw notFound("refund");
    if (refund.status === "succeeded" || refund.status === "processing") return refund;
    if (!["requested", "failed"].includes(refund.status)) throw new AppError(409, "refund_changed", "退款单已处理，请刷新");
    const order = this.repository.findOrder(refund.merchantId, refund.orderId);
    if (!order || order.collectionMode !== "platform_collect") throw new AppError(409, "refund_order_not_found", "仅平台代收订单可自动退款");
    if (refund.type === "price_adjustment" && order.ordinaryRefundedMinor + order.priceAdjustmentRefundedMinor + refund.amountMinor >= order.saleAmountMinor) {
      throw new AppError(409, "use_customer_refund", "全额退款不能使用差价退款；请先安全处理充值任务，再选择客户退款");
    }
    const provider = this.paymentProvider(refund.orderId);
    if (provider !== "alipay_page" && provider !== "mock") throw new AppError(409, "auto_refund_unsupported", "该渠道不支持自动退款");
    if (provider === "alipay_page" && !this.executor) throw new AppError(503, "alipay_unavailable", "支付宝退款通道未配置");

    const processing = this.repository.transaction(() => {
      const current = this.get(refund.merchantId, refundId);
      if (!["requested", "failed"].includes(current.status)) throw new AppError(409, "refund_changed", "退款单已处理，请刷新");
      if (current.leaseToken && (!current.leaseUntil || current.leaseUntil > new Date()))
        throw new AppError(409, "refund_review_in_progress", "退款正在核对或执行，请稍后刷新");
      this.assertRefundExecutable(current, provider);
      if (current.status === "requested") assertRefundTransition("requested", "approved");
      else assertRefundTransition("failed", "approved");
      assertRefundTransition("approved", "processing");
      const next = {...current, status: "processing" as const, failureCode: null,
        nextCheckAt: new Date(Date.now() + 60_000), recoveryAttempts: 0,
        leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000), lastSubmittedAt: new Date().toISOString()};
      this.repository.updateRefund(next);
      return next;
    });

    let providerRefundNo: string | null = null;
    try {
      if (provider === "alipay_page") {
        if (!this.executor) throw new AppError(503, "alipay_unavailable", "支付宝退款通道未配置");
        providerRefundNo = await this.executor.execute(refund.orderId, processing);
      } else if (provider === "mock") {
        providerRefundNo = "mock:" + refund.id;
      } else {
        throw new AppError(409, "auto_refund_unsupported", "该支付方式不支持自动退款，请人工打款后使用确认入账");
      }
    } catch (error) {
      this.deferOwnedRefund(processing, "refund_result_unknown", 60_000);
      return this.get(refund.merchantId, refundId);
    }

    return this.repository.transaction(() => this.completeLocked(refund.merchantId, refundId, providerRefundNo, true));
  }

  /** Query uncertain refunds first; recovery always reuses the original refund ID and amount. */
  async reconcileOne(): Promise<void> {
    if (!this.executor?.query) return;
    const refund = this.repository.transaction(() => {
      const now=new Date(),candidate=this.repository.findDueRefund?this.repository.findDueRefund("alipay_page",now):this.repository.listOrdersInternal()
        .flatMap(order => this.repository.listRefundsForOrder(order.merchantId, order.id))
        .find(item => item.status === "processing" && (!item.nextCheckAt || item.nextCheckAt <= now)
          && this.paymentProvider(item.orderId) === "alipay_page");
      if (!candidate || candidate.status !== "processing"
          || (candidate.leaseToken && (!candidate.leaseUntil || candidate.leaseUntil > now))) return null;
      const claimed = {...candidate, nextCheckAt: new Date(now.getTime() + 60_000),
        leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 60_000)};
      this.repository.updateRefund(claimed);
      return claimed;
    });
    if (!refund) return;
    try {
      const result = await this.executor.query(refund.orderId, refund);
      if (result.status === "succeeded") {
        // A signed success is a financial fact, even if this query's lease has since been replaced.
        this.repository.transaction(() => this.completeLocked(refund.merchantId, refund.id, result.providerRefundNo, true));
        return;
      }
      // Official query succeeded but did not confirm a refund. Never use a new request number.
      const execution = this.repository.transaction(() => {
        const current = this.get(refund.merchantId, refund.id);
        if (!this.ownsRefundLease(current, refund)) return null;
        if (current.recoveryAttempts === undefined || current.recoveryAttempts >= 3) {
          this.deferOwnedRefund(refund, "refund_manual_review", 300_000);
          return null;
        }
        this.assertRefundExecutable(current, "alipay_page");
        const next = {...current, recoveryAttempts: current.recoveryAttempts + 1,
          lastSubmittedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000),
          nextCheckAt: new Date(Date.now() + 60_000)};
        this.repository.updateRefund(next);
        return next;
      });
      if (!execution) return;
      const reference = await this.executor.execute(execution.orderId, execution);
      this.repository.transaction(() => this.completeLocked(refund.merchantId, refund.id, reference, true));
    } catch (error) {
      const blocked = error instanceof AppError && ["fulfillment_blocks_refund", "order_not_refundable",
        "refund_order_not_found", "refund_provider_changed", "use_customer_refund",
        "provider_refund_reconciliation_required"].includes(error.code);
      this.deferOwnedRefund(refund, blocked ? "refund_manual_review" : "refund_result_unknown", blocked ? 300_000 : 60_000);
    }
  }

  /** Close a legacy failed request only on independently verified channel evidence.
   * A negative query is an additional binding check, never proof of finality by itself.
   * Processing/unknown requests must continue reconciliation and cannot use this path.
   */
  async closeFailedWithEvidence(actor: Actor, refundId: string, input: {
    refundRequestNo: string; evidenceReference: string; evidence: string; reason: string;
    evidenceAt: Date; confirmChannelTerminatedWithoutRefund: true;
  }, requestId: string): Promise<Refund> {
    if (actor.role !== "platform_admin" || actor.merchantId !== null)
      throw new AppError(403, "permission_denied", "仅平台管理员可核实结束失败退款");
    const proof = {refundRequestNo: input.refundRequestNo.trim(), evidenceReference: input.evidenceReference.trim(),
      evidence: input.evidence.trim(), reason: input.reason.trim(), evidenceAt: input.evidenceAt};
    if (!input.confirmChannelTerminatedWithoutRefund || proof.refundRequestNo !== refundId
        || proof.evidenceReference.length < 6 || proof.evidenceReference.length > 120
        || proof.evidence.length < 12 || proof.evidence.length > 1000 || proof.reason.length < 4 || proof.reason.length > 500)
      throw new AppError(422, "refund_closure_evidence_required", "须核对原退款请求号，并提供渠道已终结且未退款的真实凭证及原因");
    if (!Number.isFinite(proof.evidenceAt.getTime()) || proof.evidenceAt > new Date())
      throw new AppError(422, "refund_closure_time_invalid", "渠道核验时间无效，不得晚于当前时间");
    const claimed = this.repository.transaction(() => {
      const refund = this.findRefundById(refundId);
      if (!refund) throw notFound("refund");
      if (refund.status === "cancelled" && refund.cancelledReview) {
        const previous = refund.cancelledReview;
        if (previous.refundRequestNo !== proof.refundRequestNo || previous.evidenceReference !== proof.evidenceReference
            || previous.evidence !== proof.evidence || previous.reason !== proof.reason || previous.evidenceAt !== proof.evidenceAt.toISOString())
          throw new AppError(409, "refund_closure_conflict", "该退款已核实结束，不能覆盖原核验凭证");
        return refund;
      }
      if (refund.status === "succeeded") return refund;
      if (refund.status !== "failed") throw new AppError(409, "refund_changed", "仅旧失败退款可核实结束；处理中或结果未知的退款须继续核对");
      const now = new Date();
      if (refund.leaseToken && (!refund.leaseUntil || refund.leaseUntil > now))
        throw new AppError(409, "refund_review_in_progress", "退款正在核对或执行，请稍后刷新");
      const lastSubmitted = refund.lastSubmittedAt ? new Date(refund.lastSubmittedAt) : null;
      if (lastSubmitted && (!Number.isFinite(lastSubmitted.getTime()) || now.getTime() - lastSubmitted.getTime() < 60_000))
        throw new AppError(409, "refund_review_in_progress", "退款刚发起或发起时间不明，不能结束，须先核实渠道终态");
      if (proof.evidenceAt < refund.createdAt || (lastSubmitted && proof.evidenceAt < lastSubmitted))
        throw new AppError(422, "refund_closure_time_invalid", "渠道凭证时间不能早于退款申请或最近一次退款执行");
      if (refund.providerRefundNo) throw new AppError(409, "refund_result_unconfirmed", "已有渠道退款流水，请先核对真实退款结果");
      if (this.paymentProvider(refund.orderId) !== "alipay_page" || !this.executor?.query)
        throw new AppError(503, "refund_query_unavailable", "渠道精确退款查询不可用，不能结束失败退款");
      const next = {...refund, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + 60_000)};
      this.repository.updateRefund(next);
      return next;
    });
    if (claimed.status !== "failed") return claimed;
    try {
      const result = await this.executor!.query!(claimed.orderId, claimed);
      return this.repository.transaction(() => {
        const current = this.get(claimed.merchantId, claimed.id);
        if (result.status === "succeeded") {
          // Never discard an actual refund merely because a review lease expired.
          const completed = this.completeLocked(current.merchantId, current.id, result.providerRefundNo, true);
          if (current.status !== "succeeded") this.repository.appendAudit({id: `aud_${randomUUID().replaceAll("-", "")}`,
            merchantId: current.merchantId, actorId: actor.id, actorType: "platform_user", action: "refund.failed_review.found_refunded",
            targetType: "refund", targetId: current.id, requestId, createdAt: new Date()});
          return completed;
        }
        if (current.status !== "failed" || current.leaseToken !== claimed.leaseToken || !current.leaseUntil || current.leaseUntil <= new Date())
          throw new AppError(409, "refund_changed", "退款状态或核验占用已变化，请刷新后重新核实");
        if (result.bindingVerified !== true)
          throw new AppError(409, "refund_result_unconfirmed", "渠道未返回完整的原订单与退款请求绑定结果；查无记录不能作为结束依据");
        if (current.lastSubmittedAt !== claimed.lastSubmittedAt || current.amountMinor !== claimed.amountMinor
            || this.paymentProvider(current.orderId) !== "alipay_page")
          throw new AppError(409, "refund_changed", "退款执行事实已变化，请刷新后重新核实");
        assertRefundTransition(current.status, "cancelled");
        const now = new Date(), updated: Refund = {...current, status: "cancelled", nextCheckAt: null, leaseToken: null, leaseUntil: null,
          cancelledReview: {...proof, evidenceAt: proof.evidenceAt.toISOString(), reviewedAt: now.toISOString(), actorId: actor.id}};
        // Keep the original failureCode and reason; the review is separate evidence.
        this.repository.updateRefund(updated);
        this.repository.appendAudit({id: `aud_${randomUUID().replaceAll("-", "")}`, merchantId: current.merchantId,
          actorId: actor.id, actorType: "platform_user", action: "refund.failed_review.cancel", targetType: "refund",
          targetId: current.id, requestId, createdAt: now});
        return updated;
      });
    } finally {
      this.repository.transaction(() => {
        const current = this.get(claimed.merchantId, claimed.id);
        if (current.status === "failed" && current.leaseToken === claimed.leaseToken)
          this.repository.updateRefund({...current, leaseToken: null, leaseUntil: null});
      });
    }
  }

  reject(actor: Actor, refundId: string, reason: string): Refund {
    requirePermission(actor, "wallet.review");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台财务可驳回退款");
    const body = reason.trim();
    if (body.length < 2) throw new AppError(422, "invalid_reason", "请填写驳回原因");
    return this.repository.transaction(() => {
      const refund = this.findRefundById(refundId);
      if (!refund) throw notFound("refund");
      if (refund.status !== "requested") throw new AppError(409, "refund_changed", "退款单已处理，请刷新");
      assertRefundTransition(refund.status, "rejected");
      const updated: Refund = {...refund, status: "rejected", failureCode: body, refundedAt: null};
      this.repository.updateRefund(updated);
      return updated;
    });
  }

  private findRefundById(refundId: string): Refund | undefined {
    if (this.repository.findRefundInternal) return this.repository.findRefundInternal(refundId) ?? undefined;
    return this.repository.listOrdersInternal().flatMap(order => this.repository.listRefundsForOrder(order.merchantId, order.id))
      .find(item => item.id === refundId);
  }

  private paymentProvider(orderId: string): string | null {
    const order = this.repository.findOrderInternal(orderId);
    if (!order) return null;
    return this.repository.findPaymentAttemptByOrder(order.merchantId, orderId)?.provider ?? null;
  }

  private ownsRefundLease(current: Refund, claimed: Refund): boolean {
    return current.status === "processing" && !!claimed.leaseToken && current.leaseToken === claimed.leaseToken
      && !!current.leaseUntil && current.leaseUntil > new Date();
  }

  private deferOwnedRefund(claimed: Refund, failureCode: string, delayMs: number): void {
    this.repository.transaction(() => {
      const current = this.get(claimed.merchantId, claimed.id);
      if (!this.ownsRefundLease(current, claimed)) return;
      this.repository.updateRefund({...current, failureCode, nextCheckAt: new Date(Date.now() + delayMs),
        leaseToken: null, leaseUntil: null});
    });
  }

  /** Both initial approval and every recovery submission must recheck under the write transaction. */
  private assertRefundExecutable(refund: Refund, expectedProvider: string | null): void {
    const order = this.repository.findOrder(refund.merchantId, refund.orderId);
    if (!order || order.collectionMode !== "platform_collect")
      throw new AppError(409, "refund_order_not_found", "仅平台代收订单可自动退款");
    this.assertProviderRefundReconciled(order);
    if (this.paymentProvider(order.id) !== expectedProvider)
      throw new AppError(409, "refund_provider_changed", "退款渠道已变化，请刷新后核对");
    if (!["paid", "partially_refunded"].includes(order.paymentStatus))
      throw new AppError(409, "order_not_refundable", "当前支付状态不可退款");
    if (refund.type !== "price_adjustment") this.assertOrdinaryRefundExecutable(order);
    if (refund.type === "price_adjustment"
        && order.ordinaryRefundedMinor + order.priceAdjustmentRefundedMinor + refund.amountMinor >= order.saleAmountMinor)
      throw new AppError(409, "use_customer_refund", "全额退款不能使用差价退款；请先安全处理充值任务，再选择客户退款");
  }

  private assertProviderRefundReconciled(order: Order): void {
    if (hasUnreconciledProviderRefund(this.repository, order.merchantId, order.id))
      throw new AppError(409, "provider_refund_reconciliation_required", "渠道退款差异尚未核清，不能再次发起退款；请先查询或登记渠道已发生的退款");
  }

  private scheduleReconciliationRefresh(order: Order): void {
    if (!hasUnreconciledProviderRefund(this.repository, order.merchantId, order.id)) return;
    const attempt=this.repository.findPaymentAttemptByOrder(order.merchantId,order.id);
    if (!attempt || attempt.provider!=="alipay_page") return;
    const nextCheckAt=new Date(Date.now()+60_000);
    if (!attempt.nextCheckAt || attempt.nextCheckAt>nextCheckAt)
      this.repository.updatePaymentAttempt({...attempt,nextCheckAt,updatedAt:new Date()});
  }

  /** Run while holding the same write transaction that claims the refund for channel execution. */
  private assertOrdinaryRefundExecutable(order: Order): void {
    if (this.repository.getOperations("manual_completion", order.id)
        || this.repository.listFulfillments(order.merchantId, order.id).some(task => !!task.leaseToken || !isConfirmedUnsuccessfulFulfillment(task))) {
      throw new AppError(409, "fulfillment_blocks_refund", "充值处理中、结果未知或已完成，不能执行普通退款");
    }
  }

  private completeLocked(merchantId: string, refundId: string, providerRefundNo: string | null = null, providerConfirmed = false, reconcilesExistingFact = false): Refund {
    const current = this.get(merchantId, refundId);
    let status = current.status;
    // A later channel success corrects a local closure; it must not disappear behind an expired lease.
    if (providerConfirmed && ["cancelled", "rejected"].includes(status)) status = "processing";
    if (status === "requested" || status === "failed") {
      assertRefundTransition(status, "approved");
      status = "approved";
    }
    if (status === "approved") {
      assertRefundTransition(status, "processing");
      status = "processing";
    }
    if (status === "succeeded") {
      if (!current.nextCheckAt && !current.leaseToken && !current.leaseUntil) return current;
      const settled = {...current, nextCheckAt: null, leaseToken: null, leaseUntil: null};
      this.repository.updateRefund(settled);
      return settled;
    }
    assertRefundTransition(status, "succeeded");
    const refund: Refund = {
      ...current,
      status: "succeeded",
      providerRefundNo: providerRefundNo ?? current.providerRefundNo ?? null,
      refundedAt: new Date(),
      failureCode: null,
      nextCheckAt: null,
      leaseToken: null,
      leaseUntil: null,
    };
    this.repository.updateRefund(refund);

    const order = this.repository.findOrder(merchantId, current.orderId);
    if (!order) throw notFound("order");
    const updated = {
      ...order,
      ordinaryRefundedMinor: order.ordinaryRefundedMinor + (refund.type === "price_adjustment" ? 0n : refund.amountMinor),
      priceAdjustmentRefundedMinor: order.priceAdjustmentRefundedMinor + (refund.type === "price_adjustment" ? refund.amountMinor : 0n),
      updatedAt: new Date(),
    };
    const totalRefunded = updated.ordinaryRefundedMinor + updated.priceAdjustmentRefundedMinor;
    const nextPaymentStatus = totalRefunded >= order.saleAmountMinor ? "refunded" as const : "partially_refunded" as const;
    assertPaymentTransition(order.paymentStatus, nextPaymentStatus);
    updated.paymentStatus = nextPaymentStatus;
    this.repository.updateOrder(updated);
    this.providerRefundObserver?.recorded({merchantId,orderId:order.id,recordedMinor:totalRefunded,
      reconciliationCreditMinor:reconcilesExistingFact?current.amountMinor:0n});
    const attempt = this.repository.findPaymentAttemptByOrder(merchantId, order.id);
    if (attempt && nextPaymentStatus === "refunded") {
      const {nextCheckAt: _nextCheckAt, ...refundedAttempt} = attempt;
      this.repository.updatePaymentAttempt({...refundedAttempt, status: "refunded", updatedAt: new Date()});
    }
    this.scheduleReconciliationRefresh(updated);
    this.ledger.recordRefund(updated, refund);
    this.onFinancialChange?.(order.id);
    const latestFulfillment = latestFulfillmentOf(this.repository.listFulfillments(merchantId, order.id));
    this.webhooks.emit(merchantId, `${refund.id}:refund.succeeded`, "refund.succeeded", refund.id, {
      event: "refund.succeeded",
      order_id: order.id,
      refund_id: refund.id,
      type: refund.type,
      payment_status: nextPaymentStatus,
      fulfillment_status: latestFulfillment?.status ?? null,
      fulfillment_failure_code: latestFulfillment?.failureCode ?? null,
      sync_mark: orderSyncMark(nextPaymentStatus, latestFulfillment),
    });
    return refund;
  }
}

/** Remaining amount that can still be refunded to the customer (any refund type). */
function availableCustomerRefundMinor(order: Order, refunds: readonly Refund[]): bigint {
  const reserved = refunds
    .filter(item => !["rejected", "cancelled"].includes(item.status))
    .reduce((sum, item) => sum + item.amountMinor, 0n);
  const remaining = order.saleAmountMinor - reserved;
  return remaining > 0n ? remaining : 0n;
}
