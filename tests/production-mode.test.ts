import {describe, expect, it} from "vitest";
import {loadConfig} from "../src/config.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {LiveTestPolicy} from "../src/modules/live-test-policy.js";
import type {Order, PaymentAttempt, SupplierConnection} from "../src/domain/model.js";

function productionConfig() {
  return loadConfig({
    NODE_ENV: "production", EXECUTION_MODE: "production", STORAGE_DRIVER: "sqlite", SQLITE_PATH: "./data/production.sqlite",
    TRUST_PROXY: "true", ENABLE_SANDBOX_ROUTES: "false", PUBLIC_BASE_URL: "https://quefa.test", ADMIN_BASE_URL: "https://admin.quefa.test",
    PAYMENT_PROVIDER: "managed", FULFILLMENT_PROVIDER: "zovocard", PLATFORM_ADMIN_TOKEN: "production-admin-token-at-least-32-characters",
    PORTAL_TOKEN_SECRET: "production-portal-token-at-least-32-characters", DEMO_CLIENT_SECRET: "production-demo-secret-at-least-32-characters",
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  });
}

describe("production execution policy", () => {
  it("creates ordinary orders and only permits paid orders on an enabled production supplier", () => {
    const config = productionConfig(), repository = new MemoryRepository(), policy = new LiveTestPolicy(config, repository);
    expect(policy.assertNewOrder({merchantId: "merchant", partnerId: "partner", appId: "app", keyId: "key"}, 13_500n)).toBe(false);

    const now = new Date(), order: Order = {
      id: "ord_production", merchantId: "merchant", appId: "app", merchantOrderNo: "production-1", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmountMinor: 13_500n, supplyAmountMinor: 11_000n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
      currency: "CNY", paymentStatus: "paid", metadata: {}, paymentProviderRef: "trade_1", paymentReceivedMinor: 13_500n,
      paymentFeeMinor: 0n, qrPayload: null, qrImageUrl: null, fulfillmentMode: "direct", upstreamProduct: "gpt", upstreamPlan: "plus",
      fulfillmentUrl: "https://quefa.test/redeem/ord_production", voucherCode: null, settlementId: null, paidAt: now,
      expiresAt: new Date(now.getTime() + 600_000), createdAt: now, updatedAt: now,
    };
    repository.insertOrder(order);
    expect(policy.canFulfill(order)).toBe(false);

    const connection: SupplierConnection = {
      id: "supplier_primary", name: "生产供应", provider: "zovocard", environment: "production",
      openApiBase: "https://zovocard.com/openapi/v1", cdkBase: "https://zovocard.com/api/v1/cdk", enabled: true,
      secretPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null}, configVersion: 1,
      lastTestStatus: "succeeded", lastTestMessage: null, lastTestAt: now, lastPlanSyncAt: now, createdAt: now, updatedAt: now,
    };
    repository.saveSupplierConnection(connection);
    const payment: PaymentAttempt = {
      id: "pay_production", merchantId: order.merchantId, orderId: order.id, provider: "alipay_page", status: "paid",
      providerRef: "trade_1", requestedMinor: 13_500n, receivedMinor: 13_500n, feeMinor: 0n, qrPayload: null,
      expiresAt: order.expiresAt, paidAt: now, createdAt: now, updatedAt: now,
    };
    repository.insertPaymentAttempt(payment);
    expect(policy.canFulfill(order)).toBe(true);
    expect(policy.requiresApproval(order)).toBe(false);
  });

  it("rejects production execution outside a hardened production runtime", () => {
    expect(() => loadConfig({NODE_ENV: "development", EXECUTION_MODE: "production"})).toThrow("NODE_ENV=production");
  });
});
