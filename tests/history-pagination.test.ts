import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("workspace history pagination", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    await runtime.accounts.bootstrap("history-admin", "test-history-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    runtime.close();
  });

  it("pages tickets, invoices and daily settlements in SQLite instead of loading full history", async () => {
    const merchant = runtime.repository.listMerchants()[0]!, base = Date.parse("2026-10-01T00:00:00.000Z");
    for (let index = 0; index < 13; index++) {
      const timestamp = new Date(base + index * 60_000);
      runtime.repository.saveOperations("ticket", {id: `tk_page_${index}`, merchantId: merchant.id, orderId: null,
        title: `分页工单 ${index}`, category: "other", status: index % 2 === 0 ? "open" : "resolved",
        assigneeId: null, version: 1, publicVersion: 1, createdBy: "agent-owner", createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("invoice_application", {id: `inv_page_${index}`, merchantId: merchant.id,
        orderId: `order_page_${index}`, requestKey: `invoice-page-${index}`, titleType: "enterprise",
        invoiceTitle: `分页企业 ${index}`, taxIdEncrypted: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: timestamp},
        recipientEmail: `invoice-${index}@example.com`, contactName: "测试联系人", contactPhone: null, remark: null,
        invoiceAmountMinor: 10_000n, feeRateBps: 500, feeAmountMinor: 500n, category: "技术服务费",
        status: index % 2 === 0 ? "submitted" : "issued", paymentId: `invpay_${index}`, providerRef: `alipay-${index}`,
        paidAt: timestamp, submittedAt: timestamp, reviewNote: null, invoiceNo: null, issuedAt: index % 2 ? timestamp : null,
        version: 1, createdBy: "agent-owner", createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("daily_settlement", {id: `ds_page_${index}`, merchantId: merchant.id,
        businessDate: `2026-09-${String(index + 1).padStart(2, "0")}`, periodFrom: timestamp, periodTo: timestamp,
        status: index % 2 === 0 ? "pending_payment" : "reconciled", orderIds: [], orderCount: 0,
        supplyAmountMinor: 0n, agentEarningsMinor: 100n, platformCostMinor: 0n, platformProfitMinor: 0n,
        payableMinor: 100n, currency: "CNY", payoutMethod: null, payoutReference: null, payoutEvidence: null,
        note: null, confirmedBy: null, version: 1, generatedAt: timestamp, paidAt: null,
        reconciledAt: index % 2 ? timestamp : null, updatedAt: timestamp}, true);
    }
    runtime.repository.saveOperations("ticket", {id: "tk_archived", merchantId: merchant.id, orderId: null,
      title: "已归档工单", category: "other", status: "open", archivedAt: new Date(), archiveReason: "测试清理",
      archivedBy: "history-admin", assigneeId: null, version: 1, publicVersion: 1, createdBy: "system",
      createdAt: new Date(), updatedAt: new Date()}, true);

    const login = await loginPlatform(app, "history-admin", "test-history-password", "https://admin.tibo.ink");
    const headers = {origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!};
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const [tickets, invoices, settlements] = await Promise.all([
      app.inject({method: "GET", url: `/workspace/api/tickets?merchantId=${merchant.id}&status=open&page=2&limit=3`, headers}),
      app.inject({method: "GET", url: `/workspace/api/invoices?merchantId=${merchant.id}&status=submitted&page=2&limit=3`, headers}),
      app.inject({method: "GET", url: `/workspace/api/daily-settlements?merchantId=${merchant.id}&status=pending_payment&page=2&limit=3`, headers}),
    ]);

    expect([tickets.statusCode, invoices.statusCode, settlements.statusCode]).toEqual([200, 200, 200]);
    expect(tickets.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(invoices.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(settlements.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(tickets.json().data).toHaveLength(3);
    expect(tickets.json().data.every((item: {status: string; merchantId: string}) => item.status === "open" && item.merchantId === merchant.id)).toBe(true);
    expect(tickets.json().data.some((item: {id: string}) => item.id === "tk_archived")).toBe(false);
    expect(invoices.json().data.every((item: {status: string}) => item.status === "submitted")).toBe(true);
    expect(settlements.json().data.every((item: {status: string}) => item.status === "pending_payment")).toBe(true);
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["ticket", "invoice_application", "daily_settlement"]));
    expect(query.mock.calls.every(call => (call[1] as {limit: number}).limit === 3)).toBe(true);
  });
});
