import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {AlipayPagePaymentProvider, AlipayPaymentService, type AlipayClient} from "../src/modules/alipay-payment.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("Alipay payment reconciliation", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tenant: TenantContext;

  beforeEach(async () => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    await app.close();
    runtime.close();
  });

  async function orderWithAlipayAttempt(): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page", providerRef: order.id, qrPayload: null,
      updatedAt: new Date()});
    return order;
  }

  function service(result: Record<string, string>): AlipayPaymentService {
    const client = {
      exec: vi.fn(async () => result),
      pageExecute: vi.fn(async () => ""),
      checkNotifySignV2: vi.fn(() => true),
    } as unknown as AlipayClient;
    const paymentProvider = new AlipayPagePaymentProvider(config.publicBaseUrl, runtime.portalTokens);
    const value = new AlipayPaymentService(runtime.repository, runtime.payment, client,
      {appId: "test-app", sellerId: "2088000000000000"}, config.publicBaseUrl, paymentProvider);
    value.setExternalRefundHandler((orderId, amount, reference) => runtime.refunds.syncProviderRefund(orderId, amount, reference));
    return value;
  }

  it("records a provider-side full refund, closes the recharge portal and stays idempotent", async () => {
    const created = await orderWithAlipayAttempt();
    const tradeNo = "2026100100000001";
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {channel: "alipay_page", providerRef: tradeNo, receivedMinor: created.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const token = new URL(paid.fulfillmentUrl).searchParams.get("token")!;
    const alipay = service({code: "10000", out_trade_no: paid.id, total_amount: "135.00", trade_no: tradeNo,
      trade_status: "TRADE_SUCCESS", refund_amount: "135.00", seller_id: "2088000000000000", app_id: "test-app"});

    await alipay.reconcile(paid.id);
    const refunded = runtime.repository.findOrderInternal(paid.id)!;
    expect(refunded.paymentStatus).toBe("refunded");
    expect(refunded.ordinaryRefundedMinor).toBe(13_500n);
    expect(runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)).toMatchObject({status: "refunded"});
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)).toMatchObject({id: voucher.id, status: "disabled"});
    expect((await app.inject({url: `/recharge/${paid.id}?token=${encodeURIComponent(token)}`})).statusCode).toBe(410);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toHaveLength(1);

    await alipay.reconcile(paid.id);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toHaveLength(1);
  });

  it("closes an unpaid order when Alipay reports TRADE_CLOSED without requiring a trade number", async () => {
    const order = await orderWithAlipayAttempt();
    const alipay = service({code: "10000", out_trade_no: order.id, total_amount: "135.00",
      trade_status: "TRADE_CLOSED", seller_id: "2088000000000000", app_id: "test-app"});

    await alipay.reconcile(order.id);
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("closed");
    expect(runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)?.status).toBe("closed");
  });

  it("records only the cumulative delta for successive provider-side partial refunds", async () => {
    const created = await orderWithAlipayAttempt();
    const tradeNo = "2026100100000002";
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {channel: "alipay_page", providerRef: tradeNo, receivedMinor: created.saleAmountMinor});
    await runtime.cdk.issueOne();
    const token = new URL(paid.fulfillmentUrl).searchParams.get("token")!;
    const result = (refundAmount: string) => ({code: "10000", out_trade_no: paid.id, total_amount: "135.00", trade_no: tradeNo,
      trade_status: "TRADE_SUCCESS", refund_amount: refundAmount, seller_id: "2088000000000000", app_id: "test-app"});

    await service(result("10.00")).reconcile(paid.id);
    expect(runtime.repository.findOrderInternal(paid.id)).toMatchObject({paymentStatus: "partially_refunded", ordinaryRefundedMinor: 1_000n});
    expect(runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)?.status).toBe("paid");
    expect((await app.inject({url: `/recharge/${paid.id}?token=${encodeURIComponent(token)}`})).statusCode).toBe(410);

    const firstAttempt = runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)!;
    runtime.repository.updatePaymentAttempt({...firstAttempt, nextCheckAt: new Date(0)});
    await service(result("25.00")).reconcile(paid.id);
    expect(runtime.repository.findOrderInternal(paid.id)?.ordinaryRefundedMinor).toBe(2_500n);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id).map(item => item.amountMinor)).toEqual([1_000n, 1_500n]);

    const secondAttempt = runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)!;
    runtime.repository.updatePaymentAttempt({...secondAttempt, nextCheckAt: new Date(0)});
    await service(result("25.00")).reconcile(paid.id);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toHaveLength(2);
  });
});
