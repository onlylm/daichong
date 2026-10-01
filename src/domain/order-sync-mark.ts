import type {Fulfillment, Order, PaymentStatus} from "./model.js";

/** Partner-visible sync mark for closed recharge outcomes. */
export type OrderSyncMark = "cancelled_refunded";

type FulfillmentMarkInput = Pick<Fulfillment, "status" | "failureCode"> | null | undefined;

export function isAgentRechargeCancelled(fulfillment: FulfillmentMarkInput): boolean {
  if (!fulfillment) return false;
  if (fulfillment.status === "cancelled") return true;
  return fulfillment.status === "failed" && fulfillment.failureCode === "agent_cancelled";
}

/**
 * Derived mark for partner sync: recharge was cancelled (or agent-abandoned)
 * and the order has been refunded (full or partial).
 */
export function orderSyncMark(
  paymentStatus: PaymentStatus,
  fulfillment: FulfillmentMarkInput,
): OrderSyncMark | null {
  if (paymentStatus !== "refunded" && paymentStatus !== "partially_refunded") return null;
  return isAgentRechargeCancelled(fulfillment) ? "cancelled_refunded" : null;
}

export function latestFulfillmentOf(list: readonly Fulfillment[]): Fulfillment | null {
  return list.length ? list[list.length - 1]! : null;
}
