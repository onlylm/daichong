import {describe, expect, it} from "vitest";
import {listWorkspaceOrders} from "../src/operations/order-view.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import type {Order} from "../src/domain/model.js";
import {partnerFulfillmentDetails, partnerFulfillmentMessage, safeResultMessage} from "../src/modules/fulfillment-public.js";

function sampleOrder(): Order {
  return {
    id: "ord_mask", merchantId: "m1", appId: "app", merchantOrderNo: "M-MASK", productCode: "chatgpt_plus_cdk_1m",
    quantity: 1, saleAmountMinor: 13500n, supplyAmountMinor: 10900n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
    currency: "CNY", metadata: {}, paymentStatus: "paid", paymentProviderRef: "mock", paymentReceivedMinor: null, paymentFeeMinor: null,
    qrPayload: null, qrImageUrl: null, fulfillmentMode: "cdk", upstreamProduct: "gpt", upstreamPlan: "plus",
    fulfillmentUrl: "https://quefa.test/recharge/ord_mask", voucherCode: "QF-MASK-001", deliveryMode: "cdk",
    settlementId: null, paidAt: new Date(), expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
  };
}

describe("upstream masking for downstream consumers", () => {
  it("sanitizes supplier tokens from partner-visible messages", () => {
    expect(safeResultMessage("ZovoCard upstream https://supplier.example/order", "fallback")).toBe("fallback");
    expect(partnerFulfillmentMessage({
      id: "f1", merchantId: "m1", orderId: "ord_mask", attemptNo: 1, status: "running", failureCode: null,
      message: "ZovoCard 正在处理 https://supplier.example", accountEmailMasked: null,
      sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      mode: "direct", voucherId: null, upstreamProvider: "zovocard", upstreamOrderId: "up-1",
      upstreamClientRequestId: "req-1", upstreamLookupToken: null, upstreamStatus: "review", upstreamStage: "payment_review",
      upstreamQuoteMinor: 1000, upstreamCurrency: "USD", upstreamChargedMinor: null, upstreamCardLastFour: null,
      nextCheckAt: new Date(), createdAt: new Date(), finishedAt: null,
    })).toBe("充值结果确认中");
  });

  it("does not expose upstream-derived fulfillment fields by default", () => {
    const fulfillment: import("../src/domain/model.js").Fulfillment = {
      id: "f2", merchantId: "m1", orderId: "ord_mask", attemptNo: 1, status: "failed", failureCode: "payment_declined",
      message: "最终支付被拒", accountEmailMasked: null,
      sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      mode: "direct", voucherId: null, upstreamProvider: "zovocard", upstreamOrderId: "up-secret",
      upstreamClientRequestId: "req-2", upstreamLookupToken: null, upstreamStatus: "declined", upstreamStage: "declined",
      upstreamQuoteMinor: 1000, upstreamCurrency: "USD", upstreamChargedMinor: 98214, upstreamCardLastFour: "1234",
      nextCheckAt: new Date(), createdAt: new Date(), finishedAt: null,
    };
    expect(partnerFulfillmentDetails(fulfillment)).toEqual({});
    expect(partnerFulfillmentDetails(fulfillment, ["result_code", "card_last_four"])).toEqual({
      result_code: "declined",
      card_last_four: "1234",
    });
  });

  it("hides upstream trace fields from agent workspace order rows", () => {
    const repository = new MemoryRepository();
    repository.saveMerchant({id: "m1", partnerId: "p1", name: "代理 A", status: "active"});
    repository.insertOrder(sampleOrder());
    repository.insertCdkVoucher({
      id: "vch_mask", merchantId: "m1", orderId: "ord_mask", publicCode: "QF-MASK-001", plan: "plus",
      status: "unused", upstreamProvider: "zovocard", upstreamCdkId: "up-cdk-secret",
      upstreamCodePayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      issueAttempts: 0, nextAttemptAt: new Date(), failureCode: null, createdAt: new Date(), consumedAt: null,
    });
    repository.insertFulfillment({
      id: "ful_mask", merchantId: "m1", orderId: "ord_mask", attemptNo: 1, status: "succeeded", failureCode: null,
      message: "ZovoCard issued code upstream-raw-123", accountEmailMasked: null,
      sessionPayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      mode: "cdk", voucherId: "vch_mask", upstreamProvider: "zovocard", upstreamOrderId: "up-order-secret",
      upstreamClientRequestId: "req-3", upstreamLookupToken: null, upstreamStatus: "completed", upstreamStage: "completed",
      upstreamQuoteMinor: 1000, upstreamCurrency: "USD", nextCheckAt: new Date(), createdAt: new Date(), finishedAt: null,
    });
    const agent = {id: "agent", merchantId: "m1", role: "agent_owner" as const};
    const row = listWorkspaceOrders(repository, agent, ["m1"], new Map([["m1", "代理 A"]]), () => [], {page: 1, limit: 10}).data[0]!;
    expect(row.trace).toMatchObject({
      merchantOrderNo: "M-MASK",
      platformOrderId: "ord_mask",
      voucherCode: "QF-MASK-001",
      upstreamCdkId: null,
      upstreamCdkCode: null,
      fulfillmentReference: null,
    });
    expect(row.fulfillment?.message).not.toMatch(/zovo|upstream/i);
    expect(row.fulfillment).not.toHaveProperty("upstream_order_id");
    expect(row.fulfillment).not.toHaveProperty("charge_amount_minor");
  });
});
