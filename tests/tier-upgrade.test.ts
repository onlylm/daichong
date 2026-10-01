import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {evaluateTierUpgradeEligibility} from "../src/operations/tier-upgrade.js";
import type {Actor} from "../src/operations/model.js";

describe("tier upgrade deposit and self-collect requirements", () => {
  let r: Runtime;
  const admin: Actor = {id: "admin", role: "platform_admin", merchantId: null};
  beforeEach(() => {
    r = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
  });
  afterEach(() => r.close());

  it("seeds preferred/gold with modest deposit and self-collect share caps", () => {
    const rules = r.agents.rules();
    const preferred = rules.levels.find(level => level.code === "preferred")!;
    const gold = rules.levels.find(level => level.code === "gold")!;
    expect(preferred.minDepositMinor).toBe("300000");
    expect(preferred.minAgentCollectShareBps).toBe(1500);
    expect(gold.minDepositMinor).toBe("1000000");
    expect(gold.minAgentCollectShareBps).toBe(2000);
    expect(rules.levels.find(level => level.code === "standard")!.collectionModes).toContain("agent_collect");
  });

  it("blocks preferred upgrade without deposit or self-collect share", () => {
    const merchantId = r.repository.findMerchantByPartner("pt_demo_a")!.id;
    const rules = r.agents.rules();
    const check = evaluateTierUpgradeEligibility(r.repository, merchantId, "preferred", rules);
    expect(check.eligible).toBe(false);
    expect(check.missing.some(msg => msg.includes("采购余额"))).toBe(true);
    expect(check.missing.some(msg => msg.includes("自收款"))).toBe(true);
  });

  it("rejects applyTier when upgrade requirements are unmet", () => {
    const merchantId = r.repository.findMerchantByPartner("pt_demo_a")!.id;
    const owner: Actor = {id: "owner", role: "agent_owner", merchantId};
    expect(() => r.agents.applyTier(owner, merchantId, "preferred", "希望升级优选会员", "tierreq01")).toThrow(/采购余额|自收款|供货/);
  });

  it("allows applyTier after deposit, supply and self-collect share are satisfied", () => {
    const merchantId = r.repository.findMerchantByPartner("pt_demo_a")!.id;
    const owner: Actor = {id: "owner", role: "agent_owner", merchantId};
    const deposit = r.wallets.requestDeposit(owner, merchantId, "3000.00", "tierdep02", "bank ref");
    r.wallets.reviewDeposit(admin, deposit.id, true, "receipt:tierdep02");
    const now = new Date();
    const session = {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null};
    const seed = (id: string, mode: "platform_collect" | "agent_collect", provider: string, supplyAmountMinor = 11_000n) => {
      r.repository.insertOrder({id, merchantId, appId: "app_demo_a", merchantOrderNo: id, collectionMode: mode, deliveryMode: "cdk",
        productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmountMinor: supplyAmountMinor, supplyAmountMinor, ordinaryRefundedMinor: 0n,
        priceAdjustmentRefundedMinor: 0n, currency: "CNY", metadata: {}, paymentStatus: "paid", paymentProviderRef: "p", paymentReceivedMinor: 11_000n,
        paymentFeeMinor: 0n, qrPayload: null, qrImageUrl: null, fulfillmentMode: "cdk", upstreamProduct: "gpt", upstreamPlan: "plus",
        fulfillmentUrl: "https://example.test/f", voucherCode: null, settlementId: null, paidAt: now, expiresAt: now, createdAt: now, updatedAt: now});
      r.repository.insertPaymentAttempt({id: "pay_" + id, merchantId, orderId: id, provider, status: "paid", providerRef: "p", requestedMinor: 11_000n,
        receivedMinor: 11_000n, feeMinor: 0n, qrPayload: null, expiresAt: now, paidAt: now, createdAt: now, updatedAt: now});
      r.repository.insertFulfillment({id: "ful_" + id, merchantId, orderId: id, attemptNo: 1, status: "succeeded", failureCode: null, message: null,
        accountEmailMasked: null, sessionPayload: session, mode: "cdk", voucherId: null, upstreamProvider: "zovocard", upstreamOrderId: "up_" + id,
        upstreamClientRequestId: id, upstreamLookupToken: null, upstreamStatus: "done", upstreamStage: "done", upstreamQuoteMinor: null,
        upstreamCurrency: "CNY", nextCheckAt: now, createdAt: now, finishedAt: null});
    };
    seed("bulk_pc", "platform_collect", "alipay_page", 8_500_000n);
    for (let i = 0; i < 15; i++) seed("ac" + i, "agent_collect", "agent_wallet", 100_000n);
    const ticket = r.agents.applyTier(owner, merchantId, "preferred", "已满足预存与自收款占比", "tierreq02");
    expect(ticket.tierApplication?.targetTier).toBe("preferred");
  });
});
