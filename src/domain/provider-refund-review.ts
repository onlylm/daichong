import type {Repository} from "../infra/repository.js";

/**
 * Business lock source for an unbound cumulative provider refund. Support
 * tickets are deliberately excluded: finance state must survive ticket
 * closure, archival and communication workflows independently.
 */
export function hasUnreconciledProviderRefund(repository: Repository, merchantId: string, orderId: string): boolean {
  const value = repository.getOperations("refund_reconciliation", refundReconciliationId(orderId));
  return Boolean(value && value.merchantId === merchantId && value.status === "reviewing" && value.differenceMinor > 0n);
}

export function refundReconciliationId(orderId: string): string {
  return `refund-reconciliation:${orderId}`;
}
