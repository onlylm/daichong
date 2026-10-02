import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, Refund, TenantContext} from "../src/domain/model.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";
import {RefundService, type RefundExecutor} from "../src/modules/refund-service.js";
import type {Actor} from "../src/operations/model.js";
import {workspaceOrderDetail} from "../src/operations/order-view.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const admin: Actor = {id: "synthetic-refund-admin", merchantId: null, role: "platform_admin"};
const blocked = {code: "provider_refund_reconciliation_required"};
type QueryResult = Awaited<ReturnType<NonNullable<RefundExecutor["query"]>>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return {promise, resolve};
}

describe.each(["memory", "sqlite"] as const)("provider refund discrepancy execution guard (%s)", driver => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: driver, SQLITE_PATH: ":memory:", LOG_LEVEL: "silent"});
  let runtime: Runtime, tenant: TenantContext;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });
  afterEach(() => { runtime?.close(); vi.restoreAllMocks(); vi.useRealTimers(); });

  async function paidOrder(): Promise<Order> {
    const created = await runtime.orders.create(tenant, {merchantOrderNo: "synthetic-" + randomUUID(),
      productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const order = runtime.payment.markPaid(tenant.merchantId, created.id,
      {channel: "mock", providerRef: "synthetic-payment:" + created.id, receivedMinor: created.saleAmountMinor});
    const attempt = runtime.repository.findPaymentAttemptByOrder(tenant.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page"});
    return order;
  }

  function service(query?: RefundExecutor["query"]) {
    // All channel traffic is local to these spies; no real Alipay client is constructed.
    const execute = vi.fn(async (_orderId: string, refund: Refund) => "SYNTHETIC-REFUND:" + refund.id);
    const refunds = new RefundService(runtime.repository, runtime.ledger, runtime.webhooks,
      {providerFor: () => "alipay_page", execute, ...(query ? {query} : {})}, undefined, {
        discrepancy: input => runtime.refundReconciliations.observe(input),
        recorded: input => runtime.refundReconciliations.recorded(input),
      });
    return {refunds, execute};
  }

  function hold(order: Order) {
    runtime.refunds.syncProviderRefund(order.id, 1_000n, "synthetic-cumulative-refund:" + order.id);
    expect(review(order)).toMatchObject({status: "reviewing", reportedMinor: 1_000n, recordedMinor: 0n, differenceMinor: 1_000n});
  }
  function review(order: Order) {
    return runtime.repository.getOperations("refund_reconciliation", refundReconciliationId(order.id));
  }
  function request(refunds: RefundService, order: Order, type: "partial" | "price_adjustment", amount = "5.00") {
    return refunds.request(tenant, order.id, {merchantRefundNo: "synthetic-request:" + randomUUID(),
      type, amount, reason: "隔离测试退款申请"});
  }
  function processing(refund: Refund): Refund {
    const updated: Refund = {...refund, status: "processing", failureCode: "refund_result_unknown", recoveryAttempts: 0,
      nextCheckAt: new Date(0), leaseToken: null, leaseUntil: null, lastSubmittedAt: new Date(Date.now() - 120_000).toISOString()};
    runtime.repository.updateRefund(updated);
    return updated;
  }
  function refundLedger(order: Order) {
    return runtime.repository.listLedger(tenant.merchantId).filter(item => item.orderId === order.id
      && ["ordinary_refund", "price_adjustment_refund"].includes(item.type));
  }
  function successEvents(order: Order) {
    const ids = new Set(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id).map(refund => refund.id));
    return runtime.repository.listOutbox(tenant.merchantId).filter(item => item.eventType === "refund.succeeded" && ids.has(item.aggregateId));
  }

  it.each(["api-customer", "api-adjustment", "workspace-customer", "workspace-adjustment"] as const)(
    "blocks a new %s request while the channel reports 10.00 and local books show zero", async path => {
      const order = await paidOrder(), {refunds, execute} = service();
      hold(order);
      const originalReview = review(order), originalLedger = runtime.repository.listLedger(tenant.merchantId);
      const submit = () => {
        if (path === "api-customer") return request(refunds, order, "partial");
        if (path === "api-adjustment") return request(refunds, order, "price_adjustment");
        const input = {amount: "5.00", reason: "隔离测试工作台退款", requestKey: "synthetic-workspace-refund"};
        return path === "workspace-customer" ? refunds.requestCustomerRefund(admin, order.id, input)
          : refunds.requestPriceAdjustment(admin, order.id, input);
      };
      expect(submit).toThrowError(expect.objectContaining(blocked));
      expect(execute).not.toHaveBeenCalled();
      expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(0);
      expect(runtime.repository.listLedger(tenant.merchantId)).toEqual(originalLedger);
      expect(runtime.repository.findOrderInternal(order.id)).toEqual(order);
      expect(review(order)).toEqual(originalReview);
    });

  it.each([
    ["requested", "partial"], ["failed", "partial"],
    ["requested", "price_adjustment"], ["failed", "price_adjustment"],
  ] as const)("blocks approval of an existing %s %s refund without changing its state", async (status, type) => {
    const order = await paidOrder(), {refunds, execute} = service();
    const requested = request(refunds, order, type);
    const original = {...requested, status, failureCode: status === "failed" ? "synthetic-channel-failure" : null};
    runtime.repository.updateRefund(original);
    hold(order);
    await expect(refunds.approve(admin, original.id)).rejects.toMatchObject(blocked);
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.repository.findRefund(tenant.merchantId, original.id)).toEqual(original);
    expect(refundLedger(order)).toHaveLength(0);
    expect(review(order)).toMatchObject({status: "reviewing", differenceMinor: 1_000n});
  });

  it.each(["partial", "price_adjustment"] as const)(
    "preserves idempotent replay of a prior %s request after a discrepancy is discovered", async type => {
      const order = await paidOrder(), {refunds, execute} = service(), original = request(refunds, order, type);
      hold(order);
      expect(refunds.request(tenant, order.id, {merchantRefundNo: original.merchantRefundNo,
        type, amount: "5.00", reason: original.reason})).toEqual(original);
      expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
    });

  it.each(["partial", "price_adjustment"] as const)(
    "keeps querying a processing %s refund but never resubmits an unconfirmed result", async type => {
      const query = vi.fn<NonNullable<RefundExecutor["query"]>>(async () => ({status: "not_confirmed", bindingVerified: true}));
      const order = await paidOrder(), {refunds, execute} = service(query);
      const original = processing(request(refunds, order, type));
      hold(order);
      await refunds.reconcileOne();
      expect(query).toHaveBeenCalledWith(order.id, expect.objectContaining({id: original.id, amountMinor: 500n}));
      expect(execute).not.toHaveBeenCalled();
      expect(runtime.repository.findRefund(tenant.merchantId, original.id)).toMatchObject({status: "processing",
        recoveryAttempts: 0, lastSubmittedAt: original.lastSubmittedAt, leaseToken: null, leaseUntil: null});
      const nextCheckAt = runtime.repository.findRefund(tenant.merchantId, original.id)!.nextCheckAt!;
      expect(nextCheckAt.getTime()).toBeGreaterThan(Date.now());
      vi.setSystemTime(nextCheckAt);
      await refunds.reconcileOne();
      expect(query).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
      expect(refundLedger(order)).toHaveLength(0);
      expect(review(order)).toMatchObject({status: "reviewing", differenceMinor: 1_000n});
    });

  it("rechecks a discrepancy discovered while the exact channel query is awaiting its result", async () => {
    const pending = deferred<QueryResult>(), query = vi.fn(() => pending.promise);
    const order = await paidOrder(), {refunds, execute} = service(query);
    const original = processing(request(refunds, order, "partial"));
    const recovery = refunds.reconcileOne();
    expect(query).toHaveBeenCalledOnce();
    hold(order);
    pending.resolve({status: "not_confirmed", bindingVerified: true});
    await recovery;
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.repository.findRefund(tenant.merchantId, original.id)).toMatchObject({status: "processing",
      recoveryAttempts: 0, lastSubmittedAt: original.lastSubmittedAt, leaseToken: null, leaseUntil: null});
    expect(refundLedger(order)).toHaveLength(0);
  });

  it("leaves an uncertain query queued without executing or booking a refund", async () => {
    const query = vi.fn(async () => { throw new Error("synthetic-channel-query-timeout"); });
    const order = await paidOrder(), {refunds, execute} = service(query);
    const original = processing(request(refunds, order, "partial"));
    hold(order);
    await refunds.reconcileOne();
    expect(query).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.repository.findRefund(tenant.merchantId, original.id)).toMatchObject({status: "processing",
      recoveryAttempts: 0, leaseToken: null, leaseUntil: null});
    expect(refundLedger(order)).toHaveLength(0);
    expect(review(order)).toMatchObject({status: "reviewing", recordedMinor: 0n, differenceMinor: 1_000n});
  });

  it.each(["partial", "price_adjustment"] as const)(
    "books exact success of an existing %s refund once and requires a fresh cumulative snapshot to clear the discrepancy", async type => {
      const query = vi.fn<NonNullable<RefundExecutor["query"]>>(async () => ({status: "succeeded", providerRefundNo: "SYNTHETIC-QUERY-SUCCESS"}));
      const order = await paidOrder(), {refunds, execute} = service(query);
      const original = processing(request(refunds, order, type, "10.00"));
      hold(order);
      await refunds.reconcileOne();
      expect(query).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      const completed = runtime.repository.findRefund(tenant.merchantId, original.id)!;
      expect(completed).toMatchObject({status: "succeeded", providerRefundNo: "SYNTHETIC-QUERY-SUCCESS", leaseToken: null, leaseUntil: null});
      expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus: "partially_refunded",
        ordinaryRefundedMinor: type === "partial" ? 1_000n : 0n, priceAdjustmentRefundedMinor: type === "price_adjustment" ? 1_000n : 0n});
      expect(review(order)).toMatchObject({status: "reviewing", differenceMinor: 1_000n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 0n});
      expect(() => request(refunds, order, type)).toThrowError(expect.objectContaining(blocked));
      await refunds.reconcileOne();
      expect(await refunds.approve(admin, original.id)).toEqual(completed);
      expect(query).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(refundLedger(order)).toHaveLength(1);
      expect(successEvents(order)).toHaveLength(1);

      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-refresh-after-exact-success", 1_000n);
      expect(review(order)).toMatchObject({status: "resolved", differenceMinor: 0n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 1_000n});
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-late-old-query", 0n);
      expect(review(order)).toMatchObject({status: "resolved", differenceMinor: 0n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 1_000n});
      expect(request(refunds, order, type)).toMatchObject({status: "requested"});
    });

  it.each(["partial", "price_adjustment"] as const)(
    "keeps a discrepancy discovered during %s execution separate from that execution's later success", async type => {
      const pending = deferred<string>(), order = await paidOrder(), {refunds, execute} = service();
      execute.mockImplementationOnce(() => pending.promise);
      const original = request(refunds, order, type, "10.00"), approval = refunds.approve(admin, original.id);
      expect(execute).toHaveBeenCalledOnce();
      hold(order);
      pending.resolve("SYNTHETIC-IN-FLIGHT-REFUND-SUCCESS");
      expect(await approval).toMatchObject({status: "succeeded", amountMinor: 1_000n});
      expect(review(order)).toMatchObject({status: "reviewing", reportedMinor: 1_000n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 0n, differenceMinor: 1_000n});
      expect(() => request(refunds, order, type)).toThrowError(expect.objectContaining(blocked));

      // A late response captured before the execution must not claim the new ledger entry.
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-stale-before-payout", 0n);
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-legacy-without-captured-total");
      expect(review(order)).toMatchObject({status: "reviewing", snapshotCoveredRecordedMinor: 0n, differenceMinor: 1_000n});

      // The fresh total includes both the independent channel refund and our new payout.
      refunds.syncProviderRefund(order.id, 2_000n, "synthetic-fresh-after-payout", 1_000n);
      expect(review(order)).toMatchObject({status: "reviewing", reportedMinor: 2_000n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 1_000n, differenceMinor: 1_000n});
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-out-of-order-before-payout", 0n);
      expect(review(order)).toMatchObject({status: "reviewing", reportedMinor: 2_000n,
        snapshotCoveredRecordedMinor: 1_000n, differenceMinor: 1_000n});

      const receipt = {amount: "10.00", reason: "隔离测试独立渠道退款补登", requestKey: "synthetic-independent-receipt",
        providerRefundNo: "SYNTHETIC-INDEPENDENT-RECEIPT", confirmAlreadyRefundedAtChannel: true as const};
      const external = refunds.recordExternalCustomerRefund(admin, order.id, receipt);
      expect(refunds.recordExternalCustomerRefund(admin, order.id, receipt)).toEqual(external);
      expect(review(order)).toMatchObject({status: "resolved", reportedMinor: 2_000n, recordedMinor: 2_000n,
        snapshotCoveredRecordedMinor: 2_000n, differenceMinor: 0n});
      for (const reported of [1_000n, 2_000n]) {
        refunds.syncProviderRefund(order.id, reported, "synthetic-old-after-reconciliation", 0n);
        expect(review(order)).toMatchObject({status: "resolved", reportedMinor: 2_000n, recordedMinor: 2_000n,
          snapshotCoveredRecordedMinor: 2_000n, differenceMinor: 0n});
      }
      expect(refundLedger(order)).toHaveLength(2);
      expect(successEvents(order)).toHaveLength(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(request(refunds, order, type)).toMatchObject({status: "requested"});
    });

  it.each(["approve", "query"] as const)(
    "creates a first discrepancy from an old cumulative response even when %s already booked a newer refund", async completion => {
      const query = vi.fn<NonNullable<RefundExecutor["query"]>>(async () => ({status: "succeeded", providerRefundNo: "SYNTHETIC-EARLY-QUERY-SUCCESS"}));
      const order = await paidOrder(), {refunds, execute} = service(query), original = request(refunds, order, "partial", "10.00");
      const capturedBeforePayout = 0n;
      if (completion === "approve") await refunds.approve(admin, original.id);
      else {
        processing(original);
        await refunds.reconcileOne();
      }
      expect(runtime.repository.findOrderInternal(order.id)?.ordinaryRefundedMinor).toBe(1_000n);
      expect(review(order)).toBeNull();
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-old-first-observation", capturedBeforePayout);
      expect(review(order)).toMatchObject({status: "reviewing", reportedMinor: 1_000n, recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 0n, differenceMinor: 1_000n});
      expect(() => request(refunds, order, "partial")).toThrowError(expect.objectContaining(blocked));
      refunds.syncProviderRefund(order.id, 1_000n, "synthetic-repeated-old-first-observation");
      expect(review(order)).toMatchObject({status: "reviewing", recordedMinor: 1_000n,
        snapshotCoveredRecordedMinor: 0n, differenceMinor: 1_000n});
      expect(refundLedger(order)).toHaveLength(1);
      expect(successEvents(order)).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(completion === "approve" ? 1 : 0);
      expect(query).toHaveBeenCalledTimes(completion === "query" ? 1 : 0);
    });

  it.each(["partial", "price_adjustment"] as const)(
    "records external receipts once, keeps a residual difference locked, then allows a new %s refund", async type => {
      const order = await paidOrder(), {refunds, execute} = service();
      hold(order);
      const receipt = {amount: "5.00", reason: "隔离测试渠道已退款凭证", requestKey: "synthetic-external-receipt-1",
        providerRefundNo: "SYNTHETIC-EXTERNAL-RECEIPT-1", confirmAlreadyRefundedAtChannel: true as const};
      const first = refunds.recordExternalCustomerRefund(admin, order.id, receipt);
      expect(first).toMatchObject({status: "succeeded", amountMinor: 500n});
      expect(refunds.recordExternalCustomerRefund(admin, order.id, receipt)).toEqual(first);
      expect(() => refunds.recordExternalCustomerRefund(admin, order.id, {...receipt, requestKey: "synthetic-replay-other-key"}))
        .toThrowError(expect.objectContaining({code: "provider_refund_reference_used"}));
      expect(execute).not.toHaveBeenCalled();
      expect(refundLedger(order)).toHaveLength(1);
      expect(successEvents(order)).toHaveLength(1);
      expect(review(order)).toMatchObject({status: "reviewing", recordedMinor: 500n, differenceMinor: 500n});
      expect(() => request(refunds, order, type)).toThrowError(expect.objectContaining(blocked));

      const second = {...receipt, requestKey: "synthetic-external-receipt-2", providerRefundNo: "SYNTHETIC-EXTERNAL-RECEIPT-2"};
      const recorded = refunds.recordExternalCustomerRefund(admin, order.id, second);
      expect(refunds.recordExternalCustomerRefund(admin, order.id, second)).toEqual(recorded);
      expect(refundLedger(order)).toHaveLength(2);
      expect(successEvents(order)).toHaveLength(2);
      expect(review(order)).toMatchObject({status: "resolved", reportedMinor: 1_000n, recordedMinor: 1_000n, differenceMinor: 0n});
      expect(execute).not.toHaveBeenCalled();

      const next = request(refunds, order, type);
      expect(await refunds.approve(admin, next.id)).toMatchObject({status: "succeeded", amountMinor: 500n});
      expect(execute).toHaveBeenCalledOnce();
      expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus: "partially_refunded",
        ordinaryRefundedMinor: type === "partial" ? 1_500n : 1_000n, priceAdjustmentRefundedMinor: type === "price_adjustment" ? 500n : 0n});
      expect(refundLedger(order)).toHaveLength(3);
      expect(successEvents(order)).toHaveLength(3);
    });

  it("does not block refunds for another order of the same merchant", async () => {
    const held = await paidOrder(), eligible = await paidOrder(), {refunds, execute} = service();
    hold(held);
    const originalReview = review(held), refund = request(refunds, eligible, "partial");
    expect(await refunds.approve(admin, refund.id)).toMatchObject({status: "succeeded"});
    expect(execute).toHaveBeenCalledWith(eligible.id, expect.objectContaining({id: refund.id}));
    expect(runtime.repository.findOrderInternal(held.id)).toEqual(held);
    expect(review(held)).toEqual(originalReview);
    expect(review(eligible)).toBeNull();
    expect(refundLedger(held)).toHaveLength(0);
    expect(refundLedger(eligible)).toHaveLength(1);
  });

  it("reflects the discrepancy lock and external-receipt recovery in workspace refund actions", async () => {
    const order = await paidOrder(), {refunds, execute} = service();
    const detail = () => workspaceOrderDetail(runtime.repository, admin, order.id, [], "Synthetic merchant");
    expect(detail()).toMatchObject({canRefundCustomer: true, canPriceAdjust: true, canRecordExternalRefund: true});

    hold(order);
    expect(detail()).toMatchObject({canRefundCustomer: false, canPriceAdjust: false, canRecordExternalRefund: true});

    refunds.recordExternalCustomerRefund(admin, order.id, {amount: "10.00", reason: "隔离测试工作台渠道退款补登",
      requestKey: "synthetic-workspace-recovery", providerRefundNo: "SYNTHETIC-WORKSPACE-RECOVERY",
      confirmAlreadyRefundedAtChannel: true});
    expect(review(order)).toMatchObject({status: "resolved", differenceMinor: 0n});
    expect(detail()).toMatchObject({canRefundCustomer: true, canPriceAdjust: true, canRecordExternalRefund: true});
    expect(execute).not.toHaveBeenCalled();
  });
});
