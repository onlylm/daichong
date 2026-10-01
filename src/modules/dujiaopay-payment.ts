import {createHash, randomUUID} from "node:crypto";
import {z} from "zod";
import type {Repository} from "../infra/repository.js";
import type {Order} from "../domain/model.js";
import type {CryptoPayment} from "../operations/model.js";
import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";
import {PaymentSettingsService} from "./payment-settings.js";
import {PaymentService} from "./payment-service.js";
import {USDT_NETWORKS, verifyDujiaoWebhook, type UsdtNetwork} from "./dujiaopay-client.js";

const idText = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const decimal = z.string().regex(/^(0|[1-9]\d{0,18})(\.\d{1,18})?$/);
const quoteSchema = z.object({order_id: idText, chain: z.string(), token_id: z.string(),
  pay_address: z.string().regex(/^[a-zA-Z0-9]{20,128}$/), payable_amount: decimal, expires_at: z.string().datetime({offset: true})});
const eventSchema = z.object({event_id: idText, event_type: z.string().max(80), event_version: z.literal("v1"),
  data: z.object({order_id: idText.optional(), merchant_order_id: idText.optional()}).passthrough()});
function units(value: unknown): bigint {
  if (!decimal.safeParse(value).success) return -1n;
  const [a = "0", b = ""] = (value as string).split(".");
  return BigInt(a) * 10n ** 18n + BigInt(b.padEnd(18, "0"));
}
function cny(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) return -1n;
  const [a = "0", b = ""] = value.split("."); return BigInt(a) * 100n + BigInt(b.padEnd(2, "0"));
}
export class DujiaoPaymentService {
  constructor(private readonly repo: Repository, private readonly settings: PaymentSettingsService, private readonly payment: PaymentService) {}
  private order(id: string): Order {
    const order = this.repo.findOrderInternal(id), attempt = order && this.repo.findPaymentAttemptByOrder(order.merchantId, id);
    if (!order || attempt?.provider !== "dujiaopay" || !attempt.paymentConfigId) throw new AppError(404, "payment_not_found", "支付订单不存在");
    return order;
  }
  status(id: string) {
    const order = this.order(id), p = this.repo.getOperations("crypto_payment", id);
    const paid = ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus);
    return {status: order.paymentStatus, payment_state: p?.state ?? "not_started", currency: "CNY", amount: minorToMoney(order.saleAmountMinor),
      // Never return keys, provider order IDs, provider checkout URLs or provider names.
      network: p ? USDT_NETWORKS[p.chain as UsdtNetwork].label : null, asset: "USDT",
      address: !paid && p?.state === "pending" && p.expiresAt > new Date() ? p.address : null,
      payable_amount: p?.payableAmount ?? null, expires_at: (p?.expiresAt ?? order.expiresAt).toISOString(),
      can_start: !p && order.paymentStatus === "pending" && order.expiresAt > new Date() && this.settings.available().includes("dujiaopay"),
      delivery_mode: order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge"),
      recharge_url: ["paid", "partially_refunded"].includes(order.paymentStatus) ? order.fulfillmentUrl : null};
  }
  async start(id: string): Promise<ReturnType<DujiaoPaymentService["status"]>> {
    this.repo.transaction(() => {
      const order = this.order(id);
      if (this.repo.getOperations("crypto_payment", id)) return;
      this.settings.assertOpen("dujiaopay");
      if (order.paymentStatus !== "pending" || order.expiresAt <= new Date()) throw new AppError(409, "payment_not_available", "订单已过期或不可付款");
      const attempt = this.repo.findPaymentAttemptByOrder(order.merchantId, id)!;
      const r = this.settings.revision(attempt.paymentConfigId!, "dujiaopay");
      const now = new Date();
      this.repo.saveOperations("crypto_payment", {id, merchantId: order.merchantId, orderId: id, revisionId: r.id,
        providerOrderId: null, state: "creating", address: null, payableAmount: null, chain: r.details.network!, tokenId: r.details.tokenId!,
        expiresAt: order.expiresAt, nextCheckAt: now, leaseUntil: null, leaseToken: null, createdAt: now, updatedAt: now, failureCode: null}, true);
    });
    await this.reconcile(id);
    return this.status(id);
  }
  async reconcile(id: string): Promise<void> {
    const claim = this.repo.transaction(() => {
      const order = this.order(id), p = this.repo.getOperations("crypto_payment", id);
      if (!p || order.paymentStatus !== "pending" || p.state === "paid" || p.nextCheckAt > new Date() || (p.leaseUntil && p.leaseUntil > new Date())) return null;
      // Do not create a new provider invoice once the original local intent has expired.
      if (!p.providerOrderId && order.expiresAt <= new Date()) {
        this.repo.saveOperations("crypto_payment", {...p, state: "review", failureCode: "creation_result_unknown", nextCheckAt: new Date(Date.now() + 3600_000)});
        return null;
      }
      const locked = {...p, leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000), nextCheckAt: new Date(Date.now() + 60_000)};
      this.repo.saveOperations("crypto_payment", locked);
      return {order, p: locked};
    });
    if (!claim) return;
    const {order, p} = claim, r = this.settings.revision(p.revisionId, "dujiaopay");
    try {
      const client = this.settings.client(r);
      let providerId = p.providerOrderId;
      if (!providerId) {
        const response = await client.createOrder({merchant_order_id: order.id, fiat_currency: "CNY", fiat_amount: minorToMoney(order.saleAmountMinor), chain: p.chain, token_id: p.tokenId});
        const q = quoteSchema.parse(response);
        if (q.chain !== p.chain || q.token_id !== p.tokenId || units(q.payable_amount) <= 0n) throw new Error("invalid_quote");
        providerId = q.order_id;
        this.repo.transaction(() => {
          const latest = this.owned(p); if (!latest) return;
          this.repo.saveOperations("crypto_payment", {...latest, providerOrderId: q.order_id, address: q.pay_address,
            payableAmount: q.payable_amount, expiresAt: new Date(q.expires_at), updatedAt: new Date()});
        });
      }
      const result = await client.getOrder(providerId);
      this.repo.transaction(() => {
        const current = this.owned(p); if (!current) return;
        this.accept(order, current, result);
      });
    } catch {
      this.repo.transaction(() => {
        const current = this.owned(p); if (!current) return;
        this.repo.saveOperations("crypto_payment", {...current, failureCode: "verification_pending", leaseToken: null, leaseUntil: null, updatedAt: new Date()});
      });
      throw new AppError(503, "payment_query_pending", "支付结果暂未确认，请稍后核对原订单，不要重复付款", true);
    }
  }
  private owned(p: CryptoPayment): CryptoPayment | null {
    const current = this.repo.getOperations("crypto_payment", p.id);
    return current?.leaseToken === p.leaseToken ? current : null;
  }
  private accept(order: Order, p: CryptoPayment, data: Record<string, unknown>): void {
    const q = quoteSchema.parse(data);
    if (q.order_id !== p.providerOrderId || data.merchant_order_id !== order.id || q.chain !== p.chain || q.token_id !== p.tokenId
        || data.fiat_currency !== "CNY" || cny(data.fiat_amount) !== order.saleAmountMinor || units(q.payable_amount) <= 0n
        || (p.address && q.pay_address !== p.address) || (p.payableAmount && units(q.payable_amount) !== units(p.payableAmount))) {
      this.review(p, "payment_binding_mismatch"); return;
    }
    const normalized: CryptoPayment = {...p, address: q.pay_address, payableAmount: q.payable_amount, expiresAt: new Date(q.expires_at),
      leaseToken: null, leaseUntil: null, updatedAt: new Date(), failureCode: null};
    if (data.status !== "paid") {
      if (!["pending", "confirming", "expired", "canceled"].includes(String(data.status))) {this.review(p, "unknown_payment_status"); return;}
      // Confirming can return to pending on reorg; it is never an entitlement.
      this.repo.saveOperations("crypto_payment", {...normalized, state: data.status === "expired" ? "expired" : data.status === "canceled" ? "canceled" : "pending"});
      return;
    }
    const tx = typeof data.tx_hash === "string" ? data.tx_hash : "";
    const paidTime = typeof data.paid_at === "string" ? Date.parse(data.paid_at) : NaN;
    const minConfirmations = USDT_NETWORKS[p.chain as UsdtNetwork].confirmations;
    if (data.paid_source !== "chain" || !/^[a-zA-Z0-9]{32,160}$/.test(tx)
        || !Number.isSafeInteger(data.confirmations) || Number(data.confirmations) < minConfirmations
        || units(data.settled_amount) !== units(q.payable_amount) || !Number.isFinite(paidTime)
        || paidTime < p.createdAt.getTime() - 300_000 || paidTime > Date.now() + 300_000 || paidTime > normalized.expiresAt.getTime()
        || units(data.fx_rate) <= 0n) {
      this.review(normalized, "payment_requires_review"); return;
    }
    const normalizedTx = p.chain === "solana" ? tx : tx.toLowerCase();
    const txKey = createHash("sha256").update(p.chain + ":" + normalizedTx).digest("hex");
    const used = this.repo.getOperations("crypto_transaction", txKey);
    if (used && used.orderId !== order.id) {this.review(normalized, "transaction_reused"); return;}
    if (!used) this.repo.saveOperations("crypto_transaction", {id: txKey, merchantId: null, chain: p.chain, txHash: normalizedTx, orderId: order.id, createdAt: new Date()}, true);
    // Ledger remains CNY; on-chain amount and FX evidence are stored separately.
    this.payment.markPaid(order.merchantId, order.id, {channel: "dujiaopay", providerRef: "usdt:" + p.chain + ":" + normalizedTx, receivedMinor: order.saleAmountMinor});
    this.repo.saveOperations("crypto_payment", {...normalized, state: "paid", paidSource: "chain", txHash: normalizedTx,
      settledAmount: data.settled_amount as string, fxRate: data.fx_rate as string});
  }
  private review(p: CryptoPayment, code: string): void {
    this.repo.saveOperations("crypto_payment", {...p, state: "review", failureCode: code, leaseToken: null, leaseUntil: null, updatedAt: new Date()});
  }
  receiveWebhook(revisionId: string, headers: {id: string; timestamp: string; signature: string}, raw: Buffer): void {
    const r = this.settings.revision(revisionId, "dujiaopay");
    if (!verifyDujiaoWebhook(this.settings.secrets(r).webhookSecret!, headers.timestamp, headers.signature, raw)) throw new AppError(400, "invalid_payment_notification", "支付通知验证失败");
    const event = eventSchema.parse(JSON.parse(raw.toString("utf8")));
    if (headers.id !== event.event_id) throw new AppError(400, "invalid_payment_notification", "支付通知编号不一致");
    const eventKey = createHash("sha256").update(r.details.merchantId + ":" + r.details.projectId + ":" + event.event_id).digest("hex");
    const digest = createHash("sha256").update(raw).digest("hex");
    this.repo.transaction(() => {
      const old = this.repo.getOperations("payment_event", eventKey);
      if (old) {
        if (old.digest !== digest) throw new AppError(409, "payment_event_conflict", "支付通知内容冲突");
        return;
      }
      const orderId = event.data.merchant_order_id ?? null;
      const p = orderId ? this.repo.getOperations("crypto_payment", orderId) : null;
      if (p) {
        const bound = this.settings.revision(p.revisionId, "dujiaopay");
        if (bound.details.merchantId !== r.details.merchantId || bound.details.projectId !== r.details.projectId
            || (p.providerOrderId && event.data.order_id !== p.providerOrderId)) throw new AppError(400, "payment_binding_mismatch", "支付通知与订单不匹配");
        // A signed event can recover a timed-out creation. It cannot mark an order paid.
        if (!p.providerOrderId && event.data.order_id) this.repo.saveOperations("crypto_payment",
          {...p, providerOrderId: event.data.order_id, nextCheckAt: new Date(), updatedAt: new Date()});
      }
      this.repo.saveOperations("payment_event", {id: eventKey, merchantId: p?.merchantId ?? null, revisionId,
        eventId: event.event_id, digest, orderId, createdAt: new Date()}, true);
    });
  }
  async reconcileOne(): Promise<void> {
    const p = this.repo.listOperations("crypto_payment").filter(p => p.state !== "paid" && p.nextCheckAt <= new Date()
      && (!p.leaseUntil || p.leaseUntil <= new Date()) && this.repo.findOrderInternal(p.orderId)?.paymentStatus === "pending")
      .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime())[0];
    if (p) await this.reconcile(p.orderId);
  }
}
