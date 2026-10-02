import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import YAML from "yaml";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import type {TenantContext} from "../src/domain/model.js";
import {safeBusinessMessage} from "../src/domain/safe-business-message.js";
import {partnerFulfillmentSnapshot} from "../src/modules/fulfillment-public.js";
import {workspaceOrderDetail} from "../src/operations/order-view.js";
import {UpstreamRequestError} from "../src/upstream/recharge-provider.js";
import {ZovoCardRechargeProvider} from "../src/upstream/zovocard-provider.js";
import {historicalDirectOrder, publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";

describe("consistent safe recharge feedback", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  let runtime: Runtime;
  let tenant: TenantContext;
  beforeEach(() => {
    runtime = createRuntime(config); publishTestRechargeProduct(runtime); fundAndApproveApi(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: config.demoPartnerId, keyId: config.demoKeyId, appId: bundle.app.id};
  });
  afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); runtime.close();});
  async function paidOrder(direct = true) {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    const paid = runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "test:" + order.id, receivedMinor: order.saleAmountMinor});
    return direct ? historicalDirectOrder(runtime, paid) : paid;
  }
  async function signedGet(app: Awaited<ReturnType<typeof buildApp>>, path: string) {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    return app.inject({method: "GET", url: path, headers: {"x-partner-id": tenant.partnerId, "x-key-id": tenant.keyId,
      "x-timestamp": timestamp, "x-nonce": nonce,
      "x-signature": signRequest({method: "GET", path, rawQuery: "", timestamp, nonce, keyId: tenant.keyId, idempotencyKey: "", rawBody: Buffer.alloc(0)}, config.demoClientSecret)}});
  }

  it.each(["cancelled", "failed"] as const)("agrees on refund next_action in both query routes and webhook for %s", async status => {
    const order = await paidOrder(), task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "isolated-credential"});
    if (status === "failed") runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "private-provider-id", lookupToken: null, status: "declined", stage: "declined", accountEmail: null, quotedAmountMinor: null, currency: null, message: null});
    const recovered = runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "refund");
    const event = runtime.repository.listOutbox(tenant.merchantId).filter(value => value.payload.fulfillment_id === task.id).at(-1)!;
    expect(event.payload).toMatchObject({status, recovery_action: "refund", next_action: "none", retry_allowed: false});
    const app = await buildApp(config, runtime);
    try {
      const redemption = await signedGet(app, "/v1/redemptions/" + task.id);
      const attempts = await signedGet(app, "/v1/orders/" + order.id + "/fulfillments");
      expect(redemption.statusCode).toBe(200); expect(attempts.statusCode).toBe(200);
      for (const view of [redemption.json().data, attempts.json().data[0], partnerFulfillmentSnapshot(recovered)]) {
        expect(view).toMatchObject({status, recovery_action: "refund", next_action: "none", retry_allowed: false});
        expect(view).not.toHaveProperty("diagnostic");
      }
      const schema = YAML.parse(readFileSync(new URL("../openapi/openapi.yaml", import.meta.url), "utf8")).components.schemas;
      for (const key of Object.keys(redemption.json().data)) expect(schema.RedemptionEnvelope.properties.data.properties).toHaveProperty(key);
      expect(schema.RechargeErrorCategory.enum).toContain(null);
    } finally {await app.close();}
  });

  it.each([
    ["session_invalid", "credential", "credential_invalid"],
    ["precheck_rejected", "account", "precheck_rejected"],
    ["upstream_product_unavailable", "product", "product_unavailable"],
  ])("classifies known %s without disclosing response secrets", async (code, category, diagnosticCode) => {
    const order = await paidOrder(), task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "private-credential"});
    vi.spyOn(runtime.upstream, "submitDirect").mockRejectedValue(new UpstreamRequestError(code!, false, "password=private-password-for-attack"));
    const failed = (await runtime.fulfillments.processOne())!;
    expect(failed).toMatchObject({status: "failed", diagnostic: {code: diagnosticCode, phase: "submit"}});
    const event = runtime.repository.listOutbox(tenant.merchantId).find(value => value.eventType === "fulfillment.failed")!;
    expect(event.payload).toMatchObject({error_category: category, retry_allowed: true, next_action: "resubmit"});
    expect(JSON.stringify(event.payload)).not.toMatch(/diagnostic|private-password|private-credential/);
    const admin = workspaceOrderDetail(runtime.repository, {id: "admin", role: "platform_admin", merchantId: null}, order.id, [], null);
    const agent = workspaceOrderDetail(runtime.repository, {id: "owner", role: "agent_owner", merchantId: tenant.merchantId}, order.id, [], null);
    expect((admin.fulfillments as Array<Record<string, unknown>>)[0]).toMatchObject({diagnostic: {code: diagnosticCode, phase: "submit"}});
    expect(JSON.stringify(agent)).not.toContain("diagnostic");
    expect(JSON.stringify(admin)).not.toContain("private-password");
    expect(runtime.fulfillments.canResubmit(runtime.repository.findFulfillment(tenant.merchantId, task.id)!)).toBe(true);
  });

  it("keeps late/unknown query results committed and diagnostic details platform-only", async () => {
    const order = await paidOrder(), task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "test-only-credential"});
    const submit = vi.spyOn(runtime.upstream, "submitDirect").mockImplementation(async input => {
      input.onSubmitting?.(null); throw new UpstreamRequestError("upstream_unavailable", true, "secret=hidden");
    });
    await runtime.fulfillments.processOne();
    const current = runtime.repository.findFulfillment(tenant.merchantId, task.id)!;
    runtime.repository.updateFulfillment({...current, nextCheckAt: new Date(0)});
    vi.spyOn(runtime.upstream, "query").mockRejectedValue(new UpstreamRequestError("upstream_configuration_error", false, "https://private.test?token=hidden"));
    const pending = (await runtime.fulfillments.processOne())!;
    expect(pending).toMatchObject({status: "running", diagnostic: {code: "configuration_error", phase: "query"}});
    expect(partnerFulfillmentSnapshot(pending)).toMatchObject({error_category: "confirmation", next_action: "wait", retry_allowed: false});
    expect(() => runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "duplicate"})).toThrow();
    expect(submit).toHaveBeenCalledTimes(1);
    const unknown = runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "private-id", lookupToken: null, status: "future_unsupported_status", stage: "future", accountEmail: null, quotedAmountMinor: null, currency: null, message: "success maybe"})!;
    expect(partnerFulfillmentSnapshot(unknown)).toMatchObject({status: "running", error_category: "confirmation", next_action: "wait", retry_allowed: false});
    expect(unknown.message).not.toContain("success");
    expect(unknown.diagnostic?.code).toBe("result_unknown");
  });

  it("distinguishes resource shortage from service issues before dispatch while withholding retries", async () => {
    const order = await paidOrder(); runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "test"});
    vi.spyOn(runtime.upstream, "submitDirect").mockRejectedValue(new UpstreamRequestError("upstream_balance_insufficient", false));
    const queued = (await runtime.fulfillments.processOne())!;
    expect(partnerFulfillmentSnapshot(queued)).toMatchObject({status: "queued", error_category: "resource", retry_allowed: false, next_action: "wait"});
    expect(queued.message).toContain("资源");
    expect(queued.diagnostic).toMatchObject({code: "balance_insufficient", phase: "submit"});
  });

  it("does not declare CDK issuance failed on an unclassified rejection; retries reuse its request identity", async () => {
    const order = await paidOrder(false);
    const issue = vi.spyOn(runtime.upstream, "issueCdk").mockRejectedValue(new UpstreamRequestError("future_unknown_error_secret", false, "password=not-persisted"));
    await runtime.cdk.issueOne();
    const pending = runtime.repository.findCdkVoucherByOrder(order.id)!;
    expect(pending).toMatchObject({status: "issuing", diagnostic: {code: "unexpected_error", phase: "issue"}});
    runtime.repository.updateCdkVoucher({...pending, nextAttemptAt: new Date(0)});
    await runtime.cdk.issueOne();
    expect(issue.mock.calls[0]![0]).toEqual(issue.mock.calls[1]![0]);
    expect(runtime.repository.listOutbox(tenant.merchantId).some(value => value.eventType === "cdk.failed")).toBe(false);
    expect(JSON.stringify(pending)).not.toMatch(/future_unknown_error_secret|not-persisted/);
  });

  it("exposes a safe CDK failure category but keeps the diagnosis platform-only", async () => {
    const order = await paidOrder(false);
    vi.spyOn(runtime.upstream, "issueCdk").mockRejectedValue(new UpstreamRequestError("upstream_balance_insufficient", false));
    await runtime.cdk.issueOne();
    const event = runtime.repository.listOutbox(tenant.merchantId).find(value => value.eventType === "cdk.failed")!;
    expect(event.payload).toMatchObject({failure_code: "service_unavailable", error_category: "resource"});
    expect(JSON.stringify(event.payload)).not.toMatch(/balance_insufficient|diagnostic|upstream/);
    const admin = workspaceOrderDetail(runtime.repository, {id: "admin", role: "platform_admin", merchantId: null}, order.id, [], null);
    const agent = workspaceOrderDetail(runtime.repository, {id: "owner", role: "agent_owner", merchantId: tenant.merchantId}, order.id, [], null);
    expect(admin).toMatchObject({cdkDiagnostic: {code: "balance_insufficient", phase: "issue"}});
    expect(agent).not.toHaveProperty("cdkDiagnostic");
  });

  it("maps an unknown provider business error to uncertain/retryable, not definite rejection", async () => {
    vi.stubGlobal("fetch", async () => Response.json({code: 400, error_code: "NEW_PROVIDER_CODE", msg: "password=hidden"}, {status: 400}));
    const provider = new ZovoCardRechargeProvider("https://upstream.invalid/api", "https://upstream.invalid/cdk", "isolated-test-key", null);
    await expect(provider.issueCdk({plan: "plus", idempotencyKey: "isolated-idempotency-key"})).rejects.toMatchObject({failureCode: "upstream_result_unknown", retryable: true});
  });

  it("retains safe business reasons but rejects credential dumps, account identifiers and opaque secrets", () => {
    expect(safeBusinessMessage("该账号需要先完成人机核验", "fallback")).toBe("该账号需要先完成人机核验");
    for (const unsafe of ["password=hunter42", "cookie=private", "buyer@example.com", "session expired: private-value", "opaque " + "x".repeat(50), "密码：私密测试值", "https://private.invalid/error", "上游服务暂时不可用"]) {
      expect(safeBusinessMessage(unsafe, "fallback")).toBe("fallback");
    }
  });

  it("keeps controlled diagnostic history across SQLite restart without storing raw provider errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quefa-feedback-"));
    const sqliteConfig = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: join(directory, "isolated.sqlite"), LOG_LEVEL: "silent"});
    let persistent: Runtime | null = createRuntime(sqliteConfig);
    try {
      publishTestRechargeProduct(persistent);
      const bundle = persistent.repository.findCredential(sqliteConfig.demoPartnerId, sqliteConfig.demoKeyId)!;
      const scoped = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
      const created = await persistent.orders.create(scoped, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
      const paid = persistent.payment.markPaid(scoped.merchantId, created.id, {providerRef: "isolated:" + created.id, receivedMinor: created.saleAmountMinor});
      const order = historicalDirectOrder(persistent, paid);
      const task = persistent.fulfillments.createDirectPublic(order, {mode: "session", session: "synthetic-test-credential"});
      vi.spyOn(persistent.upstream, "submitDirect").mockRejectedValue(new UpstreamRequestError("session_invalid", false, "password=do-not-persist"));
      await persistent.fulfillments.processOne();
      persistent.close(); persistent = createRuntime(sqliteConfig);
      const restored = persistent.repository.findFulfillment(scoped.merchantId, task.id)!;
      expect(restored.diagnostic).toMatchObject({code: "credential_invalid", phase: "submit"});
      expect(typeof restored.diagnostic?.observedAt).toBe("string");
      expect(JSON.stringify(restored)).not.toContain("do-not-persist");
      expect(partnerFulfillmentSnapshot(restored)).toMatchObject({error_category: "credential", status: "failed", next_action: "resubmit"});
    } finally {persistent?.close(); rmSync(directory, {recursive: true, force: true});}
  });
});
