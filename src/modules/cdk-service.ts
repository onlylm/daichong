import {createHash, randomUUID} from "node:crypto";
import type {CdkVoucher, Order} from "../domain/model.js";
import type {Repository} from "../infra/repository.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import type {RechargeUpstreamProvider} from "../upstream/recharge-provider.js";
import {UpstreamRequestError} from "../upstream/recharge-provider.js";
import {WebhookService} from "./webhook-service.js";
import {AppError} from "../domain/errors.js";
import {LiveTestPolicy} from "./live-test-policy.js";
import {createPublicCdkCode, normalizeCdkPrefix} from "./cdk-code.js";
import {isConfirmedUnsuccessfulFulfillment} from "../domain/recharge-policy.js";

export class CdkService {
  constructor(
    private readonly repository: Repository,
    private readonly cipher: SensitivePayloadCipher,
    private readonly upstream: RechargeUpstreamProvider,
    private readonly webhooks: WebhookService,
    private readonly livePolicy?: LiveTestPolicy,
  ) {}

  async issueOne(): Promise<CdkVoucher | null> {
    const claim = this.repository.transaction(() => this.claimIssuance());
    if (!claim) return null;
    const {order, pending} = claim;
    let issued: {id: string; code: string};
    try {
      issued = await this.upstream.issueCdk({plan: order.upstreamPlan, idempotencyKey: `quefa-cdk-${order.id}`});
    } catch (error) {
      return this.repository.transaction(() => {
        const latest = this.repository.findCdkVoucherByOrder(order.id)!;
        if (latest.status !== "issuing" || latest.issueLeaseToken !== pending.issueLeaseToken) return null;
        const issueAttempts = latest.issueAttempts + 1;
        if (!(error instanceof UpstreamRequestError) || error.retryable || ["upstream_configuration_error", "production_supplier_required", "production_execution_disabled"].includes(error.failureCode)) {
          const delay = Math.min(300_000, 1_000 * (2 ** Math.min(issueAttempts, 8)));
          this.repository.updateCdkVoucher({...latest, issueLeaseToken: null, issueAttempts, nextAttemptAt: new Date(Date.now() + delay), failureCode: "service_unavailable"});
          return null;
        }
        this.repository.updateCdkVoucher({...latest, status: "failed", issueLeaseToken: null, issueAttempts, failureCode: "service_unavailable", upstreamCodePayload: this.cipher.clear(latest.upstreamCodePayload)});
        this.webhooks.emit(order.merchantId, `${latest.id}:cdk.failed`, "cdk.failed", latest.id, {
          event: "cdk.failed", order_id: order.id, failure_code: "service_unavailable",
        });
        return null;
      });
    }
    return this.repository.transaction(() => {
      const latest = this.repository.findCdkVoucherByOrder(order.id)!;
      if (latest.status !== "issuing" || latest.issueLeaseToken !== pending.issueLeaseToken) return null;
      const voucher: CdkVoucher = {
        ...latest, status: "unused", issueLeaseToken: null, upstreamProvider: this.upstream.name,
        upstreamCdkId: issued.id,
        upstreamCodePayload: this.cipher.encrypt({code: issued.code}, voucherAad(order, latest.id)),
        failureCode: null,
      };
      this.repository.updateCdkVoucher(voucher);
      const latestOrder = this.repository.findOrderInternal(order.id)!;
      this.repository.updateOrder({...latestOrder, voucherCode: voucher.publicCode, updatedAt: new Date()});
      this.webhooks.emit(order.merchantId, `${voucher.id}:cdk.issued`, "cdk.issued", voucher.id, {
        event: "cdk.issued", order_id: order.id,
        delivery_mode: latestOrder.deliveryMode ?? "cdk",
        ...((latestOrder.deliveryMode ?? "cdk") === "cdk" ? {voucher_code: voucher.publicCode} : {}),
      });
      return voucher;
    });
  }

  private claimIssuance(): {order: Order; pending: CdkVoucher} | null {
    const order = this.repository.listOrdersInternal().find((item) =>
      item.fulfillmentMode === "cdk"
      && (!this.livePolicy || this.livePolicy.canFulfill(item))
      && ["paid", "partially_refunded"].includes(item.paymentStatus)
      && item.ordinaryRefundedMinor === 0n
      && !this.repository.listRefundsForOrder(item.merchantId, item.id).some((refund) => ["requested", "approved", "processing"].includes(refund.status))
      && (() => {
        const voucher = this.repository.findCdkVoucherByOrder(item.id);
        return !voucher || (voucher.status === "issuing" && (voucher.nextAttemptAt ?? voucher.createdAt) <= new Date());
      })(),
    );
    if (!order) return null;
    const id = `vch_${randomUUID().replaceAll("-", "")}`;
    const pending = this.repository.findCdkVoucherByOrder(order.id) ?? {
      id,
      merchantId: order.merchantId,
      orderId: order.id,
      publicCode: createPublicCdkCode(this.cdkPrefix(order.merchantId)),
      plan: order.upstreamPlan,
      status: "issuing" as const,
      upstreamProvider: this.upstream.name,
      upstreamCdkId: null,
      upstreamCodePayload: this.cipher.encrypt({code: ""}, voucherAad(order, id)),
      issueAttempts: 0,
      nextAttemptAt: new Date(),
      failureCode: null,
      createdAt: new Date(),
      consumedAt: null,
    };
    if (!this.repository.findCdkVoucherByOrder(order.id)) this.repository.insertCdkVoucher(pending);
    const claimed = {...pending, issueLeaseToken: randomUUID(), nextAttemptAt: new Date(Date.now() + 60_000)};
    this.repository.updateCdkVoucher(claimed);
    return {order, pending: claimed};
  }

  findPublic(publicCode: string): CdkVoucher | null {
    return this.repository.findCdkVoucherByPublicCode(publicCode);
  }

  /** Close already-refunded resources without issuing codes, charging, or refunding again. */
  async reconcileRefundedOne(): Promise<CdkVoucher | null> {
    const candidate = this.repository.transaction(() => {
      const now = new Date();
      for (const order of this.repository.listOrdersInternal()) {
        if (order.paymentStatus !== "refunded") continue;
        if (this.repository.listFulfillments(order.merchantId, order.id).some(task => !isConfirmedUnsuccessfulFulfillment(task))) continue;
        const voucher = this.repository.findCdkVoucherByOrder(order.id);
        if (!voucher?.upstreamCdkId || !["unused", "reserved", "disabling", "disabled"].includes(voucher.status)
          || (voucher.status === "disabled" && !voucher.upstreamCodePayload.ciphertext)
          || (voucher.status === "disabling" && voucher.nextAttemptAt > now)) continue;
        this.repository.updateCdkVoucher({...voucher, status: "disabling", nextAttemptAt: new Date(now.getTime() + 60_000)});
        return order.id;
      }
      return null;
    });
    return candidate ? this.disable(candidate) : null;
  }

  async disable(orderId: string): Promise<CdkVoucher> {
    const voucher = this.repository.transaction(() => {
      const current = this.repository.findCdkVoucherByOrder(orderId);
      if (!current || !current.upstreamCdkId) throw new AppError(404, "voucher_not_found", "兑换码尚未签发");
      if (current.status === "disabled") return current;
      if (!["unused", "disabling"].includes(current.status)) throw new AppError(409, "voucher_disable_conflict", "仅可停用未兑换的码；请先取消尚未派发的充值任务");
      if (current.upstreamProvider !== this.upstream.name) throw new AppError(409, "voucher_provider_mismatch", "供应环境与发码环境不一致");
      if (!this.upstream.disableCdk) throw new AppError(503, "voucher_disable_unavailable", "当前渠道不支持停码");
      const locked = {...current, status: "disabling" as const};
      this.repository.updateCdkVoucher(locked);
      return locked;
    });
    if (voucher.status === "disabled") return voucher;
    try {
      await this.upstream.disableCdk!(voucher.upstreamCdkId!);
    } catch {
      // Remain non-redeemable and non-refundable until the provider confirms.
      throw new AppError(503, "voucher_disable_pending", "停用结果待确认；兑换码保持锁定，请重试核对，不代表已退款", true);
    }
    return this.repository.transaction(() => {
      const current = this.repository.findCdkVoucherByOrder(orderId)!;
      if (current.status === "disabled") return current;
      if (current.status !== "disabling") throw new AppError(409, "voucher_state_conflict", "兑换码状态已变化");
      const disabled = {...current, status: "disabled" as const, failureCode: null, upstreamCodePayload: this.cipher.clear(current.upstreamCodePayload)};
      this.repository.updateCdkVoucher(disabled);
      this.webhooks.emit(current.merchantId, current.id + ":cdk.disabled", "cdk.disabled", current.id,
        {event: "cdk.disabled", order_id: orderId});
      return disabled;
    });
  }

  readUpstreamCode(voucher: CdkVoucher): string {
    const order = this.repository.findOrderInternal(voucher.orderId);
    if (!order) throw new Error("voucher_order_not_found");
    const decrypted = this.cipher.decrypt(voucher.upstreamCodePayload, voucherAad(order, voucher.id)) as {code?: unknown};
    if (typeof decrypted.code !== "string") throw new Error("voucher_code_unavailable");
    return decrypted.code;
  }

  reserve(voucher: CdkVoucher): CdkVoucher {
    if (voucher.status !== "unused") throw new Error("voucher_not_unused");
    const reserved = {...voucher, status: "reserved" as const};
    this.repository.updateCdkVoucher(reserved);
    return reserved;
  }

  release(voucherId: string): void {
    const voucher = this.repository.listOrdersInternal()
      .map((order) => this.repository.findCdkVoucherByOrder(order.id))
      .find((item) => item?.id === voucherId);
    if (!voucher || voucher.status !== "reserved") return;
    this.repository.updateCdkVoucher({...voucher, status: "unused"});
  }

  cdkPrefix(merchantId: string): string {
    const profile = this.repository.getOperations("agent_profile", merchantId);
    return normalizeCdkPrefix(profile?.cdkCodePrefix);
  }

  consume(voucherId: string): void {
    const voucher = this.repository.listOrdersInternal()
      .map((order) => this.repository.findCdkVoucherByOrder(order.id))
      .find((item) => item?.id === voucherId);
    if (!voucher || voucher.status === "consumed") return;
    this.repository.updateCdkVoucher({
      ...voucher,
      status: "consumed",
      consumedAt: new Date(),
      upstreamCodePayload: this.cipher.clear(voucher.upstreamCodePayload),
    });
  }
}

function voucherAad(order: Order, voucherId: string): string {
  return createHash("sha256").update(`${order.merchantId}\0${order.id}\0${voucherId}`).digest("hex");
}
