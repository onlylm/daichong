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

/**
 * Protects only earnings that have already been released. A provider refund
 * discrepancy on an unpaid/unfulfilled order must not freeze unrelated funds.
 */
export function hasUnreconciledProviderRefundForReleasedEarnings(
  repository: Repository,
  merchantId: string,
  orderIds?: readonly string[],
): boolean {
  if (repository.hasUnreconciledProviderRefundForReleasedEarnings) {
    return repository.hasUnreconciledProviderRefundForReleasedEarnings(merchantId, orderIds);
  }
  const scoped = orderIds ? new Set(orderIds) : null;
  if (scoped?.size === 0) return false;
  return repository.listOperations("wallet_credit", merchantId)
    .some(credit => credit.recognizedMinor > 0n && (!scoped || scoped.has(credit.orderId))
      && hasUnreconciledProviderRefund(repository, merchantId, credit.orderId));
}

export function refundReconciliationId(orderId: string): string {
  return `refund-reconciliation:${orderId}`;
}
