import type { Order } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError, notFound } from "../domain/errors.js";
import { assertPaymentTransition } from "../domain/state-machines.js";
import { LedgerService } from "./ledger-service.js";
import { WebhookService } from "./webhook-service.js";
import {hasConfirmedOrderPayment} from "../domain/payment-confirmation.js";

export interface PaymentCreation {
  channel?: import("../operations/model.js").PaymentChannel;
  paymentConfigId?: string;
  providerRef: string;
  qrPayload: string;
  expiresAt: Date;
}

export interface PaymentProvider {
  /** 支付提供方实例由 Quefa 平台统一构造，绝不能按代理商注入或配置。 */
  readonly ownership: "quefa_platform";
  readonly name: string;
  create(orderId: string, amountMinor: bigint, expiresAt: Date, channel?: import("../operations/model.js").PaymentChannel): Promise<PaymentCreation>;
  validateCreation?(creation: PaymentCreation): void;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly ownership = "quefa_platform" as const;
  readonly name = "mock";
  constructor(private readonly publicBaseUrl: string) {}
  async create(orderId: string, _amountMinor: bigint, expiresAt: Date): Promise<PaymentCreation> {
    return {providerRef: `mock_pay_${orderId}`, qrPayload: `${this.publicBaseUrl}/sandbox/pay/${orderId}`, expiresAt};
  }
}

export class PaymentService {
  constructor(
    private readonly repository: Repository,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookService,
    private readonly onConfirmedPayment?: (orderId: string) => void,
  ) {}

  markPaid(merchantId: string, orderId: string, input: {providerRef: string; receivedMinor: bigint; feeMinor?: bigint; channel?: "mock" | "alipay_page" | "dujiaopay"}): Order {
    return this.repository.transaction(() => this.markPaidLocked(merchantId, orderId, input));
  }

  markClosed(merchantId: string, orderId: string, provider: string): Order {
    return this.repository.transaction(() => {
      const order = this.repository.findOrder(merchantId, orderId);
      if (!order) throw notFound("order");
      const attempt = this.repository.findPaymentAttemptByOrder(merchantId, orderId);
      if (!attempt || attempt.provider !== provider) throw new AppError(409, "payment_channel_mismatch", "不允许跨支付渠道关闭订单");
      if (order.paymentStatus === "closed") return order;
      if (order.paymentStatus !== "pending") return order;
      assertPaymentTransition(order.paymentStatus, "closed");
      const now = new Date(), closed = {...order, paymentStatus: "closed" as const, updatedAt: now};
      this.repository.updateOrder(closed);
      const {nextCheckAt: _nextCheckAt, ...closedAttempt} = attempt;
      this.repository.updatePaymentAttempt({...closedAttempt, status: "closed", updatedAt: now});
      this.webhooks.emit(merchantId, `${orderId}:order.closed`, "order.closed", orderId,
        {event: "order.closed", order_id: orderId, merchant_order_no: order.merchantOrderNo});
      return closed;
    });
  }

  markExpired(merchantId: string, orderId: string, provider: string): Order {
    return this.repository.transaction(() => {
      const order=this.repository.findOrder(merchantId,orderId);
      if(!order)throw notFound("order");
      const attempt=this.repository.findPaymentAttemptByOrder(merchantId,orderId);
      if(!attempt||attempt.provider!==provider)throw new AppError(409,"payment_channel_mismatch","不允许跨支付渠道标记订单过期");
      if(order.paymentStatus==="expired")return order;
      if(order.paymentStatus!=="pending")return order;
      if(order.expiresAt>new Date())throw new AppError(409,"payment_not_expired","付款窗口尚未结束");
      assertPaymentTransition(order.paymentStatus,"expired");
      const now=new Date(),expired={...order,paymentStatus:"expired" as const,updatedAt:now};
      this.repository.updateOrder(expired);
      const {nextCheckAt:_nextCheckAt,precreateLeaseToken:_lease,precreateLeaseUntil:_leaseUntil,...rest}=attempt;
      this.repository.updatePaymentAttempt({...rest,status:"expired",updatedAt:now});
      this.webhooks.emit(merchantId,`${orderId}:order.expired`,"order.expired",orderId,
        {event:"order.expired",order_id:orderId,merchant_order_no:order.merchantOrderNo});
      return expired;
    });
  }

  private markPaidLocked(merchantId: string, orderId: string, input: {providerRef: string; receivedMinor: bigint; feeMinor?: bigint; channel?: "mock" | "alipay_page" | "dujiaopay"}): Order {
    const order = this.repository.findOrder(merchantId, orderId);
    if (!order) throw notFound("order");
    const attempt = this.repository.findPaymentAttemptByOrder(merchantId, orderId);
    if (attempt?.provider !== (input.channel ?? "mock")) throw new AppError(409, "payment_channel_mismatch", "不允许跨支付渠道确认付款");
    if (input.receivedMinor !== order.saleAmountMinor) {
      throw new AppError(409, "payment_amount_mismatch", "支付渠道金额与订单金额不一致");
    }
    if (["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)) {
      if (order.paymentProviderRef !== input.providerRef) throw new AppError(409, "payment_reference_mismatch", "支付流水不匹配");
      if (order.paymentStatus === "refunded" || attempt?.status === "refunded" || hasConfirmedOrderPayment(order, attempt)) return order;
      const provisionalAlipayRef = attempt?.provider === "alipay_page" && attempt.providerRef === order.id;
      if (!attempt || (attempt.providerRef && attempt.providerRef !== input.providerRef && !provisionalAlipayRef)
          || (attempt.receivedMinor !== null && attempt.receivedMinor !== input.receivedMinor))
        throw new AppError(409, "payment_attempt_conflict", "支付尝试记录与已确认的渠道流水冲突，须人工核对");
      const paidAt = attempt.paidAt ?? order.paidAt;
      if (!paidAt) throw new AppError(409, "payment_time_unconfirmed", "原付款时间尚未确认，须人工核对");
      this.repository.updatePaymentAttempt({...attempt, status: "paid", providerRef: input.providerRef,
        receivedMinor: input.receivedMinor, feeMinor: attempt.feeMinor ?? input.feeMinor ?? order.paymentFeeMinor ?? 0n,
        paidAt, updatedAt: new Date()});
      this.onConfirmedPayment?.(order.id);
      return order;
    }
    if (attempt?.status === "refunded" || (attempt?.status === "paid" && attempt.providerRef
        && attempt.providerRef !== input.providerRef && !(attempt.provider === "alipay_page" && attempt.providerRef === order.id))
        || (attempt && attempt.receivedMinor !== null && attempt.receivedMinor !== input.receivedMinor))
      throw new AppError(409, "payment_attempt_conflict", "支付尝试记录与已确认的渠道流水冲突，须人工核对");
    assertPaymentTransition(order.paymentStatus, "paid");
    const paid: Order = {
      ...order,
      paymentStatus: "paid",
      paymentProviderRef: input.providerRef,
      paymentReceivedMinor: input.receivedMinor,
      paymentFeeMinor: input.feeMinor ?? 0n,
      paidAt: new Date(),
      updatedAt: new Date(),
    };
    this.repository.updateOrder(paid);
    if (attempt) {
      this.repository.updatePaymentAttempt({
        ...attempt,
        status: "paid",
        providerRef: input.providerRef,
        receivedMinor: input.receivedMinor,
        feeMinor: input.feeMinor ?? 0n,
        paidAt: paid.paidAt,
        updatedAt: paid.updatedAt,
      });
    }
    this.ledger.recordPayment(paid);
    this.webhooks.emit(merchantId, `${orderId}:order.paid`, "order.paid", orderId, {event: "order.paid", order_id: orderId, merchant_order_no: order.merchantOrderNo});
    this.onConfirmedPayment?.(order.id);
    return paid;
  }
}
