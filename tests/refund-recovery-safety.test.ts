import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Fulfillment, Order, Refund} from "../src/domain/model.js";
import type {Repository} from "../src/infra/repository.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {SqliteRepository} from "../src/infra/sqlite-repository.js";
import {LedgerService} from "../src/modules/ledger-service.js";
import {WebhookService} from "../src/modules/webhook-service.js";
import {RefundService, type RefundExecutor} from "../src/modules/refund-service.js";
import type {Actor} from "../src/operations/model.js";

const admin: Actor = {id: "admin", merchantId: null, role: "platform_admin"};
type QueryResult = Awaited<ReturnType<NonNullable<RefundExecutor["query"]>>>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function service(repo: Repository, executor: RefundExecutor) {
  return new RefundService(repo, new LedgerService(repo), new WebhookService(repo), executor);
}
function seed(repo: Repository, changes: Partial<Refund> = {}) {
  const now = new Date();
  const order: Order = {id: "order", merchantId: "merchant", appId: "app", merchantOrderNo: "order-no",
    collectionMode: "platform_collect", deliveryMode: "auto_recharge", productCode: "product", quantity: 1,
    saleAmountMinor: 13500n, supplyAmountMinor: 11000n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
    currency: "CNY", paymentStatus: "paid", metadata: {}, paymentProviderRef: "2026100200000001",
    paymentReceivedMinor: 13500n, paymentFeeMinor: 0n, qrPayload: null, qrImageUrl: null,
    fulfillmentMode: "direct", upstreamProduct: "gpt", upstreamPlan: "plus", fulfillmentUrl: "https://example.test/fulfill",
    voucherCode: null, settlementId: null, paidAt: now, expiresAt: now, createdAt: now, updatedAt: now};
  repo.insertOrder(order);
  repo.insertPaymentAttempt({id: "payment", merchantId: order.merchantId, orderId: order.id, provider: "alipay_page",
    status: "paid", providerRef: order.paymentProviderRef, requestedMinor: 13500n, receivedMinor: 13500n,
    feeMinor: 0n, qrPayload: null, expiresAt: now, paidAt: now, createdAt: now, updatedAt: now});
  const refund: Refund = {id: "refund", merchantId: order.merchantId, orderId: order.id, merchantRefundNo: "refund-no",
    type: "full", amountMinor: 13500n, status: "processing", reason: "充值失败退款", failureCode: "refund_result_unknown",
    providerRefundNo: null, nextCheckAt: now, recoveryAttempts: 0, createdAt: now, refundedAt: null, ...changes};
  repo.insertRefund(refund);
  return {order, refund};
}
function addFulfillment(repo: Repository, status: Fulfillment["status"], leased = false) {
  const now = new Date();
  repo.insertFulfillment({id: "fulfillment", merchantId: "merchant", orderId: "order", attemptNo: 1, status,
    failureCode: null, message: null, accountEmailMasked: null,
    sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: now},
    mode: "direct", voucherId: null, upstreamProvider: "supplier", upstreamOrderId: "supplier-order",
    upstreamClientRequestId: "fulfillment", upstreamLookupToken: null, upstreamStatus: leased ? "failed_precharge" : null,
    upstreamStage: null, upstreamQuoteMinor: null, upstreamCurrency: null, nextCheckAt: now,
    leaseToken: leased ? "active-fulfillment" : null, leaseUntil: leased ? new Date(now.getTime() + 60000) : null,
    createdAt: now, finishedAt: status === "succeeded" || status === "failed" ? now : null});
}
function addManualCompletion(repo: Repository) {
  const now = new Date();
  repo.saveOperations("manual_completion", {id: "order", merchantId: "merchant", orderId: "order", fulfillmentId: "manual",
    completedAt: now, externalOrderRef: "verified-manual", evidence: "verified-evidence", reason: "人工充值完成",
    actorId: admin.id, createdAt: now});
}

for (const driver of ["memory", "sqlite"] as const) describe(`refund execution ownership (${driver})`, () => {
  let repo: Repository;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    repo = driver === "memory" ? new MemoryRepository() : new SqliteRepository(":memory:");
  });
  afterEach(() => { repo.close?.(); vi.useRealTimers(); });

  it("does not approve a failed refund while a channel-evidence review owns its lease", async () => {
    const {refund} = seed(repo, {status: "failed", leaseToken: "review", leaseUntil: new Date(Date.now() + 60000)});
    const execute = vi.fn(async () => "2026100200000001");
    await expect(service(repo, {providerFor: () => "alipay_page", execute}).approve(admin, refund.id))
      .rejects.toMatchObject({code: "refund_review_in_progress"});
    expect(execute).not.toHaveBeenCalled();
    expect(repo.findRefund("merchant", "refund")).toEqual(refund);
  });

  it.each(["succeeded", "running", "failed", "leased", "manual"] as const)(
    "rechecks %s fulfillment after the query and prevents another ordinary refund submission", async state => {
      seed(repo);
      const query = deferred<QueryResult>(), execute = vi.fn(async () => "2026100200000001");
      const recovery = service(repo, {providerFor: () => "alipay_page", execute, query: () => query.promise}).reconcileOne();
      if (state === "manual") addManualCompletion(repo);
      else addFulfillment(repo, state === "leased" ? "failed" : state, state === "leased");
      query.resolve({status: "not_confirmed"}); await recovery;
      expect(execute).not.toHaveBeenCalled();
      expect(repo.findRefund("merchant", "refund")).toMatchObject({status: "processing", recoveryAttempts: 0,
        failureCode: "refund_manual_review", leaseToken: null, leaseUntil: null});
    });

  it("allows a legitimate partial price adjustment after fulfillment succeeded", async () => {
    seed(repo, {type: "price_adjustment", amountMinor: 500n}); addFulfillment(repo, "succeeded"); addManualCompletion(repo);
    const execute = vi.fn(async () => "2026100200000001");
    await service(repo, {providerFor: () => "alipay_page", execute,
      query: async () => ({status: "not_confirmed"})}).reconcileOne();
    expect(execute).toHaveBeenCalledWith("order", expect.objectContaining({id: "refund", amountMinor: 500n,
      recoveryAttempts: 1, leaseToken: expect.any(String), lastSubmittedAt: expect.any(String)}));
    expect(repo.findOrderInternal("order")).toMatchObject({ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 500n});
    expect(repo.findRefund("merchant", "refund")).toMatchObject({status: "succeeded", nextCheckAt: null,
      leaseToken: null, leaseUntil: null});
  });

  it("records confirmed query success even after fulfillment has completed", async () => {
    seed(repo); addFulfillment(repo, "succeeded"); addManualCompletion(repo);
    const execute = vi.fn(async () => "must-not-submit");
    await service(repo, {providerFor: () => "alipay_page", execute,
      query: async () => ({status: "succeeded", providerRefundNo: "2026100200000001"})}).reconcileOne();
    expect(execute).not.toHaveBeenCalled();
    expect(repo.findOrderInternal("order")).toMatchObject({paymentStatus: "refunded", ordinaryRefundedMinor: 13500n});
    expect(repo.listOutbox("merchant").filter(value => value.eventType === "refund.succeeded")).toHaveLength(1);
  });

  it.each(["cancelled", "succeeded"] as const)("does not overwrite a newer %s state with an old unknown query", async status => {
    seed(repo, {recoveryAttempts: 3});
    const query = deferred<QueryResult>(), execute = vi.fn(async () => "must-not-submit");
    const recovery = service(repo, {providerFor: () => "alipay_page", execute, query: () => query.promise}).reconcileOne();
    const latest = repo.findRefund("merchant", "refund")!;
    const newer = {...latest, status, failureCode: "newer-evidence", nextCheckAt: null, leaseToken: null, leaseUntil: null};
    repo.updateRefund(newer); query.resolve({status: "not_confirmed"}); await recovery;
    expect(execute).not.toHaveBeenCalled(); expect(repo.findRefund("merchant", "refund")).toEqual(newer);
  });

  it("keeps late successful execution after a local closure and records it only once", async () => {
    seed(repo, {status: "requested"});
    const execution = deferred<string>(), execute = vi.fn(() => execution.promise);
    const refunds = service(repo, {providerFor: () => "alipay_page", execute});
    const approving = refunds.approve(admin, "refund");
    const submitted = repo.findRefund("merchant", "refund")!;
    expect(submitted.lastSubmittedAt).toBe(new Date().toISOString());
    repo.updateRefund({...submitted, status: "cancelled", leaseToken: null, leaseUntil: null, nextCheckAt: null});
    addManualCompletion(repo); execution.resolve("2026100200000001");
    expect(await approving).toMatchObject({status: "succeeded", leaseToken: null, leaseUntil: null, nextCheckAt: null});
    const ledgerCount = repo.listLedger("merchant").length;
    await refunds.approve(admin, "refund");
    expect(execute).toHaveBeenCalledOnce(); expect(repo.listLedger("merchant")).toHaveLength(ledgerCount);
    expect(repo.findOrderInternal("order")?.ordinaryRefundedMinor).toBe(13500n);
  });

  it("does not release another worker's lease after an old approval errors", async () => {
    seed(repo, {status: "requested"});
    const execution = deferred<string>();
    const approving = service(repo, {providerFor: () => "alipay_page", execute: () => execution.promise}).approve(admin, "refund");
    const next = {...repo.findRefund("merchant", "refund")!, leaseToken: "new-owner", failureCode: "newer-query"};
    repo.updateRefund(next); execution.reject(new Error("old network timeout")); await approving;
    expect(repo.findRefund("merchant", "refund")).toEqual(next);
  });
});

describe("refund recovery across two SQLite connections", () => {
  let directory: string, first: SqliteRepository, second: SqliteRepository;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    directory = mkdtempSync(join(tmpdir(), "quefa-refund-recovery-"));
    const path = join(directory, "state.sqlite"); first = new SqliteRepository(path); second = new SqliteRepository(path);
  });
  afterEach(() => { first.close(); second.close(); rmSync(directory, {recursive: true, force: true}); vi.useRealTimers(); });

  it("lets only the new lease owner execute when query leases overlap", async () => {
    seed(first);
    const oldQuery = deferred<QueryResult>(), newQuery = deferred<QueryResult>();
    const oldExecute = vi.fn(async () => "must-not-submit"), newExecute = vi.fn(async () => "2026100200000001");
    const oldWorker = service(first, {providerFor: () => "alipay_page", execute: oldExecute, query: () => oldQuery.promise});
    const querySecond = vi.fn(() => newQuery.promise);
    const newWorker = service(second, {providerFor: () => "alipay_page", execute: newExecute, query: querySecond});
    const oldRun = oldWorker.reconcileOne(), oldToken = first.findRefund("merchant", "refund")!.leaseToken;
    await newWorker.reconcileOne(); expect(querySecond).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.now() + 60001));
    const newRun = newWorker.reconcileOne(), newClaim = second.findRefund("merchant", "refund")!;
    expect(newClaim.leaseToken).not.toBe(oldToken); expect(newClaim.leaseUntil).toBeInstanceOf(Date);
    oldQuery.resolve({status: "not_confirmed"}); await oldRun;
    expect(oldExecute).not.toHaveBeenCalled(); expect(first.findRefund("merchant", "refund")).toEqual(newClaim);
    newQuery.resolve({status: "not_confirmed"}); await newRun;
    expect(newExecute).toHaveBeenCalledOnce();
    expect(first.findOrderInternal("order")?.ordinaryRefundedMinor).toBe(13500n);
    expect(first.listOutbox("merchant").filter(value => value.eventType === "refund.succeeded")).toHaveLength(1);
  });

  it("books a late true success and prevents the newer query from resubmitting or overwriting it", async () => {
    seed(first);
    const oldQuery = deferred<QueryResult>(), newQuery = deferred<QueryResult>(), execute = vi.fn(async () => "must-not-submit");
    const oldRun = service(first, {providerFor: () => "alipay_page", execute, query: () => oldQuery.promise}).reconcileOne();
    vi.setSystemTime(new Date(Date.now() + 60001));
    const newRun = service(second, {providerFor: () => "alipay_page", execute, query: () => newQuery.promise}).reconcileOne();
    addFulfillment(second, "succeeded");
    oldQuery.resolve({status: "succeeded", providerRefundNo: "2026100200000001"}); await oldRun;
    const completed = first.findRefund("merchant", "refund");
    expect(completed).toMatchObject({status: "succeeded", leaseToken: null, leaseUntil: null, nextCheckAt: null});
    newQuery.reject(new Error("new query timeout")); await newRun;
    expect(execute).not.toHaveBeenCalled(); expect(second.findRefund("merchant", "refund")).toEqual(completed);
    expect(second.findOrderInternal("order")?.ordinaryRefundedMinor).toBe(13500n);
  });
});
