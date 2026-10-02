import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Order} from "../src/domain/model.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";
import type {Repository} from "../src/infra/repository.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {SqliteRepository} from "../src/infra/sqlite-repository.js";
import {AlipayPagePaymentProvider, AlipayPaymentService, type AlipayClient} from "../src/modules/alipay-payment.js";
import {ManagedAlipayService} from "../src/modules/managed-payment.js";
import {LedgerService} from "../src/modules/ledger-service.js";
import {PaymentService} from "../src/modules/payment-service.js";
import type {PaymentSettingsService} from "../src/modules/payment-settings.js";
import {PortalTokenService} from "../src/modules/portal-token.js";
import {RefundService} from "../src/modules/refund-service.js";
import {RefundReconciliationService} from "../src/modules/refund-reconciliation-service.js";
import {WebhookService} from "../src/modules/webhook-service.js";

const tradeNo = "2026100200000001";
const base = "https://payments.example.test";
const identity = {appId: "test-app", sellerId: "2088000000000000"};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

function seed(repo: Repository, changes: Partial<Order> = {}) {
  const now = new Date();
  const order: Order = {id: "order", merchantId: "merchant", appId: "app", merchantOrderNo: "order-no",
    collectionMode: "platform_collect", deliveryMode: "auto_recharge", productCode: "product", quantity: 1,
    saleAmountMinor: 13500n, supplyAmountMinor: 11000n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
    currency: "CNY", paymentStatus: "paid", metadata: {}, paymentProviderRef: tradeNo,
    paymentReceivedMinor: 13500n, paymentFeeMinor: 0n, qrPayload: null, qrImageUrl: null,
    fulfillmentMode: "direct", upstreamProduct: "gpt", upstreamPlan: "plus", fulfillmentUrl: base + "/fulfill",
    voucherCode: null, settlementId: null, paidAt: now, expiresAt: now, createdAt: now, updatedAt: now, ...changes};
  repo.insertOrder(order);
  repo.insertPaymentAttempt({id: "payment", merchantId: order.merchantId, orderId: order.id, provider: "alipay_page",
    status: order.paymentStatus === "refunded" ? "refunded" : "paid", providerRef: tradeNo,
    requestedMinor: order.saleAmountMinor, receivedMinor: order.saleAmountMinor, feeMinor: 0n, qrPayload: null,
    expiresAt: now, paidAt: now, createdAt: now, updatedAt: now});
  return order;
}

function review(repo: Repository, state: "reviewing" | "resolved" = "reviewing", differenceMinor = 1000n, merchantId = "merchant") {
  const now = new Date();
  repo.saveOperations("refund_reconciliation", {id: refundReconciliationId("order"), merchantId, orderId: "order",
    provider: "alipay_page", status: state, reportedMinor: 13500n, recordedMinor: 12500n, differenceMinor,
    providerReferenceFingerprint: "snapshot-test", legacyTicketIds: [], version: 1,
    firstDetectedAt: now, lastCheckedAt: now, resolvedAt: state === "resolved" ? now : null});
}

function result(refundAmount = "10.00"): Record<string, string> {
  return {code: "10000", out_trade_no: "order", total_amount: "135.00", trade_no: tradeNo,
    trade_status: "TRADE_SUCCESS", refund_amount: refundAmount, app_id: identity.appId, seller_id: identity.sellerId};
}

function services(repo: Repository, query: () => Promise<Record<string, string>>) {
  const exec = vi.fn(query);
  const client = {exec, pageExecute: vi.fn(), checkNotifySignV2: vi.fn(() => true)} as unknown as AlipayClient;
  const payment = new PaymentService(repo, new LedgerService(repo), new WebhookService(repo));
  const provider = new AlipayPagePaymentProvider(base, new PortalTokenService(base, "snapshot-test-secret"));
  const alipay = new AlipayPaymentService(repo, payment, client, identity, base, provider);
  // These fixtures have legacy payment bindings, so no payment keys or live SDK are used.
  const managed = new ManagedAlipayService(repo, {} as PaymentSettingsService, payment, base, provider, alipay);
  const handler = vi.fn<(orderId: string, amount: bigint, reference: string, captured?: bigint) => void>();
  managed.setExternalRefundHandler(handler);
  return {alipay, managed, handler, exec};
}

for (const driver of ["memory", "sqlite"] as const) describe(`provider refund snapshot ordering (${driver})`, () => {
  let repo: Repository;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    repo = driver === "memory" ? new MemoryRepository() : new SqliteRepository(":memory:");
  });
  afterEach(() => {repo.close?.(); vi.useRealTimers();});

  it("keeps the pre-query sum when local refunds are posted before a late response", async () => {
    const order = seed(repo, {ordinaryRefundedMinor: 500n, priceAdjustmentRefundedMinor: 250n,
      paymentStatus: "partially_refunded"});
    const response = deferred<Record<string, string>>();
    const {managed, handler, exec} = services(repo, () => response.promise);
    const pending = managed.reconcile(order.id);
    expect(exec).toHaveBeenCalledWith("alipay.trade.query", {bizContent: {out_trade_no: order.id}}, {validateSign: true});
    repo.updateOrder({...order, ordinaryRefundedMinor: 1500n});
    response.resolve(result("17.50"));
    await pending;
    expect(handler).toHaveBeenCalledWith(order.id, 1750n, `alipay-query:${tradeNo}:17.50`, 750n);
  });

  it("retains each request's own watermark when responses arrive out of order", async () => {
    const order = seed(repo, {ordinaryRefundedMinor: 1000n, paymentStatus: "partially_refunded"});
    const older = deferred<Record<string, string>>(), newer = deferred<Record<string, string>>();
    const {alipay, handler, exec} = services(repo, () => older.promise);
    const first = alipay.reconcile(order.id);
    repo.updateOrder({...order, ordinaryRefundedMinor: 2000n});
    const attempt = repo.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    repo.updatePaymentAttempt({...attempt, nextCheckAt: new Date(0)});
    exec.mockImplementationOnce(() => newer.promise);
    const second = alipay.reconcile(order.id);
    newer.resolve(result("20.00"));
    await second;
    older.resolve(result("10.00"));
    await first;
    expect(handler.mock.calls.map(call => call[3])).toEqual([2000n, 1000n]);
  });

  it("does not attach a local query watermark to asynchronous notifications", () => {
    seed(repo, {ordinaryRefundedMinor: 1000n, paymentStatus: "partially_refunded"});
    const {managed, handler, exec} = services(repo, async () => result());
    managed.handleNotification({...result(), sign_type: "RSA2", sign: "test-signature"});
    expect(handler).toHaveBeenCalledWith("order", 1000n, `alipay-query:${tradeNo}:10.00`, undefined);
    expect(exec).not.toHaveBeenCalled();
  });

  for (const entrypoint of ["alipay", "managed"] as const) {
    it(`continues ${entrypoint} queries for a fully refunded order while its discrepancy remains open`, async () => {
      seed(repo, {paymentStatus: "refunded", ordinaryRefundedMinor: 13500n});
      review(repo);
      const values = services(repo, async () => result("135.00"));
      await values[entrypoint].reconcileOne();
      expect(values.exec).toHaveBeenCalledOnce();
      expect(values.handler).toHaveBeenCalledWith("order", 13500n, `alipay-query:${tradeNo}:135.00`, 13500n);
      expect(repo.findPaymentAttemptByOrder("merchant", "order")?.nextCheckAt?.getTime()).toBe(Date.now() + 60000);

      review(repo, "resolved", 0n);
      const attempt = repo.findPaymentAttemptByOrder("merchant", "order")!;
      repo.updatePaymentAttempt({...attempt, nextCheckAt: new Date(0)});
      await values[entrypoint].reconcileOne();
      await values[entrypoint].reconcile("order");
      expect(values.exec).toHaveBeenCalledOnce();
    });

    it.each(["absent", "resolved", "zero", "other-merchant"] as const)(
      `does not query settled refunded orders via ${entrypoint} when review is %s`, async state => {
        seed(repo, {paymentStatus: "refunded", ordinaryRefundedMinor: 13500n});
        if (state !== "absent") review(repo, state === "resolved" ? "resolved" : "reviewing",
          state === "zero" ? 0n : 1000n, state === "other-merchant" ? "another-merchant" : "merchant");
        const values = services(repo, async () => result("135.00"));
        await values[entrypoint].reconcileOne();
        await values[entrypoint].reconcile("order");
        expect(values.exec).not.toHaveBeenCalled();
      });
  }

  it("honors the next-check time for fully refunded orders under review", async () => {
    seed(repo, {paymentStatus: "refunded", ordinaryRefundedMinor: 13500n});
    review(repo);
    const attempt = repo.findPaymentAttemptByOrder("merchant", "order")!;
    repo.updatePaymentAttempt({...attempt, nextCheckAt: new Date(Date.now() + 60000)});
    const {alipay, managed, exec} = services(repo, async () => result("135.00"));
    await alipay.reconcileOne();
    await managed.reconcileOne();
    await alipay.reconcile("order");
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves a fully refunded order through the real aggregate callback chain without refunding again", async () => {
    seed(repo, {paymentStatus: "refunded", ordinaryRefundedMinor: 13500n});
    review(repo);
    const current = repo.getOperations("refund_reconciliation", refundReconciliationId("order"))!;
    repo.saveOperations("refund_reconciliation", {...current, recordedMinor: 13500n, snapshotCoveredRecordedMinor: 12500n});
    const reconciliations = new RefundReconciliationService(repo);
    const refunds = new RefundService(repo, new LedgerService(repo), new WebhookService(repo), undefined, undefined, {
      discrepancy: input => reconciliations.observe(input), recorded: input => reconciliations.recorded(input),
    });
    const values = services(repo, async () => ({...result("135.00"), trade_status: "TRADE_CLOSED"}));
    values.managed.setExternalRefundHandler((id, amount, reference, captured) => refunds.syncProviderRefund(id, amount, reference, captured));
    await values.managed.reconcileOne();
    expect(repo.getOperations("refund_reconciliation", refundReconciliationId("order")))
      .toMatchObject({status: "resolved", reportedMinor: 13500n, recordedMinor: 13500n,
        snapshotCoveredRecordedMinor: 13500n, differenceMinor: 0n});
    expect(repo.findOrderInternal("order")?.paymentStatus).toBe("refunded");
    expect(repo.findPaymentAttemptByOrder("merchant", "order")?.status).toBe("refunded");
    expect(repo.listLedger("merchant")).toHaveLength(0);
    vi.advanceTimersByTime(60001);
    await values.managed.reconcileOne();
    expect(values.exec).toHaveBeenCalledOnce();
    expect(values.exec).toHaveBeenCalledWith("alipay.trade.query", expect.anything(), {validateSign: true});
  });
});
