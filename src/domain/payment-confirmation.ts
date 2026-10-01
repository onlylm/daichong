import type {Order, PaymentAttempt} from "./model.js";

/** Order status alone is not evidence that the corresponding collection was confirmed. */
export function hasConfirmedOrderPayment(order: Order, attempt: PaymentAttempt | null): boolean {
  const expected = order.collectionMode === "agent_collect" ? order.supplyAmountMinor : order.saleAmountMinor;
  return !!attempt && attempt.status === "paid" && attempt.receivedMinor === expected
    && !!attempt.providerRef && attempt.providerRef === order.paymentProviderRef && !!attempt.paidAt;
}
