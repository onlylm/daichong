import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor, WalletEntry} from "../src/operations/model.js";
import {managedGptProducts} from "../src/modules/gpt-products.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const admin: Actor = {id: "policy-admin", role: "platform_admin", merchantId: null};

describe("2026-10-01 agent policy", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    publishTestRechargeProduct(runtime);
  });
  afterEach(() => runtime.close());

  it("keeps exactly four current products with the configured supply and internal costs", () => {
    expect(managedGptProducts.map(product => [product.productCode, product.supplyPriceMinor, product.costPriceMinor])).toEqual([
      ["chatgpt_plus_cdk_1m", 11_000n, 10_800n],
      ["chatgpt_pro_5x_cdk_1m", 63_800n, 63_000n],
      ["chatgpt_pro_20x_cdk_1m", 100_000n, 96_100n],
      ["chatgpt_pro_50x_cdk_1m", 320_000n, 312_000n],
    ]);
    const merchant = runtime.repository.findMerchantByPartner("pt_demo_a")!;
    expect(runtime.repository.listProductGrants(merchant.id).filter(item => item.available).map(item => item.productCode).sort())
      .toEqual(managedGptProducts.map(item => item.productCode).sort());
    expect(() => runtime.catalog.requireGrant(merchant.id, "chatgpt_plus_1m")).toThrow("不在平台四款订阅套餐范围内");
  });

  it("opens API by default, permits a Chinese display name, and preserves the fixed partner id", () => {
    const created = runtime.agents.create(admin, {partnerId: "stable_partner", name: "Original Name"});
    const merchantId = created.merchant.id;
    expect(runtime.repository.getOperations("api_access", merchantId)).toMatchObject({enabled: true, depositId: "default:open-api"});
    const owner: Actor = {id: "owner", role: "agent_owner", merchantId};
    expect(runtime.apiAccess.summary(owner, merchantId)).toMatchObject({automaticAccess: true, canApply: false, apiDepositMinor: "0"});
    expect(() => runtime.apiAccess.apply(owner, merchantId, "无需申请", "retired-flow")).toThrow("无需申请或预存");
    runtime.agents.rename(owner, merchantId, {name: "中文代理商名称"});
    expect(runtime.repository.findMerchantById(merchantId)).toMatchObject({name: "中文代理商名称", partnerId: "stable_partner"});
  });

  it("forces platform collection at zero balance and unlocks agent collection only after real wallet credit", async () => {
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    const tenant = {merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.appId, keyId: credential.key.keyId};
    await expect(runtime.orders.create(tenant, {merchantOrderNo: "zero-agent-collect", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "agent_collect"})).rejects.toMatchObject({code: "collection_mode_denied"});
    const platformOrder = await runtime.orders.create(tenant, {merchantOrderNo: "zero-platform-collect", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    expect(platformOrder.collectionMode).toBe("platform_collect");
  });

  it("generates an idempotent historical settlement without paying, then requires manual pay and reconciliation", async () => {
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    const tenant = {merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.appId, keyId: credential.key.keyId};
    const created = await runtime.orders.create(tenant, {merchantOrderNo: "settlement-order", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    const at = new Date("2026-09-30T12:00:00.000Z");
    runtime.repository.updateOrder({...created, paymentStatus: "paid", paymentProviderRef: "ali_settlement",
      paymentReceivedMinor: created.saleAmountMinor, paymentFeeMinor: 0n, paidAt: at, createdAt: at, updatedAt: at});
    const attempt = runtime.repository.findPaymentAttemptByOrder(created.merchantId, created.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, status: "paid", providerRef: "ali_settlement",
      receivedMinor: created.saleAmountMinor, feeMinor: 0n, paidAt: at, createdAt: at, updatedAt: at});
    runtime.repository.insertFulfillment({id: "ful_settlement", merchantId: created.merchantId, orderId: created.id,
      attemptNo: 1, status: "succeeded", failureCode: null, message: null, accountEmailMasked: null,
      sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null}, mode: "cdk",
      voucherId: null, upstreamProvider: "zovocard", upstreamOrderId: "up_settlement", upstreamClientRequestId: "req_settlement",
      upstreamLookupToken: null, upstreamStatus: "completed", upstreamStage: "completed", upstreamQuoteMinor: 1576,
      upstreamCurrency: "USD", nextCheckAt: at, createdAt: at, finishedAt: at});
    runtime.repository.saveOperations("wallet_credit", {id: created.id, merchantId: created.merchantId,
      orderId: created.id, recognizedMinor: 2_500n, createdAt: at}, true);
    const earning: WalletEntry = {id: "earning:" + created.id, merchantId: created.merchantId, kind: "earning_release",
      procurementDelta: 0n, earningsDelta: 2_500n, frozenDelta: 0n, reference: created.id, actorId: "system", createdAt: at};
    runtime.repository.saveOperations("wallet_entry", earning, true);

    expect(runtime.dailySettlements.generate("2026-09-30")).toMatchObject({generated: true, count: 1});
    expect(runtime.dailySettlements.generate("2026-09-30")).toMatchObject({generated: false, count: 0});
    const statement = runtime.dailySettlements.list(admin).find(item => item.merchantId === created.merchantId)!;
    expect(statement).toMatchObject({status: "pending_payment", orderCount: 1, supplyAmount: "110.00",
      platformCost: "108.00", platformProfit: "2.00", agentEarnings: "25.00", payable: "25.00"});
    expect(runtime.repository.listOperations("wallet_entry", created.merchantId).reduce((sum, item) => sum + item.earningsDelta, 0n)).toBe(2_500n);
    expect(() => runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "alipay", reference: "202610010001", evidence: ""})).toThrow("付款凭证");
    const paid = runtime.dailySettlements.confirmPaid(admin, statement.id,
      {method: "alipay", reference: "202610010001", evidence: "支付宝账单截图已归档"});
    expect(paid.status).toBe("paid");
    expect(runtime.repository.listOperations("wallet_entry", created.merchantId).reduce((sum, item) => sum + item.earningsDelta, 0n)).toBe(0n);
    expect(runtime.dailySettlements.reconcile(admin, statement.id, "代理确认到账，金额流水一致").status).toBe("reconciled");
  });
});
