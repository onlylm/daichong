import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import type {Actor} from "../src/operations/model.js";

describe("default-open API and dual-mode spending", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  let r: ReturnType<typeof createRuntime>, app: Awaited<ReturnType<typeof buildApp>>, owner: Actor;
  const admin: Actor = {id: "admin", merchantId: null, role: "platform_admin"};
  beforeEach(async () => {
    r = createRuntime(config); app = await buildApp(config, r);
    owner = {id: "owner", role: "agent_owner", merchantId: r.repository.findMerchantByPartner(config.demoPartnerId)!.id};
  });
  afterEach(async () => {await app.close(); r.close();});

  async function request(method: "GET" | "POST", path: string, payload?: unknown, key = "funding-test-001",
    secret = config.demoClientSecret, keyId = config.demoKeyId) {
    const rawBody = Buffer.from(payload === undefined ? "" : JSON.stringify(payload));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    return app.inject({method, url: path, headers: {"x-partner-id": config.demoPartnerId, "x-key-id": keyId,
      "x-timestamp": timestamp, "x-nonce": nonce, "idempotency-key": key,
      "x-signature": signRequest({method, path, rawQuery: "", timestamp, nonce, keyId, idempotencyKey: key, rawBody}, secret),
      ...(payload === undefined ? {} : {"content-type": "application/json"})},
      ...(payload === undefined ? {} : {payload: rawBody})});
  }
  const orderBody = (number: string, mode: string) => ({merchant_order_no: number,
    product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: mode === "agent_collect" ? "110.00" : "135.00", collection_mode: mode});

  it("opens signed API access without an application or deposit", async () => {
    expect((await request("GET", "/v1/products")).statusCode).toBe(200);
    expect(r.apiAccess.summary(owner, owner.merchantId!)).toMatchObject({automaticAccess: true, canApply: false, apiDepositMinor: "0"});
    expect(() => r.apiAccess.apply(owner, owner.merchantId!, "旧申请", "retired-flow")).toThrow("无需申请或预存");
  });

  it("only exposes Alipay and rejects new USDT orders", async () => {
    const methods = await request("GET", "/v1/payment-methods", undefined, "payment-methods");
    expect(methods.statusCode).toBe(200);
    expect(methods.json().data.every((item: {code: string}) => item.code === "alipay")).toBe(true);
    const blocked = await request("POST", "/v1/orders", {...orderBody("usdt-disabled", "platform_collect"), payment_channel: "usdt"}, "usdt-disabled");
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.code).toBe("invalid_request");
    const managedConfig = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PAYMENT_PROVIDER: "managed"});
    const managedRuntime = createRuntime(managedConfig);
    managedConfig.executionMode = "controlled";
    const managedApp = await buildApp(managedConfig, managedRuntime);
    try {
      const now = new Date();
      managedRuntime.repository.saveOperations("payment_settings", {id: "alipay_page", merchantId: null, channel: "alipay_page",
        version: 1, draftId: null, activeId: "pc-alipay", paused: false, updatedAt: now}, true);
      managedRuntime.repository.saveOperations("payment_settings", {id: "dujiaopay", merchantId: null, channel: "dujiaopay",
        version: 1, draftId: null, activeId: "pc-usdt-legacy", paused: false, updatedAt: now}, true);
      expect(managedRuntime.paymentSettings.available()).toEqual(["alipay_page"]);
      expect((await managedApp.inject({url: "/usdt-payments/nonexistent"})).statusCode).toBe(404);
      expect((await managedApp.inject({method: "POST", url: "/internal/webhooks/dujiaopay/pc-usdt-legacy"})).statusCode).toBe(404);
    } finally { await managedApp.close(); managedRuntime.close(); }
  });

  it("forces platform collection at zero balance, then deducts the exact supply price after a verified deposit", async () => {
    const blocked = await request("POST", "/v1/orders", orderBody("zero-agent", "agent_collect"), "zero-agent");
    expect(blocked.statusCode).toBe(403); expect(blocked.json().error.code).toBe("collection_mode_denied");
    const platform = await request("POST", "/v1/orders", orderBody("zero-platform", "platform_collect"), "zero-platform");
    expect(platform.statusCode).toBe(201); expect(platform.json().data.payment_scope).toBe("retail");
    const deposit = r.wallets.requestDeposit(owner, owner.merchantId!, "110.00", "verified-deposit", "payer");
    const credited = r.wallets.reviewDeposit(admin, deposit.id, true, "receipt:verified-deposit");
    expect(credited.paidAt).toBeInstanceOf(Date);
    const profile = r.agents.profile(owner.merchantId!);
    r.agents.saveProfile(admin, owner.merchantId!, {...profile, collectionModes: ["platform_collect", "agent_collect"]});
    const purchase = await request("POST", "/v1/orders", orderBody("wallet-purchase", "agent_collect"), "wallet-purchase");
    expect(purchase.statusCode).toBe(201); expect(purchase.json().data.payment_scope).toBe("procurement");
    expect(r.wallets.summary(owner, owner.merchantId!).procurementAvailable).toBe("0.00");
    const second = await request("POST", "/v1/orders", orderBody("wallet-empty", "agent_collect"), "wallet-empty");
    expect(second.statusCode).toBe(403); expect(second.json().error.code).toBe("collection_mode_denied");
  });

  it("shows a newly issued secret once, isolates ownership, and revokes an application immediately", async () => {
    const issued = r.apiAccess.issueKey(owner, owner.merchantId!, "new-key-001", "商城");
    expect((await request("GET", "/v1/products", undefined, "read-test", issued.client_secret, issued.key_id)).statusCode).toBe(200);
    expect(() => r.apiAccess.issueKey(owner, owner.merchantId!, "new-key-001", "商城")).toThrow("不重复显示");
    expect(JSON.stringify(r.apiAccess.summary(owner, owner.merchantId!))).not.toContain(issued.client_secret);
    const foreign = {...owner, merchantId: r.repository.findMerchantByPartner("pt_demo_b")!.id};
    expect(() => r.apiAccess.issueKey(foreign, owner.merchantId!, "new-key-002", "越权")).toThrow();
    const appId = r.apiAccess.summary(owner, owner.merchantId!).apps.find(item => item.appId === issued.app_id)!.id;
    r.apiAccess.disableApp(owner, owner.merchantId!, appId);
    expect((await request("GET", "/v1/products", undefined, "read-test", issued.client_secret, issued.key_id)).statusCode).toBe(401);
  });

  it("preserves an explicit administrative suspension until a manual grant", async () => {
    const access = r.repository.getOperations("api_access", owner.merchantId!)!;
    r.apiAccess.disable(admin, owner.merchantId!, access.version, "暂停合作");
    expect((await request("GET", "/v1/products")).statusCode).toBe(403);
    expect(() => r.apiAccess.apply(owner, owner.merchantId!, "恢复申请", "retired-restore")).toThrow("无需申请或预存");
    r.apiAccess.grant(admin, owner.merchantId!, "人工恢复");
    expect((await request("GET", "/v1/products")).statusCode).toBe(200);
  });

  it("keeps webhook secrets separate and enforces registered notify URLs", async () => {
    const issued = r.apiAccess.issueKey(owner, owner.merchantId!, "key-webhook-001", "商城");
    const webhookUrl = "https://merchant.example.com/quefa/webhook";
    const registered = r.apiAccess.registerWebhook(owner, owner.merchantId!, webhookUrl, "wh-reg-001");
    expect(registered.webhook_secret).not.toBe(issued.client_secret);
    expect(() => r.apiAccess.registerWebhook(owner, owner.merchantId!, webhookUrl, "wh-reg-001")).toThrow("已登记");
    const denied = await request("POST", "/v1/orders", {...orderBody("notify-denied", "platform_collect"),
      notify_url: "https://other.example.com/hook"}, "notify-denied", issued.client_secret, issued.key_id);
    expect(denied.json().error.code).toBe("webhook_url_not_registered");
    const order = await request("POST", "/v1/orders", {...orderBody("notify-ok", "platform_collect"), notify_url: webhookUrl},
      "notify-ok", issued.client_secret, issued.key_id);
    expect(order.statusCode).toBe(201);
  });
});
