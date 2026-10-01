import type {Repository} from "../infra/repository.js";
import type {PaymentChannel} from "../operations/model.js";
import {AppError} from "../domain/errors.js";
import type {PaymentCreation, PaymentProvider} from "./payment-service.js";
import {PaymentService} from "./payment-service.js";
import {PortalTokenService} from "./portal-token.js";
import {PaymentSettingsService} from "./payment-settings.js";
import {AlipayPagePaymentProvider, AlipayPaymentService, createAlipayClientFromKeys} from "./alipay-payment.js";

export class ManagedPaymentProvider implements PaymentProvider {
  readonly name = "managed";
  readonly ownership = "quefa_platform" as const;
  constructor(private readonly settings: PaymentSettingsService, private readonly base: string, private readonly tokens: PortalTokenService) {}
  async create(id: string, _amount: bigint, expiresAt: Date, channel?: PaymentChannel): Promise<PaymentCreation> {
    const r = this.settings.active(channel);
    // No external writes before the local order and immutable revision binding commit.
    return {providerRef: id, expiresAt, channel: r.channel, paymentConfigId: r.id,
      qrPayload: this.base + (r.channel === "dujiaopay" ? "/usdt-payments/" : "/payments/") + id + "?token=" + this.tokens.paymentToken(id)};
  }
  validateCreation(creation: PaymentCreation): void {
    if (this.settings.active(creation.channel).id !== creation.paymentConfigId) throw new AppError(409, "payment_config_changed", "支付配置已更新，请重新下单");
  }
}
export class ManagedAlipayService {
  constructor(private readonly repo: Repository, private readonly settings: PaymentSettingsService, private readonly payment: PaymentService,
    private readonly base: string, private readonly provider: AlipayPagePaymentProvider, private readonly legacy: AlipayPaymentService | null = null) {}
  private service(id: string): AlipayPaymentService {
    const o = this.repo.findOrderInternal(id), attempt = o && this.repo.findPaymentAttemptByOrder(o.merchantId, id);
    if (!attempt || attempt.provider !== "alipay_page") throw new AppError(404, "payment_not_found", "支付订单不存在");
    if (!attempt.paymentConfigId) {
      if (this.legacy) return this.legacy;
      throw new AppError(409, "payment_legacy_keys_required", "旧订单需要保留原文件密钥");
    }
    const r = this.settings.revision(attempt.paymentConfigId, "alipay_page"), keys = this.settings.secrets(r);
    const identity = {appId: r.details.appId!, sellerId: r.details.sellerId!};
    return new AlipayPaymentService(this.repo, this.payment, createAlipayClientFromKeys({...identity, privateKey: keys.privateKey!,
      alipayPublicKey: keys.publicKey!, keyType: r.details.keyType as "PKCS1" | "PKCS8"}), identity, this.base, this.provider);
  }
  async precreate(id: string): Promise<string> {this.settings.assertOpen("alipay_page"); return this.service(id).precreate(id);}
  handleNotification(input: Record<string, string>): void {this.service(input.out_trade_no ?? "").handleNotification(input);}
  async reconcile(id: string): Promise<void> {await this.service(id).reconcile(id);}
  async refund(orderId: string, refundId: string, amountMinor: bigint, reason: string): Promise<string> {
    return this.service(orderId).refund(orderId, refundId, amountMinor, reason);
  }
  queryRefund(orderId: string, refundId: string, amountMinor: bigint) {
    return this.service(orderId).queryRefund(orderId, refundId, amountMinor);
  }
  async reconcileOne(): Promise<void> {
    const now=new Date(),o=this.repo.findDuePaymentOrder?.("alipay_page",now)??this.repo.listOrdersInternal().find(order=>{
      const attempt=this.repo.findPaymentAttemptByOrder(order.merchantId,order.id);return order.paymentStatus==="pending"&&attempt?.provider==="alipay_page"&&(!attempt.nextCheckAt||attempt.nextCheckAt<=now);
    });
    if (o) await this.reconcile(o.id);
  }
}
