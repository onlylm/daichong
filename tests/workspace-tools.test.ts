import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order} from "../src/domain/model.js";
import type {AccountRole} from "../src/operations/model.js";
import {WorkerHealthReporter} from "../src/worker/worker-health.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("SQLite workspace search, audit and runtime routes", () => {
  const adminOrigin = "https://admin.tibo.ink", partnerOrigin = "https://tibo.ink";
  const password = "workspace-tools-test-password";
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: partnerOrigin, ADMIN_BASE_URL: adminOrigin});
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>, base: Order;
  let merchantId: string, otherMerchantId: string;

  beforeEach(async () => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const admin = await runtime.accounts.bootstrap("tools-admin", password);
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    merchantId = credential.merchant.id;
    otherMerchantId = runtime.repository.findMerchantByPartner("pt_demo_b")!.id;
    await runtime.accounts.registerOwner({username: "tools-agent", displayName: "搜索测试代理", password, merchantId});
    base = await runtime.orders.create({merchantId, partnerId: credential.merchant.partnerId, appId: credential.app.id,
      keyId: credential.key.keyId}, {merchantOrderNo: "seed-tools-order", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    app = await buildApp(config, runtime);
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); runtime.close(); });

  async function login(role: "admin" | "agent" | "auditor" | "finance" = "admin") {
    const origin = role === "agent" ? partnerOrigin : adminOrigin;
    if (role === "auditor" || role === "finance") {
      // Seed a historical role, not the disabled platform-staff creation flow.
      const original = runtime.repository.listOperations("account").find(account => account.role === "platform_admin")!;
      runtime.repository.saveOperations("account", {...original, id: "tools-" + role, username: "tools-" + role,
        role: ("platform_" + role) as AccountRole, mfaEnabled: false, mfaSecret: null, mfaLastUsedStep: null}, true);
    }
    const response = role === "agent" ? await app.inject({method: "POST", url: "/workspace/api/auth/login",
      headers: {origin}, payload: {username: "tools-agent", password}})
      : await loginPlatform(app, "tools-" + role, password, origin);
    expect(response.statusCode, response.body).toBe(200);
    return {origin, cookie: String(response.headers["set-cookie"]).split(";")[0]!};
  }

  function seedOrder(id: string, scope = merchantId, merchantOrderNo = id, at = new Date("2026-10-02T02:00:00.000Z")) {
    const order: Order = {...base, id, merchantId: scope, merchantOrderNo, createdAt: at, updatedAt: at};
    runtime.repository.insertOrder(order);
    return order;
  }

  function seedSearch(scope: string, suffix: string) {
    const order = seedOrder("ord_SEARCH_" + suffix, scope);
    runtime.repository.insertCdkVoucher({id: "voucher_SEARCH_" + suffix, merchantId: scope, orderId: order.id,
      publicCode: "CUSTOM-SEARCH-FULL-CODE-" + suffix, plan: "plus", status: "unused", upstreamProvider: "supplier-private",
      upstreamCdkId: "UPSTREAM-CDK-SECRET-" + suffix,
      upstreamCodePayload: {ciphertext: "ENCRYPTED-CREDENTIAL-SECRET", iv: "private-iv", authTag: "private-tag", keyVersion: "v1", clearedAt: null},
      issueAttempts: 1, nextAttemptAt: order.createdAt, failureCode: null, createdAt: order.createdAt, consumedAt: null});
    runtime.repository.insertPaymentAttempt({id: "pay_SEARCH_" + suffix, merchantId: scope, orderId: order.id,
      provider: "alipay_page", status: "paid", providerRef: "SEARCH-ALIPAY-" + suffix, requestedMinor: 13_500n,
      receivedMinor: 13_500n, feeMinor: 0n, qrPayload: "https://pay.example.com/SECRET-TOKEN", expiresAt: order.expiresAt,
      paidAt: order.createdAt, createdAt: order.createdAt, updatedAt: order.createdAt});
    runtime.repository.saveOperations("wallet_entry", {id: "wallet_SEARCH_" + suffix, merchantId: scope,
      kind: "adjustment", procurementDelta: 100n, earningsDelta: 0n, frozenDelta: 0n, reference: "SEARCH-REFERENCE-" + suffix,
      actorId: "test", createdAt: order.createdAt}, true);
    return order;
  }

  it("pages every search group beyond ten with SQL and never falls back to full historical lists", async () => {
    for (let index = 0; index < 13; index++) seedSearch(index % 2 ? otherMerchantId : merchantId, String(index).padStart(2, "0"));
    const headers = await login();
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const full = [vi.spyOn(runtime.repository, "listOrdersInternal"), vi.spyOn(runtime.repository, "listOrders"),
      vi.spyOn(runtime.repository, "listMerchants"), vi.spyOn(runtime.repository, "listOperations")];
    const response = await app.inject({url: "/workspace/api/search?q=SEARCH&kind=all&page=2", headers});
    expect(response.statusCode, response.body).toBe(200);
    const groups = response.json().data.groups;
    for (const kind of ["order", "cdk", "payment", "wallet"]) {
      const group = groups.find((item: {kind: string}) => item.kind === kind);
      expect(group.meta).toMatchObject({total: 13, page: 2, limit: 10, pages: 2});
      expect(group.data).toHaveLength(3);
    }
    expect(response.json().data.total).toBe(52);
    expect(query.mock.calls.every(call => (call[1] as {limit: number}).limit === 10)).toBe(true);
    for (const spy of full) expect(spy).not.toHaveBeenCalled();
  });

  it("isolates agent search and suppresses platform payment and agent directories", async () => {
    const own = seedSearch(merchantId, "own"), foreign = seedSearch(otherMerchantId, "foreign"), headers = await login("agent");
    const response = await app.inject({url: "/workspace/api/search?q=SEARCH&kind=all", headers});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.groups.map((group: {kind: string}) => group.kind)).toEqual(["order", "cdk", "wallet"]);
    expect(response.json().data.total).toBe(3);
    expect(response.body).toContain(own.id);
    expect(response.body).not.toContain(foreign.id);
    expect(response.body).not.toContain(otherMerchantId);
    for (const kind of ["payment", "agent"]) {
      const denied = await app.inject({url: "/workspace/api/search?q=SEARCH&kind=" + kind, headers});
      expect(denied.json().data).toMatchObject({total: 0, groups: []});
    }
    const scoped = await app.inject({url: "/workspace/api/search?q=SEARCH&merchantId=" + otherMerchantId, headers});
    expect(scoped.statusCode).toBe(400);
  });

  it("returns only safe search projections and never matches upstream CDKs or credentials", async () => {
    seedSearch(merchantId, "private");
    const headers = await login();
    const response = await app.inject({url: "/workspace/api/search?q=SEARCH&kind=all", headers});
    expect(response.statusCode).toBe(200);
    for (const secret of ["UPSTREAM-CDK-SECRET", "ENCRYPTED-CREDENTIAL-SECRET", "supplier-private", "SECRET-TOKEN",
      "CUSTOM-SEARCH-FULL-CODE-private", "upstreamCodePayload", "authTag", "passwordHash"]) expect(response.body).not.toContain(secret);
    const cdk = response.json().data.groups.find((group: {kind: string}) => group.kind === "cdk").data[0];
    expect(Object.keys(cdk).sort()).toEqual(["description", "id", "occurredAt", "orderId", "title"]);
    for (const needle of ["UPSTREAM-CDK-SECRET", "ENCRYPTED-CREDENTIAL-SECRET", "SECRET-TOKEN"]) {
      const result = await app.inject({url: "/workspace/api/search?q=" + encodeURIComponent(needle), headers});
      expect(result.json().data.total).toBe(0);
    }
  });

  it("treats percent and underscore as literal search text, not SQL wildcards", async () => {
    seedOrder("ord_literal_exact", merchantId, "INV%_001");
    seedOrder("ord_literal_other", merchantId, "INVab001");
    const headers = await login();
    const response = await app.inject({url: "/workspace/api/search?q=" + encodeURIComponent("%_") + "&kind=order", headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().data.groups[0]).toMatchObject({meta: {total: 1}, data: [{id: "ord_literal_exact"}]});
  });

  it("paginates global and tenant audit by Beijing day including platform-only records without full-list scans", async () => {
    const order = seedOrder("ord_audit_tools");
    for (let index = 0; index < 13; index++) runtime.repository.appendAudit({id: "tools_audit_" + index,
      merchantId: index % 2 ? null : merchantId, actorType: "platform_user", actorId: "tools-admin",
      action: "tools.audit.payment", targetType: "order", targetId: order.id, requestId: "audit-request-" + index,
      createdAt: new Date(Date.parse("2026-10-01T16:00:00.000Z") + index * 60_000)});
    runtime.repository.appendAudit({id: "tools_audit_before", merchantId, actorType: "platform_user", actorId: "tools-admin",
      action: "tools.audit.payment", targetType: "order", targetId: order.id, requestId: "audit-before",
      createdAt: new Date("2026-10-01T15:59:59.999Z")});
    runtime.repository.appendAudit({id: "tools_audit_after", merchantId, actorType: "platform_user", actorId: "tools-admin",
      action: "tools.audit.payment", targetType: "order", targetId: order.id, requestId: "audit-after",
      createdAt: new Date("2026-10-02T16:00:00.000Z")});
    const headers = await login(), fullAudit = vi.spyOn(runtime.repository, "listAudit"), fullMerchants = vi.spyOn(runtime.repository, "listMerchants");
    const response = await app.inject({url: "/workspace/api/audit?action=tools.audit&from=2026-10-02&to=2026-10-02&page=2&limit=5", headers});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().meta).toMatchObject({total: 13, page: 2, limit: 5, pages: 3});
    expect(response.json().data).toHaveLength(5);
    expect(response.json().data.some((item: {merchantId: string | null}) => item.merchantId === null)).toBe(true);
    expect(response.json().data.every((item: {orderId: string}) => item.orderId === order.id)).toBe(true);
    const scoped = await app.inject({url: "/workspace/api/audit?action=tools.audit&from=2026-10-02&to=2026-10-02&merchantId=" + merchantId, headers});
    expect(scoped.json().meta.total).toBe(7);
    expect(scoped.json().data.every((item: {merchantId: string}) => item.merchantId === merchantId)).toBe(true);
    expect(fullAudit).not.toHaveBeenCalled();
    expect(fullMerchants).not.toHaveBeenCalled();
  });

  it("resolves an audit record for a refund or fulfillment to its exact order", async () => {
    const order = seedOrder("ord_audit_linked"), at = new Date();
    runtime.repository.insertRefund({id: "refund_audit_link", merchantId, orderId: order.id, merchantRefundNo: "audit-link",
      type: "partial", amountMinor: 100n, status: "requested", reason: "test", failureCode: null, createdAt: at, refundedAt: null});
    runtime.repository.insertFulfillment({id: "ful_audit_link", merchantId, orderId: order.id, attemptNo: 1,
      status: "failed", failureCode: "test_failure", message: "test", accountEmailMasked: null,
      sessionPayload: {ciphertext: "PRIVATE-SESSION", iv: null, authTag: null, keyVersion: "test", clearedAt: null},
      mode: "cdk", voucherId: null, upstreamProvider: "private-provider", upstreamOrderId: "private-upstream-order",
      upstreamClientRequestId: "private-client", upstreamLookupToken: "private-lookup", upstreamStatus: null,
      upstreamStage: null, upstreamQuoteMinor: null, upstreamCurrency: null, nextCheckAt: at, createdAt: at, finishedAt: at});
    for (const [targetType, targetId] of [["refund", "refund_audit_link"], ["fulfillment", "ful_audit_link"]]) {
      runtime.repository.appendAudit({id: "audit_" + targetType, merchantId, actorType: "platform_user", actorId: "tools-admin",
        action: "tools.link", targetType: targetType!, targetId: targetId!, requestId: "req_" + targetType, createdAt: at});
    }
    const headers = await login();
    const response = await app.inject({url: "/workspace/api/audit?action=tools.link", headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
    expect(response.json().data.every((item: {orderId: string}) => item.orderId === order.id)).toBe(true);
    expect(response.body).not.toContain("PRIVATE-SESSION");
    expect(response.body).not.toContain("private-upstream-order");
    const exact = await app.inject({url: "/workspace/api/audit?target=refund_audit_link", headers});
    expect(exact.json().data).toHaveLength(1);
    expect(exact.json().data[0]).toMatchObject({targetId: "refund_audit_link", orderId: order.id});
  });

  it("enforces audit role permissions and validates date ranges", async () => {
    const agent = await login("agent"), finance = await login("finance"), auditor = await login("auditor");
    for (const headers of [agent, finance]) expect((await app.inject({url: "/workspace/api/audit", headers})).statusCode).toBe(403);
    expect((await app.inject({url: "/workspace/api/audit", headers: auditor})).statusCode).toBe(200);
    for (const query of ["from=2026-02-30", "from=2026-10-03&to=2026-10-02", "page=0", "limit=101"]) {
      expect((await app.inject({url: "/workspace/api/audit?" + query, headers: auditor})).statusCode).toBe(400);
    }
  });

  it("limits runtime details to admins and reports absent backup verification as undetected", async () => {
    const agent = await login("agent"), auditor = await login("auditor"), admin = await login();
    expect((await app.inject({url: "/workspace/api/runtime-status", headers: agent})).statusCode).toBe(403);
    expect((await app.inject({url: "/workspace/api/runtime-status", headers: auditor})).statusCode).toBe(403);
    const response = await app.inject({url: "/workspace/api/runtime-status", headers: admin});
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({worker: {status: "missing"}, backup: {status: "undetected", checkedAt: null}, queue: {active: 0}});
    expect(response.json().data).not.toHaveProperty("systemHealthy");
    expect(response.headers["cache-control"]).toBe("no-store");
    const reporter = new WorkerHealthReporter(runtime.repository, ["fulfillment"]);
    reporter.start("fulfillment"); reporter.fail("fulfillment"); reporter.persist();
    const degraded = await app.inject({url: "/workspace/api/runtime-status", headers: admin});
    expect(degraded.json().data.worker).toMatchObject({status: "degraded", failedLanes: ["fulfillment"]});
    expect(degraded.json().data.backup.status).toBe("undetected");
  });
});
