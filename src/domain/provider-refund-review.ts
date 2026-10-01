import type {Repository} from "../infra/repository.js";
import {queryRecords} from "../infra/record-query.js";

/**
 * A cumulative provider refund is only a signal that money moved. Until it is
 * bound to an exact refund request, fulfillment must pause without changing
 * the order's accounting state. The ticket remains the durable audit trail.
 */
export function hasUnreconciledProviderRefund(repository: Repository, merchantId: string, orderId: string): boolean {
  const prefix = `refund-reconcile:${orderId}:`;
  const order = repository.findOrder(merchantId, orderId);
  if (!order) return false;
  const recorded = order.ordinaryRefundedMinor + order.priceAdjustmentRefundedMinor;
  return queryRecords(repository, "ticket", {
    merchantId,
    limit: 100,
    count: false,
    filters: [
      {field: "orderId", value: orderId},
      {field: "category", value: "refund"},
      {field: "createdBy", value: "system"},
    ],
  }).data.some(ticket => {
    const key = ticket.systemCase?.issueKey ?? "";
    if (!key.startsWith(prefix)) return false;
    const reported = key.slice(prefix.length);
    return /^\d+$/.test(reported) && BigInt(reported) > recorded;
  });
}
