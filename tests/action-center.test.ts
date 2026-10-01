import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("platform action center", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    await runtime.accounts.bootstrap("action-admin", "test-action-center-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    runtime.close();
  });

  it("returns executable operational queues to the platform administrator", async () => {
    const login = await loginPlatform(app, "action-admin", "test-action-center-password", "https://admin.tibo.ink");
    const response = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      counts: {tasks: 0, refunds: 0, settlements: 0, tickets: 0},
      tasks: [], refunds: [], settlements: [], tickets: [],
    });
  });

  it("queries only bounded pending queues and excludes system cases from agent tickets", async () => {
    const merchant = runtime.repository.listMerchants()[0]!, now = new Date();
    runtime.repository.saveOperations("ticket", {id: "tk_agent_pending", merchantId: merchant.id, orderId: null, title: "代理售后",
      category: "other", status: "open", assigneeId: null, version: 1, publicVersion: 1, createdBy: "agent-owner", createdAt: now, updatedAt: now}, true);
    runtime.repository.saveOperations("ticket", {id: "case_system_pending", merchantId: merchant.id, orderId: null, title: "系统异常",
      category: "recharge", status: "open", systemCase: {issueKey: "test", entityId: "missing-order"}, assigneeId: null,
      version: 1, publicVersion: 1, createdBy: "system", createdAt: now, updatedAt: now}, true);
    runtime.repository.saveOperations("daily_settlement", {id: "ds_pending", merchantId: merchant.id, businessDate: "2026-10-01",
      periodFrom: now, periodTo: now, status: "pending_payment", orderIds: [], orderCount: 0, supplyAmountMinor: 0n,
      agentEarningsMinor: 100n, platformCostMinor: 0n, platformProfitMinor: 0n, payableMinor: 100n, currency: "CNY",
      payoutMethod: null, payoutReference: null, payoutEvidence: null, note: null, confirmedBy: null, version: 1,
      generatedAt: now, paidAt: null, reconciledAt: null, updatedAt: now}, true);
    runtime.repository.saveOperations("invoice_application", {id: "inv_pending", merchantId: merchant.id, orderId: "missing-order",
      requestKey: "invoice-action-center", titleType: "enterprise", invoiceTitle: "测试企业", taxIdEncrypted: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: now},
      recipientEmail: "invoice@example.com", contactName: "测试联系人", contactPhone: null, remark: null, invoiceAmountMinor: 10000n,
      feeRateBps: 500, feeAmountMinor: 500n, category: "技术服务费", status: "submitted", paymentId: "invpay_test",
      providerRef: "alipay-test", paidAt: now, submittedAt: now, reviewNote: null, invoiceNo: null, issuedAt: null,
      version: 1, createdBy: "agent-owner", createdAt: now, updatedAt: now}, true);
    runtime.repository.insertRefund({id: "rf_pending", merchantId: merchant.id, orderId: "missing-order", merchantRefundNo: "test-refund",
      type: "full", amountMinor: 100n, status: "requested", reason: "测试退款", failureCode: null, providerRefundNo: null,
      createdAt: now, refundedAt: null});

    const login = await loginPlatform(app, "action-admin", "test-action-center-password", "https://admin.tibo.ink");
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const response = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({counts: {tasks: 1, refunds: 1, settlements: 1, tickets: 1, invoices: 1}});
    expect(response.json().data.tickets.map((item: {id: string}) => item.id)).toEqual(["tk_agent_pending"]);
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["refund", "daily_settlement", "ticket", "invoice_application"]));
  });
});
