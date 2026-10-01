import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";
import {historicalDirectOrder, publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("partner-hosted white label redemption", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  let r: ReturnType<typeof createRuntime>, app: Awaited<ReturnType<typeof buildApp>>;
  const admin = {id: "admin", role: "platform_admin" as const, merchantId: null};
  beforeEach(async () => {
    r = createRuntime(config); publishTestRechargeProduct(r); fundAndApproveApi(r); fundAndApproveApi(r, "pt_demo_b");
    const merchant = r.repository.findMerchantByPartner(config.demoPartnerId)!;
    const profile = r.agents.profile(merchant.id);
    r.agents.saveProfile(admin, merchant.id, {...profile, customRedemptionEnabled: false});
    app = await buildApp(config, r);
  });
  afterEach(async () => {await app.close(); r.close();});
  function enable(partnerId = "pt_demo_a") {
    const merchant = r.repository.findMerchantByPartner(partnerId)!;
    r.agents.saveProfile(admin, merchant.id, {tier: "standard", collectionModes: ["platform_collect"], version: r.agents.profile(merchant.id).version, customRedemptionEnabled: true});
  }
  async function request(method: "POST" | "GET", path: string, payload?: unknown, key = "redeem-test-001", b = false) {
    const body = payload === undefined ? "" : JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const keyId = b ? "key_demo_b_01" : config.demoKeyId;
    const headers = {"x-partner-id": b ? "pt_demo_b" : config.demoPartnerId, "x-key-id": keyId, "x-timestamp": timestamp, "x-nonce": nonce, "idempotency-key": key,
      "x-signature": signRequest({method, path, rawQuery: "", timestamp, nonce, keyId, idempotencyKey: key, rawBody: Buffer.from(body)}, b ? "demo-secret-b-must-be-at-least-32-characters" : config.demoClientSecret),
      ...(payload === undefined ? {} : {"content-type": "application/json"})};
    return app.inject({method, url: path, headers, ...(payload === undefined ? {} : {payload: body})});
  }
  async function order(mode: "direct" | "cdk", paid = true) {
    const bundle = r.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const o = await r.orders.create({merchantId: bundle.merchant.id, partnerId: config.demoPartnerId, keyId: config.demoKeyId, appId: bundle.app.id},
      {merchantOrderNo: randomUUID(), productCode: mode === "direct" ? "chatgpt_plus_cdk_1m" : "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    const current = paid ? r.payment.markPaid(o.merchantId, o.id, {providerRef: "test:" + o.id, receivedMinor: o.saleAmountMinor}) : o;
    return mode === "direct" ? historicalDirectOrder(r, current) : current;
  }
  const credential = {mode: "session", session: "mock-credential-no-real-account"};
  it("requires explicit enablement and a paid owned direct order", async () => {
    const o = await order("direct", false), body = {mode: "direct", order_id: o.id, credential, customer_confirmed_email: true};
    expect((await request("POST", "/v1/redemptions", body)).statusCode).toBe(403);
    enable(); expect((await request("POST", "/v1/redemptions", body)).json().error.code).toBe("order_not_paid");
    enable("pt_demo_b"); expect((await request("POST", "/v1/redemptions", body, "cross-tenant", true)).statusCode).toBe(404);
  });
  it("replays one CDK task, rejects changed payload/foreign code, and exposes no supplier data", async () => {
    enable(); enable("pt_demo_b"); const o = await order("cdk"), voucher = (await r.cdk.issueOne())!;
    const body = {mode: "cdk", code: voucher.publicCode, credential, customer_confirmed_email: true};
    expect((await request("POST", "/v1/redemptions", body, "foreign-test", true)).statusCode).toBe(404);
    const first = await request("POST", "/v1/redemptions", body);
    expect(first.statusCode).toBe(202); expect(first.json().data.status).toBe("queued");
    const duplicate = await request("POST", "/v1/redemptions", body);
    expect(duplicate.json()).toEqual(first.json()); expect(duplicate.headers["idempotent-replayed"]).toBe("true");
    expect((await request("POST", "/v1/redemptions", {...body, credential: {...credential, session: "changed"}})).statusCode).toBe(409);
    expect((await request("POST", "/v1/redemptions", body, "different-key")).statusCode).toBe(409);
    await r.fulfillments.processOne();
    const status = await request("GET", "/v1/redemptions/" + first.json().data.redemption_id);
    expect(status.json().data).toMatchObject({status: "succeeded", progress_stage: "completed", attempt_no: 1, retry_allowed: false});
    expect(status.json().data.progress_version).toBeGreaterThan(1);
    expect(Number.isNaN(Date.parse(status.json().data.progress_updated_at))).toBe(false);
    expect(status.body).not.toMatch(/zovocard|spacexcard|upstream|lookup|session|api_key|mock-credential/i);
    expect(r.repository.findCdkVoucherByOrder(o.id)!.upstreamCodePayload.ciphertext).toBeNull();
    expect((await request("GET", "/v1/redemptions/" + first.json().data.redemption_id, undefined, "read-foreign", true)).statusCode).toBe(404);
  });
  it("keeps the task queryable after permission revocation and never returns raw supplier errors", async () => {
    enable(); const o = await order("direct");
    const result = await request("POST", "/v1/redemptions", {mode: "direct", order_id: o.id, credential, customer_confirmed_email: true});
    const id = result.json().data.redemption_id;
    r.fulfillments.applyUpstreamEvent(id, {orderId: "raw-supplier-order", lookupToken: "secret", status: "declined", stage: null, accountEmail: null, quotedAmountMinor: null, currency: null, message: "zovocard raw supplier secret"});
    r.agents.saveProfile(admin, o.merchantId, {tier: "standard", collectionModes: ["platform_collect"], version: r.agents.profile(o.merchantId).version, customRedemptionEnabled: false});
    const status = await request("GET", "/v1/redemptions/" + id);
    expect(status.statusCode).toBe(200); expect(status.json().data.status).toBe("failed");
    expect(status.body).not.toMatch(/zovocard|raw-supplier|secret/);
  });

  it("resubmits confirmed failures without paying again and stops old attempts from reopening the form", async () => {
    enable(); const o = await order("cdk"), voucher = (await r.cdk.issueOne())!;
    const body = {mode: "cdk", code: voucher.publicCode, credential, customer_confirmed_email: true};
    const first = await request("POST", "/v1/redemptions", body, "first-attempt");
    const id = first.json().data.redemption_id;
    r.fulfillments.applyUpstreamEvent(id, {orderId: "supplier-order", lookupToken: null, status: "failed_precharge", stage: "failed",
      accountEmail: null, quotedAmountMinor: null, currency: null, message: "凭据校验失败"});
    expect((await request("GET", "/v1/redemptions/" + id)).json().data).toMatchObject({status: "failed", retry_allowed: true, next_action: "resubmit"});
    expect((await request("POST", "/v1/redemptions", body, "first-attempt")).json()).toEqual(first.json());
    const ledgerCount = r.repository.listLedger(o.merchantId).length;
    const retry = await request("POST", "/v1/redemptions", {...body, credential: {...credential, session: "corrected"}}, "second-attempt");
    expect(retry.statusCode).toBe(202);
    expect(retry.json().data).toMatchObject({order_id: o.id, attempt_no: 2, status: "queued"});
    expect(r.repository.listLedger(o.merchantId)).toHaveLength(ledgerCount);
    expect((await request("GET", "/v1/redemptions/" + id)).json().data.retry_allowed).toBe(false);
    const list = await request("GET", "/v1/orders/" + o.id + "/fulfillments");
    expect(list.json().data.map((value: {attempt_no: number; retry_allowed: boolean}) => [value.attempt_no, value.retry_allowed])).toEqual([[1, false], [2, false]]);
  });
});
