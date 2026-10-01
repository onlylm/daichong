import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {FastifyInstance} from "fastify";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import type {AppConfig} from "../src/config.js";

describe("platform recharge supplier administration", () => {
  let app: FastifyInstance;
  let runtime: Runtime;
  let config: AppConfig;

  beforeEach(async () => {
    config = adminConfig();
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    runtime.close();
  });

  it("protects the platform API, encrypts secrets and never returns their values", async () => {
    expect((await app.inject({method: "GET", url: "/internal/admin/api/supply/connection"})).statusCode).toBe(401);
    const saved = await app.inject({
      method: "PUT", url: "/internal/admin/api/supply/connection", headers: adminHeaders(config),
      payload: {
        name: "Quefa主充值供应", environment: "sandbox",
        open_api_base: "https://sandbox.zovocard.com/openapi/v1", cdk_base: "https://sandbox.zovocard.com/api/v1/cdk",
        enabled: true, api_key: "sk_supplier_secret_value", webhook_secret: "whsec_supplier_secret_value", direct_payment_resource_id: 123,
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({api_key_configured: true, webhook_secret_configured: true, direct_payment_resource_configured: true});
    expect(saved.body).not.toContain("sk_supplier_secret_value");
    expect(saved.body).not.toContain("whsec_supplier_secret_value");
    expect(saved.body).not.toContain('"direct_payment_resource_id":123');

    const stored = runtime.repository.findSupplierConnection("supplier_primary")!;
    expect(stored.secretPayload.ciphertext).not.toContain("sk_supplier_secret_value");
    expect(stored.secretPayload.ciphertext).not.toContain("whsec_supplier_secret_value");

    const blocked = await app.inject({
      method: "PUT", url: "/internal/admin/api/supply/connection", headers: adminHeaders(config),
      payload: {
        name: "bad", environment: "production", open_api_base: "https://127.0.0.1/openapi/v1",
        cdk_base: "https://sandbox.zovocard.com/api/v1/cdk", enabled: false,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe("supplier_host_not_allowed");
  });

  it("rejects path injection, mixed environments and stale configuration saves", async () => {
    await configureSupplier(app, config);
    const original = runtime.supplierManagement.getConnection();
    const base = {name: "测试", environment: "sandbox" as const, openApiBase: original.open_api_base, cdkBase: original.cdk_base, enabled: true};
    for (const openApiBase of [
      "https://sandbox.zovocard.com/openapi/v1?target=/cards/open",
      "https://sandbox.zovocard.com/openapi/v1#fragment",
      "https://sandbox.zovocard.com/openapi/v1/cards",
      "https://sandbox.zovocard.com:8443/openapi/v1",
      "https://user:pass@sandbox.zovocard.com/openapi/v1",
    ]) expect(() => runtime.supplierManagement.saveConnection({...base, openApiBase})).toThrow();
    expect(() => runtime.supplierManagement.saveConnection({...base, cdkBase: "https://zovocard.com/api/v1/cdk"})).toThrow();
    runtime.supplierManagement.saveConnection({...base, name: "较新配置", expectedVersion: original.config_version});
    expect(() => runtime.supplierManagement.saveConnection({...base, expectedVersion: original.config_version})).toThrow("供应配置已被更新");
    expect(runtime.supplierManagement.getConnection().name).toBe("较新配置");
  });

  it("does not let an older network test overwrite a newer saved secret", async () => {
    await configureSupplier(app, config);
    let resolveBalance!: (response: Response) => void;
    vi.stubGlobal("fetch", (input: string | URL | Request) => String(input).endsWith("/balance")
      ? new Promise<Response>((resolve) => { resolveBalance = resolve; })
      : Promise.resolve(Response.json({code: 0, data: {version: 1, registry: [], plans: {}}})));
    const pending = runtime.supplierManagement.testConnection();
    runtime.supplierManagement.saveConnection({
      name: "更新后配置", environment: "sandbox", openApiBase: config.zovocardApiBase, cdkBase: config.zovocardCdkBase,
      enabled: true, apiKey: "a-new-secret-key-that-must-not-be-lost",
    });
    resolveBalance(Response.json({code: 0, data: {balance: 10}}));
    await expect(pending).rejects.toMatchObject({code: "supplier_config_changed"});
    expect(runtime.supplierManagement.getConnection()).toMatchObject({name: "更新后配置", last_test_status: "never", config_version: 3});
    let sentKey = "";
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      sentKey = new Headers(init.headers).get("x-api-key") ?? "";
      return Response.json({code: 0, data: {balance: 10}});
    });
    await runtime.supplierManagement.getBalance();
    expect(sentKey).toBe("a-new-secret-key-that-must-not-be-lost");
  });

  it("stops selling mapped plans that disappeared or were disabled in a sync", async () => {
    await configureSupplier(app, config);
    vi.stubGlobal("fetch", supplierFetch());
    await runtime.supplierManagement.syncPlans();
    const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
    expect(runtime.catalog.list(merchant.id)).toHaveLength(1);
    vi.stubGlobal("fetch", async () => Response.json({code: 0, data: {version: 8, registry: [], plans: {}}}));
    await runtime.supplierManagement.syncPlans();
    expect(runtime.catalog.list(merchant.id)).toHaveLength(0);
    expect(() => runtime.catalog.requireGrant(merchant.id, "chatgpt_plus_cdk_1m")).toThrow("商品暂不可售");
    expect(() => runtime.supplierManagement.saveMapping({productCode: "chatgpt_plus_cdk_1m", fulfillmentMode: "direct", supplierProduct: "gpt", supplierPlan: "plus", enabled: true})).toThrow("履约方式不能更改");
  });

  it("requires a non-placeholder admin token and serves a syntactically valid management page", async () => {
    const page = await app.inject({method: "GET", url: "/internal/admin/supply"});
    expect(page.statusCode).toBe(200);
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    config.platformAdminToken = "replace-platform-admin-token-at-least-32-chars";
    const blocked = await app.inject({method: "GET", url: "/internal/admin/api/supply/connection", headers: adminHeaders(config)});
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers["cache-control"]).toBe("no-store");
  });

  it("defaults every production GPT mapping and every new-agent product grant to disabled", () => {
    const live = createRuntime({...config, nodeEnv: "production", fulfillmentProvider: "zovocard", zovocardApiKey: "production-key-only-for-test"});
    try {
      const mappings = live.supplierManagement.listMappings();
      expect(mappings).toHaveLength(4);
      expect(mappings.every(item => item.supplierProduct === "gpt" && !item.enabled)).toBe(true);

      const merchant = live.agents.create({id: "admin", merchantId: null, role: "platform_admin"}, {partnerId: "gpt_agent", name: "GPT 代理"}).merchant;
      const grants = live.repository.listProductGrants(merchant.id);
      expect(grants).toHaveLength(4);
      expect(grants.every(item => item.upstreamProduct === "gpt" && item.available)).toBe(true);
    } finally {
      live.close();
    }
  });

  it("blocks switching an active supplier account while an order is outstanding", async () => {
    await configureSupplier(app, config);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    await runtime.orders.create(tenant, {merchantOrderNo: "supplier-switch-pending", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    expect(() => runtime.supplierManagement.saveConnection({
      name: "切换供应", environment: "production", openApiBase: "https://zovocard.com/openapi/v1", cdkBase: "https://zovocard.com/api/v1/cdk",
      enabled: true, apiKey: "another-supplier-test-only-key",
    })).toThrow("存在未完成订单");
  });

  it("syncs only recharge products and sanitizes all reconciliation responses", async () => {
    await configureSupplier(app, config);
    vi.stubGlobal("fetch", supplierFetch());

    const tested = await app.inject({method: "POST", url: "/internal/admin/api/supply/test", headers: adminHeaders(config), payload: {}});
    expect(tested.statusCode).toBe(200);
    expect(tested.json().data.balance.spendable_balance).toBe(108.5);

    const synced = await app.inject({method: "POST", url: "/internal/admin/api/supply/plans/sync", headers: adminHeaders(config), payload: {}});
    expect(synced.statusCode).toBe(200);
    expect(new Set(synced.json().data.map((item: {product: string}) => item.product))).toEqual(new Set(["gpt"]));

    const mappings = (await app.inject({method: "GET", url: "/internal/admin/api/supply/mappings", headers: adminHeaders(config)})).json().data;
    expect(mappings).toHaveLength(4);
    expect(mappings.every((item: {supplier_product: string}) => item.supplier_product === "gpt")).toBe(true);

    const invalidCdk = await app.inject({
      method: "PUT", url: "/internal/admin/api/supply/mappings/claude_pro_cdk", headers: adminHeaders(config),
      payload: {fulfillment_mode: "cdk", supplier_product: "claude", supplier_plan: "pro", enabled: true},
    });
    expect(invalidCdk.statusCode).toBe(400);

    for (const path of ["direct-orders", "cdks", "cdk-orders"]) {
      const response = await app.inject({method: "GET", url: `/internal/admin/api/supply/reconciliation/${path}`, headers: adminHeaders(config)});
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("4111111111111111");
      expect(response.body).not.toContain("ZC-AAAA-BBBB-CCCC-DDDD");
      expect(response.body).not.toContain("card_number");
      expect(response.body).not.toContain("card_id");
      expect(response.body).not.toContain("private.buyer@example.com");
    }

    for (const path of ["/cards", "/cards/open", "/cards/123", "/cards/123/recharge", "/cards/123/refund", "/cards/123/freeze", "/cards/123/unfreeze", "/cards/123/delete"]) {
      for (const method of ["GET", "POST"] as const) {
        expect((await app.inject({method, url: `/internal/admin/api/supply${path}`, headers: adminHeaders(config)})).statusCode).toBe(404);
      }
    }
  });
});

async function configureSupplier(app: FastifyInstance, config: AppConfig): Promise<void> {
  const response = await app.inject({
    method: "PUT", url: "/internal/admin/api/supply/connection", headers: adminHeaders(config),
    payload: {
      name: "Quefa主充值供应", environment: "sandbox",
      open_api_base: "https://sandbox.zovocard.com/openapi/v1", cdk_base: "https://sandbox.zovocard.com/api/v1/cdk",
      enabled: true, api_key: "sk_supplier_secret_value", webhook_secret: "whsec_supplier_secret_value", direct_payment_resource_id: 123,
    },
  });
  expect(response.statusCode).toBe(200);
}

function supplierFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/balance")) {
      return Response.json({code: 0, data: {balance: 128.5, spendable_balance: 108.5, account_reserve_amount: 20, minimum_deposit_amount: 50, currency: "USD"}});
    }
    if (url.pathname.endsWith("/gpt-direct/plans")) {
      const keys = ["plus", "codex_points_250", "codex_points_500", "codex_points_1000", "codex_points_2500", "codex_points_5000", "codex_points_25000"];
      return Response.json({code: 0, data: {
        version: 7,
        registry: keys.map(key => ({product: "gpt", key, acc_plan_key: key, name: key.replaceAll("_", " "), purchasable: true, service_fee_usd_minor: 15})),
        plans: Object.fromEntries(keys.map(key => [key, {enabled: true}])),
      }});
    }
    if (url.pathname.endsWith("/gpt-direct/orders")) {
      return Response.json({code: 0, data: {total: 1, list: [{id: 11, client_request_id: "ful_1", product: "gpt", plan: "plus", status: "completed", account_email: "private.buyer@example.com", card_id: 9, card_number: "4111111111111111"}]}});
    }
    if (url.pathname.endsWith("/gpt-direct/cdks")) {
      return Response.json({code: 0, data: {total: 1, list: [{id: 12, plan: "plus", status: "unused", code: "ZC-AAAA-BBBB-CCCC-DDDD", code_prefix: "ZC-AAAA", card_id: 9}]}});
    }
    if (url.pathname.endsWith("/gpt-direct/cdk-orders")) {
      return Response.json({code: 0, data: {total: 1, list: [{id: 13, plan: "plus", status: "completed", account_email: "private.buyer@example.com", card_id: 9, card_number: "4111111111111111", code_prefix: "ZC-AAAA"}]}});
    }
    return Response.json({code: 404, error_code: "not_found"}, {status: 404});
  }) as typeof fetch;
}

function adminHeaders(config: AppConfig): Record<string, string> {
  return {"x-platform-admin-token": config.platformAdminToken, "content-type": "application/json"};
}

function adminConfig(): AppConfig {
  return {
    nodeEnv: "test", executionMode: "disabled", host: "127.0.0.1", port: 3200, logLevel: "silent", trustProxy: false,
    enableSandboxRoutes: true, registrationEnabled: false, sandboxAdminToken: "local-sandbox-token-for-tests", platformAdminToken: "test-platform-admin-token-at-least-32-chars",
    demoPartnerId: "pt_admin", demoKeyId: "key_admin_01", demoClientSecret: "admin-secret-must-be-at-least-32-characters",
    dataEncryptionKey: Buffer.alloc(32, 4), keyEncryptionKeyId: "test-key-v1", publicBaseUrl: "http://127.0.0.1:3200",
    portalTokenSecret: "test-public-portal-secret-at-least-32-chars", fulfillmentProvider: "mock",
    zovocardApiBase: "https://sandbox.zovocard.com/openapi/v1", zovocardCdkBase: "https://sandbox.zovocard.com/api/v1/cdk",
    zovocardApiKey: null, zovocardCardId: null, zovocardWebhookSecret: null,
    supplierAllowedHosts: ["sandbox.zovocard.com", "zovocard.com"],
    storageDriver: "memory", sqlitePath: ":memory:", demoWebhookUrl: null, demoWebhookSecret: "test-webhook-secret-123456",
  };
}
