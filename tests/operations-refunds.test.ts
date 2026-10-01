import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {merchantMargin} from "../src/domain/money.js";
import {RefundService} from "../src/modules/refund-service.js";
import type {Actor} from "../src/operations/model.js";
import type {Order, TenantContext} from "../src/domain/model.js";

describe("workspace price adjustment refunds", () => {
  let runtime: Runtime, owner: Actor, tenant: TenantContext;
  const finance: Actor = {id: "finance", merchantId: null, role: "platform_finance"};
  beforeEach(() => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    const bundle = runtime.repository.findCredential(runtime.repository.findMerchantByPartner("pt_demo_a")!.partnerId, loadConfig({NODE_ENV: "test"}).demoKeyId)!;
    owner = {id: "owner", merchantId: bundle.merchant.id, role: "agent_owner"};
    tenant = {merchantId: owner.merchantId!, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });
  afterEach(() => runtime.close());

  async function paidRetail(key = "retail-001", provider: "mock" | "alipay_page" = "mock"): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: key, productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider});
    return runtime.payment.markPaid(order.merchantId, order.id, {channel: provider, providerRef: "pay:" + key, receivedMinor: order.saleAmountMinor});
  }

  it("registers and approves a price adjustment without reversing merchant margin", async () => {
    const order = await paidRetail();
    expect(merchantMargin(order)).toBe(2500n);
    const pending = runtime.refunds.requestPriceAdjustment(finance, order.id, {amount: "10.00", reason: "上游实扣低于报价", requestKey: "padj00001"});
    expect(pending.status).toBe("requested");
    expect(runtime.refunds.listPendingPriceAdjustments(finance)).toHaveLength(1);
    const completed = await runtime.refunds.approve(finance, pending.id);
    expect(completed.status).toBe("succeeded");
    expect(completed.providerRefundNo).toBe("mock:" + pending.id);
    const updated = runtime.repository.findOrder(order.merchantId, order.id)!;
    expect(updated.priceAdjustmentRefundedMinor).toBe(1000n);
    expect(merchantMargin(updated)).toBe(2500n);
    expect(runtime.repository.listLedger(order.merchantId).some(item => item.type === "price_adjustment_refund")).toBe(true);
    expect(runtime.repository.listLedger(order.merchantId).some(item => item.type === "merchant_margin" && item.direction === "decrease")).toBe(false);
  });

  it("rejects price adjustment above remaining refundable and non-platform-collect orders", async () => {
    const order = await paidRetail("retail-002");
    expect(() => runtime.refunds.requestPriceAdjustment(finance, order.id, {amount: "200.00", reason: "超额", requestKey: "padj00002"}))
      .toThrow("不能超过该订单剩余可退金额");
    const procurement = {id: "proc-001", merchantId: owner.merchantId!, appId: tenant.appId, merchantOrderNo: "proc-001", collectionMode: "agent_collect" as const,
      deliveryMode: "auto_recharge" as const, productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmountMinor: 11000n, supplyAmountMinor: 11000n, ordinaryRefundedMinor: 0n,
      priceAdjustmentRefundedMinor: 0n, currency: "CNY" as const, metadata: {}, paymentStatus: "paid" as const, paymentProviderRef: "p", paymentReceivedMinor: 11000n, paymentFeeMinor: 0n,
      qrPayload: null, qrImageUrl: null, fulfillmentMode: "direct" as const, upstreamProduct: "gpt" as const, upstreamPlan: "plus", fulfillmentUrl: "https://example.test/fulfill", voucherCode: null, settlementId: null,
      paidAt: new Date(), expiresAt: new Date(), createdAt: new Date(), updatedAt: new Date(), liveTest: false};
    runtime.repository.insertOrder(procurement);
    expect(() => runtime.refunds.requestPriceAdjustment(finance, procurement.id, {amount: "1.00", reason: "x", requestKey: "padj00003"}))
      .toThrow("仅平台代收订单");
  });

  it("does not reverse released earnings when a price adjustment completes", async () => {
    const order = await paidRetail("retail-003", "alipay_page");
    runtime.repository.updateOrder({...runtime.repository.findOrder(order.merchantId, order.id)!, fulfillmentMode: "direct"});
    const task = runtime.fulfillments.createDirectPublic(runtime.repository.findOrder(order.merchantId, order.id)!, {mode: "session", session: "offline-test"});
    await runtime.fulfillments.processOne();
    const completed = runtime.repository.findFulfillment(order.merchantId, task.id)!;
    runtime.repository.updateFulfillment({...completed, upstreamProvider: "configured_supplier", status: "succeeded"});
    runtime.wallets.releaseEarning(finance, order.id);
    expect(runtime.wallets.summary(owner, owner.merchantId!).earningsAvailable).toBe("25.00");
    const refunds = new RefundService(runtime.repository, runtime.ledger, runtime.webhooks, {
      providerFor: () => "alipay_page",
      execute: async () => "2026092900000001",
    });
    const pending = refunds.requestPriceAdjustment(finance, order.id, {amount: "10.00", reason: "差价", requestKey: "padj00004"});
    await refunds.approve(finance, pending.id);
    runtime.wallets.reconcileMerchantEarnings(owner.merchantId!);
    expect(runtime.wallets.summary(owner, owner.merchantId!).earningsAvailable).toBe("25.00");
  });

  it("calls Alipay refund with order id as out_trade_no on approve", async () => {
    const order = await paidRetail("retail-alipay", "alipay_page");
    const execute = vi.fn(async () => "2026092900123456789");
    const refunds = new RefundService(runtime.repository, runtime.ledger, runtime.webhooks, {
      providerFor: () => "alipay_page",
      execute,
    });
    const pending = refunds.requestPriceAdjustment(finance, order.id, {amount: "10.00", reason: "支付宝自动退", requestKey: "padj-alipay1"});
    const done = await refunds.approve(finance, pending.id);
    expect(execute).toHaveBeenCalledWith(order.id, expect.objectContaining({id: pending.id, amountMinor: 1000n}));
    expect(done).toMatchObject({status: "succeeded", providerRefundNo: "2026092900123456789"});
  });

  it("keeps a retryable Alipay refund in processing for safe channel recovery", async () => {
    const order = await paidRetail("retail-fail", "alipay_page");
    const {AppError} = await import("../src/domain/errors.js");
    const executeApp = vi.fn().mockRejectedValueOnce(new AppError(503, "alipay_refund_failed", "支付宝退款失败", true));
    const refunds = new RefundService(runtime.repository, runtime.ledger, runtime.webhooks, {
      providerFor: () => "alipay_page",
      execute: executeApp,
    });
    const pending = refunds.requestPriceAdjustment(finance, order.id, {amount: "5.00", reason: "先失败", requestKey: "padj-fail1"});
    const processing = await refunds.approve(finance, pending.id);
    expect(processing).toMatchObject({status: "processing", failureCode: "refund_result_unknown"});
    expect(await refunds.approve(finance, pending.id)).toEqual(processing);
  });

  it("records an external channel refund and reverses released earnings", async () => {
    const order = await paidRetail("retail-ext-001", "alipay_page");
    runtime.repository.updateOrder({...runtime.repository.findOrder(order.merchantId, order.id)!, fulfillmentMode: "direct"});
    const task = runtime.fulfillments.createDirectPublic(runtime.repository.findOrder(order.merchantId, order.id)!, {mode: "session", session: "offline-test"});
    await runtime.fulfillments.processOne();
    const completed = runtime.repository.findFulfillment(order.merchantId, task.id)!;
    runtime.repository.updateFulfillment({...completed, upstreamProvider: "configured_supplier", status: "succeeded"});
    runtime.wallets.releaseEarning(finance, order.id);
    expect(runtime.wallets.summary(owner, owner.merchantId!).earningsAvailable).toBe("25.00");
    const refund = runtime.refunds.recordExternalCustomerRefund(finance, order.id, {
      reason: "支付宝控制台已退",
      requestKey: "ext-refund-001",
      providerRefundNo: "2026092912345678",
      confirmAlreadyRefundedAtChannel: true,
    });
    expect(refund.status).toBe("succeeded");
    runtime.wallets.reconcileMerchantEarnings(owner.merchantId!);
    const updated = runtime.repository.findOrder(order.merchantId, order.id)!;
    expect(updated.paymentStatus).toBe("refunded");
    expect(updated.ordinaryRefundedMinor).toBe(order.saleAmountMinor);
    expect(runtime.wallets.summary(owner, owner.merchantId!).earningsAvailable).toBe("0.00");
  });

  it("replays the same external refund after a full refund without posting again", async () => {
    const order = await paidRetail("retail-ext-replay", "alipay_page");
    const input = {reason: "支付宝控制台已退", requestKey: "ext-refund-replay",
      providerRefundNo: "2026100100000111", confirmAlreadyRefundedAtChannel: true as const};
    const first = runtime.refunds.recordExternalCustomerRefund(finance, order.id, input);
    const ledgerCount = runtime.repository.listLedger(order.merchantId).length;

    expect(runtime.refunds.recordExternalCustomerRefund(finance, order.id, input)).toEqual(first);
    expect(runtime.repository.listRefundsForOrder(order.merchantId, order.id)).toHaveLength(1);
    expect(runtime.repository.listLedger(order.merchantId)).toHaveLength(ledgerCount);
    expect(runtime.repository.findOrderInternal(order.id)?.ordinaryRefundedMinor).toBe(order.saleAmountMinor);
    expect(() => runtime.refunds.recordExternalCustomerRefund(finance, order.id,
      {...input, providerRefundNo: "2026100100000112"})).toThrow("退款号已用于不同请求");
  });

  it("does not book the same external channel refund reference under another request key", async () => {
    const order = await paidRetail("retail-ext-duplicate-ref", "alipay_page");
    const input = {amount: "10.00", reason: "支付宝控制台已退", requestKey: "ext-refund-a",
      providerRefundNo: "2026100100000222", confirmAlreadyRefundedAtChannel: true as const};
    runtime.refunds.recordExternalCustomerRefund(finance, order.id, input);
    const ledgerCount = runtime.repository.listLedger(order.merchantId).length;

    expect(() => runtime.refunds.recordExternalCustomerRefund(finance, order.id,
      {...input, requestKey: "ext-refund-b"})).toThrow("退款流水号已登记");
    expect(runtime.repository.listRefundsForOrder(order.merchantId, order.id)).toHaveLength(1);
    expect(runtime.repository.listLedger(order.merchantId)).toHaveLength(ledgerCount);
    expect(runtime.repository.findOrderInternal(order.id)?.ordinaryRefundedMinor).toBe(1_000n);
  });
});
