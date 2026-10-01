import {readFileSync} from "node:fs";
import {AlipaySdk} from "alipay-sdk";
import type {AppConfig} from "../config.js";
import {AppError} from "../domain/errors.js";
import type {Order} from "../domain/model.js";
import {minorToMoney} from "../domain/money.js";
import type {Repository} from "../infra/repository.js";
import {PortalTokenService} from "./portal-token.js";
import type {PaymentProvider, PaymentCreation} from "./payment-service.js";
import {PaymentService} from "./payment-service.js";

export type AlipayClient = Pick<AlipaySdk, "pageExecute" | "exec" | "checkNotifySignV2">;
export function createAlipayClientFromKeys(config: {appId: string; privateKey: string; alipayPublicKey: string; keyType: "PKCS1" | "PKCS8"}): AlipayClient {
  if (/alipay|\*/i.test(process.env.NODE_DEBUG ?? "")) throw new Error("真实支付禁止 SDK 调试日志");
  return new AlipaySdk({...config, signType: "RSA2", camelcase: false, timeout: 15000, gateway: "https://openapi.alipay.com/gateway.do"});
}

export function createAlipayClient(config: NonNullable<AppConfig["alipay"]>): AlipayClient {
  try {
    const privateKey = readFileSync(config.privateKeyPath, "utf8").trim();
    const alipayPublicKey = readFileSync(config.publicKeyPath, "utf8").trim();
    if (!privateKey || !alipayPublicKey) throw new Error("empty_key");
    return createAlipayClientFromKeys({appId: config.appId, privateKey, alipayPublicKey, keyType: config.keyType});
  } catch {
    throw new Error("支付宝密钥文件不可用，请检查格式与读取权限；不要在日志或聊天中输出私钥");
  }
}

export class AlipayPagePaymentProvider implements PaymentProvider {
  readonly ownership = "quefa_platform" as const;
  readonly name = "alipay_page";
  constructor(private readonly base: string, private readonly tokens: PortalTokenService) {}
  async create(orderId: string, _amount: bigint, expiresAt: Date): Promise<PaymentCreation> {
    // Local URL only. No provider write occurs before the order transaction commits.
    return {providerRef: orderId, qrPayload: this.url(orderId), expiresAt};
  }
  url(orderId: string): string {
    return this.base + "/payments/" + encodeURIComponent(orderId) + "?token=" + this.tokens.paymentToken(orderId);
  }
  resultUrl(orderId: string): string {
    return this.base + "/payments/" + encodeURIComponent(orderId) + "/result?token=" + this.tokens.paymentToken(orderId);
  }
}

export class AlipayPaymentService {
  constructor(
    private readonly repository: Repository,
    private readonly payment: PaymentService,
    private readonly client: AlipayClient,
    private readonly identity: {appId: string; sellerId: string},
    private readonly base: string,
    private readonly provider: AlipayPagePaymentProvider,
  ) {}

  async precreate(orderId: string): Promise<string> {
    const order = this.order(orderId);
    if (order.paymentStatus !== "pending" || order.expiresAt <= new Date()) {
      throw new AppError(409, "payment_not_available", "订单不可支付，请查询订单状态或重新下单");
    }
    const attempt = this.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    if (attempt.qrPayload && isAlipayPrecreateQr(attempt.qrPayload)) return attempt.qrPayload;
    const result = await this.client.exec("alipay.trade.precreate", {
      notifyUrl: this.base + "/internal/webhooks/alipay",
      bizContent: {out_trade_no: order.id, product_code: "FACE_TO_FACE_PAYMENT", seller_id: this.identity.sellerId,
        total_amount: minorToMoney(order.saleAmountMinor), subject: order.id, timeout_express: timeoutExpress(order.expiresAt)},
    }, {validateSign: true});
    const qrCode = typeof result.qr_code === "string" ? result.qr_code : "";
    if (result.code !== "10000" || !qrCode) throw new AppError(503, "payment_provider_unavailable", "支付宝当面付暂不可用，请稍后重试");
    this.repository.updatePaymentAttempt({...attempt, qrPayload: qrCode, updatedAt: new Date()});
    return qrCode;
  }

  handleNotification(input: Record<string, string>): void {
    let valid = false;
    try { valid = input.sign_type === "RSA2" && this.client.checkNotifySignV2(input); } catch { /* fail closed */ }
    if (!valid || input.app_id !== this.identity.appId || input.seller_id !== this.identity.sellerId) {
      throw new AppError(400, "invalid_payment_notification", "支付通知验证失败");
    }
    const order = this.order(input.out_trade_no ?? "");
    this.accept(order, input);
  }

  async reconcile(orderId: string): Promise<void> {
    const order = this.repository.transaction(() => {
      const current = this.order(orderId);
      const attempt = this.repository.findPaymentAttemptByOrder(current.merchantId, current.id)!;
      if (current.paymentStatus !== "pending" || (attempt.nextCheckAt && attempt.nextCheckAt > new Date())) return null;
      this.repository.updatePaymentAttempt({...attempt, nextCheckAt: new Date(Date.now() + 60_000), updatedAt: new Date()});
      return current;
    });
    if (!order) return;
    try {
      // v2 query retained for compatibility with existing website-payment applications.
      // Verification uses the original response bytes inside the official SDK.
      const result = await this.client.exec("alipay.trade.query", {bizContent: {out_trade_no: order.id}}, {validateSign: true});
      if (result.code === "40004" && result.sub_code === "ACQ.TRADE_NOT_EXIST") return;
      if (result.code !== "10000") throw new Error("query_failed");
      this.accept(order, result as Record<string, string>);
    } catch {
      throw new AppError(503, "payment_query_pending", "支付结果暂未确认，请稍后查询；不要重复付款", true);
    }
  }

  async refund(orderId: string, refundId: string, amountMinor: bigint, reason: string): Promise<string> {
    const order = this.order(orderId);
    if (amountMinor <= 0n || amountMinor > order.saleAmountMinor) throw new AppError(422, "invalid_refund_amount", "退款金额无效");
    const result = await this.client.exec("alipay.trade.refund", {
      bizContent: {out_trade_no: order.id, refund_amount: minorToMoney(amountMinor), out_request_no: refundId.slice(0, 64),
        refund_reason: reason.trim().slice(0, 256) || "平台退款"},
    }, {validateSign: true});
    if (result.code !== "10000") {
      throw new AppError(503, "alipay_refund_failed", typeof result.sub_msg === "string" ? result.sub_msg : "支付宝退款失败", true);
    }
    const tradeNo = typeof result.trade_no === "string" ? result.trade_no : "";
    if (!tradeNo) throw new AppError(503, "alipay_refund_pending", "支付宝退款结果待确认，请稍后重试", true);
    return tradeNo;
  }

  async queryRefund(orderId: string, refundId: string, expectedAmount: bigint): Promise<{status: "succeeded"; providerRefundNo: string} | {status: "not_confirmed"}> {
    const order = this.order(orderId);
    const result = await this.client.exec("alipay.trade.fastpay.refund.query", {
      bizContent: {out_trade_no: order.id, out_request_no: refundId.slice(0, 64)},
    }, {validateSign: true});
    if (result.code !== "10000") throw new AppError(503, "refund_query_pending", "退款结果待核对", true);
    if (result.refund_status !== "REFUND_SUCCESS") return {status: "not_confirmed"};
    if (result.out_trade_no !== order.id || result.out_request_no !== refundId.slice(0, 64)
        || amountMinor(result.refund_amount) !== expectedAmount || amountMinor(result.total_amount) !== order.saleAmountMinor
        || typeof result.trade_no !== "string" || !/^\d{8,64}$/.test(result.trade_no)) {
      throw new AppError(409, "refund_binding_mismatch", "退款查询结果与原退款单不一致");
    }
    return {status: "succeeded", providerRefundNo: result.trade_no};
  }

  async reconcileOne(): Promise<void> {
    const now=new Date(),candidate=this.repository.findDuePaymentOrder?.("alipay_page",now)??this.repository.listOrdersInternal().filter(x=>x.paymentStatus==="pending").find(order=>{
      const attempt=this.repository.findPaymentAttemptByOrder(order.merchantId,order.id);return attempt?.provider==="alipay_page"&&(!attempt.nextCheckAt||attempt.nextCheckAt<=now);
    });
    if (candidate) await this.reconcile(candidate.id);
  }

  private order(id: string): Order {
    const order = this.repository.findOrderInternal(id);
    if (!order || this.repository.findPaymentAttemptByOrder(order.merchantId, id)?.provider !== "alipay_page") {
      throw new AppError(404, "payment_not_found", "支付订单不存在");
    }
    return order;
  }

  private accept(order: Order, data: Record<string, string>): void {
    if (data.out_trade_no !== order.id || amountMinor(data.total_amount) !== order.saleAmountMinor
        || !/^\d{8,64}$/.test(data.trade_no ?? "")
        || (data.seller_id !== undefined && data.seller_id !== this.identity.sellerId)
        || (data.app_id !== undefined && data.app_id !== this.identity.appId)) {
      throw new AppError(409, "payment_binding_mismatch", "支付交易与平台订单不匹配");
    }
    if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(data.trade_status ?? "")) {
      this.payment.markPaid(order.merchantId, order.id, {channel: "alipay_page", providerRef: data.trade_no!,
        receivedMinor: order.saleAmountMinor});
    }
    // Browser return parameters and non-success provider statuses never mark paid.
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
