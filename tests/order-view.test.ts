import {describe, expect, it} from "vitest";
import {listWorkspaceOrders, workspacePayUrl} from "../src/operations/order-view.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import type {Order} from "../src/domain/model.js";

function sampleOrder(paymentStatus: Order["paymentStatus"]): Order {
  return {
    id: "ord_test", merchantId: "merchant", appId: "app", merchantOrderNo: "M1", productCode: "chatgpt_plus_cdk_1m",
    quantity: 1, saleAmountMinor: 13500n, supplyAmountMinor: 10900n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
    currency: "CNY", metadata: {}, paymentStatus, paymentProviderRef: "mock", paymentReceivedMinor: null, paymentFeeMinor: null,
    qrPayload: "https://quefa.test/pay/test", qrImageUrl: null, fulfillmentMode: "cdk", upstreamProduct: "gpt", upstreamPlan: "plus_1m",
    fulfillmentUrl: "https://quefa.test/recharge/ord_test", voucherCode: null, settlementId: null, paidAt: null,
    expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date(),
  };
}

describe("workspacePayUrl", () => {
  it("returns pay link only while payment is pending", () => {
    expect(workspacePayUrl(sampleOrder("pending"))).toBe("https://quefa.test/pay/test");
    expect(workspacePayUrl(sampleOrder("paid"))).toBeNull();
    expect(workspacePayUrl(sampleOrder("expired"))).toBeNull();
  });
});

describe("listWorkspaceOrders", () => {
  it("paginates, filters by product and includes merchant names", () => {
    const repository = new MemoryRepository();
    repository.saveMerchant({id: "m1", partnerId: "p1", name: "代理 A", status: "active"});
    repository.saveMerchant({id: "m2", partnerId: "p2", name: "代理 B", status: "active"});
    const base = sampleOrder("paid");
    repository.insertOrder({...base, id: "ord_1", merchantId: "m1", merchantOrderNo: "M1", productCode: "chatgpt_plus_cdk_1m", createdAt: new Date("2026-09-27T10:00:00Z")});
    repository.insertOrder({...base, id: "ord_2", merchantId: "m2", merchantOrderNo: "M2", productCode: "chatgpt_go_cdk_1m", createdAt: new Date("2026-09-27T11:00:00Z")});
    repository.insertOrder({...base, id: "ord_3", merchantId: "m1", merchantOrderNo: "M3", productCode: "chatgpt_plus_cdk_1m", createdAt: new Date("2026-09-27T09:00:00Z")});
    const actor = {id: "admin", merchantId: null, role: "platform_admin" as const};
    const names = new Map([["m1", "代理 A"], ["m2", "代理 B"]]);
    const filtered = listWorkspaceOrders(repository, actor, ["m1", "m2"], names, () => [], {productCode: "chatgpt_plus_cdk_1m", page: 1, limit: 10});
    expect(filtered.meta.total).toBe(2);
    expect(filtered.data.map(item => item.id)).toEqual(["ord_1", "ord_3"]);
    const page = listWorkspaceOrders(repository, actor, ["m1", "m2"], names, () => [], {page: 1, limit: 2});
    expect(page.meta).toMatchObject({total: 3, page: 1, limit: 2, pages: 2});
    expect(page.data[0]?.merchantName).toBe("代理 B");
  });

  it("searches by merchant order no and exposes trace fields for platform", () => {
    const repository = new MemoryRepository();
    repository.saveMerchant({id: "m1", partnerId: "p1", name: "代理 A", status: "active"});
    const base = sampleOrder("paid");
    repository.insertOrder({
      ...base, id: "ord_trace", merchantId: "m1", merchantOrderNo: "SHOP-1001", productCode: "chatgpt_plus_cdk_1m",
      voucherCode: "QF-TRACE-001", deliveryMode: "cdk", createdAt: new Date("2026-09-27T12:00:00Z"),
    });
    repository.insertCdkVoucher({
      id: "vch_trace", merchantId: "m1", orderId: "ord_trace", publicCode: "QF-TRACE-001", plan: "plus",
      status: "unused", upstreamProvider: "zovocard", upstreamCdkId: "up-cdk-9001",
      upstreamCodePayload: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      issueAttempts: 0, nextAttemptAt: new Date(), failureCode: null, createdAt: new Date(), consumedAt: null,
    });
    const actor = {id: "admin", merchantId: null, role: "platform_admin" as const};
    const found = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {search: "SHOP-1001", page: 1, limit: 10});
    expect(found.data).toHaveLength(1);
    expect(found.data[0]?.trace).toMatchObject({
      merchantOrderNo: "SHOP-1001",
      platformOrderId: "ord_trace",
      voucherCode: "QF-TRACE-001",
      upstreamCdkId: "up-cdk-9001",
      upstreamCdkCode: null,
    });
    const byUpstream = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {search: "up-cdk-9001", page: 1, limit: 10});
    expect(byUpstream.data).toHaveLength(1);
  });

  it("searches by recharge email using the same masked format stored on fulfillment", () => {
    const repository = new MemoryRepository();
    repository.saveMerchant({id: "m1", partnerId: "p1", name: "代理 A", status: "active"});
    const base = sampleOrder("paid");
    repository.insertOrder({
      ...base, id: "ord_mail", merchantId: "m1", merchantOrderNo: "SHOP-MAIL", productCode: "chatgpt_plus_cdk_1m",
      deliveryMode: "auto_recharge", createdAt: new Date("2026-09-27T13:00:00Z"),
    });
    const session = {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: null};
    repository.insertFulfillment({
      id: "ful_mail", merchantId: "m1", orderId: "ord_mail", attemptNo: 1, status: "succeeded", failureCode: null, message: null,
      accountEmailMasked: "u***r@example.com", sessionPayload: session, mode: "direct", voucherId: null, upstreamProvider: "zovocard",
      upstreamOrderId: "up_mail", upstreamClientRequestId: "req_mail", upstreamLookupToken: null, upstreamStatus: "completed",
      upstreamStage: "completed", upstreamQuoteMinor: 2000, upstreamCurrency: "USD", nextCheckAt: new Date(), createdAt: new Date(), finishedAt: null,
    });
    const actor = {id: "admin", merchantId: null, role: "platform_admin" as const};
    const byEmail = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {search: "user@example.com", page: 1, limit: 10});
    expect(byEmail.data).toHaveLength(1);
    expect(byEmail.data[0]?.id).toBe("ord_mail");
    const byMasked = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {search: "u***r@example.com", page: 1, limit: 10});
    expect(byMasked.data).toHaveLength(1);
    const miss = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {search: "other@example.com", page: 1, limit: 10});
    expect(miss.data).toHaveLength(0);
  });

  it("filters fully refunded orders into their own workspace queue", () => {
    const repository = new MemoryRepository();
    repository.saveMerchant({id: "m1", partnerId: "p1", name: "代理 A", status: "active"});
    repository.insertOrder({...sampleOrder("paid"), id: "ord_paid", merchantId: "m1", merchantOrderNo: "PAID"});
    repository.insertOrder({...sampleOrder("refunded"), id: "ord_refunded", merchantId: "m1", merchantOrderNo: "REFUNDED"});
    const actor = {id: "admin", merchantId: null, role: "platform_admin" as const};
    const result = listWorkspaceOrders(repository, actor, ["m1"], new Map([["m1", "代理 A"]]), () => [],
      {status: "refunded", page: 1, limit: 10});
    expect(result.data.map(item => item.id)).toEqual(["ord_refunded"]);
  });
});
