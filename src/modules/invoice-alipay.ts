import {randomUUID} from "node:crypto";
import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";
import type {Repository} from "../infra/repository.js";
import type {Actor, InvoiceFeePayment} from "../operations/model.js";
import type {InvoiceService} from "../operations/invoices.js";
import {createAlipayClientFromKeys, type AlipayClient} from "./alipay-payment.js";
import type {PaymentSettingsService} from "./payment-settings.js";
import type {PortalTokenService} from "./portal-token.js";

type LegacyAlipay = {client: AlipayClient; identity: {appId: string; sellerId: string}} | null;

/** Separate platform-owned payment flow for the agent-borne 5% invoice difference. */
export class InvoiceAlipayService {
  constructor(private readonly repository: Repository, private readonly settings: PaymentSettingsService,
    private readonly invoices: InvoiceService, private readonly base: string, private readonly tokens: PortalTokenService,
    private readonly legacy: LegacyAlipay = null) {}

  ensurePayment(actor: Actor, applicationId: string): {payment: InvoiceFeePayment; payUrl: string} {
    const application = this.invoices.application(applicationId);
    if (actor.merchantId !== application.merchantId) throw new AppError(404, "invoice_not_found", "开票申请不存在");
    if (application.status !== "awaiting_payment") throw new AppError(409, "invoice_already_submitted", "补差价已支付，开票申请已提交");
    const now = new Date();
    const pending = this.repository.listOperations("invoice_fee_payment", application.merchantId)
      .filter(item => item.applicationId === application.id && item.status === "pending")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (pending && pending.expiresAt > now) return {payment: pending, payUrl: this.portalUrl(pending.id)};
    if (pending) this.repository.saveOperations("invoice_fee_payment", {...pending, status: "expired", updatedAt: now});
    const configId = this.activeConfigId();
    const id = "invpay_" + randomUUID().replaceAll("-", "");
    const payment: InvoiceFeePayment = {id, merchantId: application.merchantId, applicationId: application.id,
      amountMinor: application.feeAmountMinor, status: "pending", paymentConfigId: configId,
      qrPayload: null, providerRef: null, expiresAt: new Date(Date.now() + 15 * 60_000), nextCheckAt: null,
      paidAt: null, createdAt: now, updatedAt: now};
    this.repository.saveOperations("invoice_fee_payment", payment, true);
    this.invoices.attachPayment(application.id, payment.id);
    return {payment, payUrl: this.portalUrl(payment.id)};
  }

  portalUrl(id: string): string {
    return `${this.base}/invoice-payments/${encodeURIComponent(id)}?token=${this.tokens.paymentToken(id)}`;
  }

  async precreate(id: string): Promise<string> {
    const payment = this.payment(id);
    if (payment.status !== "pending" || payment.expiresAt <= new Date()) throw new AppError(409, "payment_not_available", "补差价支付单已过期，请返回开票申请重新发起");
    if (payment.qrPayload && isAlipayPrecreateQr(payment.qrPayload)) return payment.qrPayload;
    if (payment.paymentConfigId) this.settings.assertOpen("alipay_page");
    const {client, identity} = this.client(payment);
    const result = await client.exec("alipay.trade.precreate", {
      notifyUrl: this.base + "/internal/webhooks/alipay",
      bizContent: {out_trade_no: payment.id, product_code: "FACE_TO_FACE_PAYMENT", seller_id: identity.sellerId,
        total_amount: minorToMoney(payment.amountMinor), subject: "订单补差价", timeout_express: timeoutExpress(payment.expiresAt)},
    }, {validateSign: true});
    const qrCode = typeof result.qr_code === "string" ? result.qr_code : "";
    if (result.code !== "10000" || !qrCode) throw new AppError(503, "payment_provider_unavailable", "支付宝补差价收款暂不可用，请稍后重试");
    this.repository.saveOperations("invoice_fee_payment", {...payment, qrPayload: qrCode, updatedAt: new Date()});
    return qrCode;
  }

  handleNotification(input: Record<string, string>): void {
    const payment = this.payment(input.out_trade_no ?? "");
    const {client, identity} = this.client(payment);
    let valid = false;
    try { valid = input.sign_type === "RSA2" && client.checkNotifySignV2(input); } catch { /* fail closed */ }
    if (!valid || input.app_id !== identity.appId || input.seller_id !== identity.sellerId) throw new AppError(400, "invalid_payment_notification", "支付通知验证失败");
    this.accept(payment, identity, input);
  }

  async reconcile(id: string): Promise<void> {
    const payment = this.repository.transaction(() => {
      const current = this.payment(id);
      if (current.status !== "pending" || (current.nextCheckAt && current.nextCheckAt > new Date())) return null;
      this.repository.saveOperations("invoice_fee_payment", {...current, nextCheckAt: new Date(Date.now() + 60_000), updatedAt: new Date()});
      return current;
    });
    if (!payment) return;
    const {client, identity} = this.client(payment);
    try {
      const result = await client.exec("alipay.trade.query", {bizContent: {out_trade_no: payment.id}}, {validateSign: true});
      if (result.code === "40004" && result.sub_code === "ACQ.TRADE_NOT_EXIST") {
        if (payment.expiresAt <= new Date()) this.repository.saveOperations("invoice_fee_payment", {...payment, status: "expired", updatedAt: new Date()});
        return;
      }
      if (result.code !== "10000") throw new Error("query_failed");
      this.accept(payment, identity, result as Record<string, string>);
    } catch {
      throw new AppError(503, "payment_query_pending", "支付宝结果暂未确认，请稍后查询；不要重复付款", true);
    }
  }

  async reconcileOne(): Promise<void> {
    const candidate = this.repository.listOperations("invoice_fee_payment").find(item => item.status === "pending"
      && (!item.nextCheckAt || item.nextCheckAt <= new Date()));
    if (candidate) await this.reconcile(candidate.id);
  }

  payment(id: string): InvoiceFeePayment {
    const value = this.repository.getOperations("invoice_fee_payment", id);
    if (!value) throw new AppError(404, "invoice_payment_not_found", "补差价支付单不存在");
    return value;
  }

  private activeConfigId(): string | null {
    try { return this.settings.active("alipay_page").id; }
    catch (error) {
      if (this.legacy) return null;
      throw error;
    }
  }

  private client(payment: InvoiceFeePayment): {client: AlipayClient; identity: {appId: string; sellerId: string}} {
    if (!payment.paymentConfigId) {
      if (!this.legacy) throw new AppError(503, "payment_config_not_found", "支付宝补差价收款尚未配置");
      return this.legacy;
    }
    const revision = this.settings.revision(payment.paymentConfigId, "alipay_page"), keys = this.settings.secrets(revision);
    const identity = {appId: revision.details.appId!, sellerId: revision.details.sellerId!};
    return {identity, client: createAlipayClientFromKeys({...identity, privateKey: keys.privateKey!,
      alipayPublicKey: keys.publicKey!, keyType: revision.details.keyType as "PKCS1" | "PKCS8"})};
  }

  private accept(payment: InvoiceFeePayment, identity: {appId: string; sellerId: string}, data: Record<string, string>): void {
    if (data.out_trade_no !== payment.id || amountMinor(data.total_amount) !== payment.amountMinor || !/^\d{8,64}$/.test(data.trade_no ?? "")
        || (data.seller_id !== undefined && data.seller_id !== identity.sellerId)
        || (data.app_id !== undefined && data.app_id !== identity.appId)) {
      throw new AppError(409, "payment_binding_mismatch", "支付宝交易与补差价支付单不匹配");
    }
    if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(data.trade_status ?? "")) this.invoices.markPaid(payment.id, data.trade_no!, payment.amountMinor);
  }
}

function amountMinor(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) return -1n;
  const [integer = "0", fraction = ""] = value.split(".");
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function timeoutExpress(expiresAt: Date): string {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60_000)) + "m";
}

function isAlipayPrecreateQr(value: string): boolean {
  try { return new URL(value).hostname === "qr.alipay.com"; } catch { return false; }
}
