import type {Repository} from "../infra/repository.js";

export function normalizePayoutReference(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * One external payout can settle exactly one platform obligation. Call this
 * from inside the same repository transaction that records the payout.
 */
export function findPayoutReferenceUsage(repository: Repository, reference: string) {
  const normalized = normalizePayoutReference(reference);
  if (repository.findPayoutReferenceUsage) return repository.findPayoutReferenceUsage(normalized);
  const statement = repository.listOperations("daily_settlement")
    .find(item => item.payoutReference && normalizePayoutReference(item.payoutReference) === normalized);
  if (statement) return {kind: "daily_settlement" as const, id: statement.id};
  const withdrawal = repository.listOperations("wallet_withdrawal")
    .find(item => item.payoutReference && normalizePayoutReference(item.payoutReference) === normalized);
  return withdrawal ? {kind: "wallet_withdrawal" as const, id: withdrawal.id} : null;
}
