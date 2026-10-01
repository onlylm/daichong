import type { FulfillmentStatus, PaymentStatus, RefundStatus, SettlementStatus } from "./model.js";
import { AppError } from "./errors.js";

const paymentTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["paid", "expired", "closed"],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["partially_refunded", "refunded"],
  // A verified provider notification may arrive after the local checkout
  // window was marked expired. Real money received must still be recorded.
  expired: ["paid"],
  closed: [],
  refunded: [],
};

const fulfillmentTransitions: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const refundTransitions: Record<RefundStatus, readonly RefundStatus[]> = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["processing"],
  processing: ["processing", "succeeded", "failed"],
  failed: ["approved", "cancelled"],
  succeeded: [],
  rejected: [],
  cancelled: [],
};

const settlementTransitions: Record<SettlementStatus, readonly SettlementStatus[]> = {
  draft: ["reviewing", "cancelled"],
  reviewing: ["confirmed", "cancelled"],
  confirmed: ["paying"],
  paying: ["paid", "failed"],
  failed: ["paying"],
  paid: [],
  cancelled: [],
};

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  assertTransition("payment", from, to, paymentTransitions[from]);
}

export function assertFulfillmentTransition(from: FulfillmentStatus, to: FulfillmentStatus): void {
  assertTransition("fulfillment", from, to, fulfillmentTransitions[from]);
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  assertTransition("refund", from, to, refundTransitions[from]);
}

export function assertSettlementTransition(from: SettlementStatus, to: SettlementStatus): void {
  assertTransition("settlement", from, to, settlementTransitions[from]);
}

function assertTransition(kind: string, from: string, to: string, allowed: readonly string[]): void {
  if (!allowed.includes(to)) {
    throw new AppError(409, "invalid_state_transition", `${kind} 不允许从 ${from} 转换到 ${to}`);
  }
}
