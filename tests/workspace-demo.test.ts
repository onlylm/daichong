import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {workspaceJs} from "../src/operations/workspace-page.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("workspace and standalone redemption delivery", () => {
  it("serves the workspace, safe script and public guide without internal supplier names", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const r = createRuntime(config), app = await buildApp(config, r);
    try {
      expect(() => new Function(workspaceJs)).not.toThrow();
      const page = await app.inject({url: "/workspace"});
      expect(page.statusCode).toBe(200); expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(page.body).toContain("login-form"); expect(page.body).not.toContain("/workspace/assets/app.js");
      const appPage = await app.inject({url: "/workspace/app"});
      expect(appPage.statusCode).toBe(200); expect(appPage.body).toContain("/workspace/assets/app.js");
      expect(page.body).not.toContain("passwordHash");
      const script = await app.inject({url: "/workspace/assets/app.js"});
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain("代理商 API");
      expect(script.body).toContain("生产供应");
      expect(script.body).toContain("/api-applications/");
      expect(script.body).toContain("/supplier/overview");
      expect(script.body).toContain("function publicOrigin()");
      expect(script.body).toContain("publicUrl(\"/developers/openapi.yaml\")");
      expect(script.body).toContain("/v1/redemptions");
      const guide = await app.inject({url: "/developers/redemption.md"});
      expect(guide.statusCode).toBe(200); expect(guide.body).toContain("/v1/redemptions");
      expect(guide.body).not.toMatch(/zovocard|spacexcard/i);
      expect((await app.inject({url: "/developers/integration.md"})).statusCode).toBe(200);
      const portal = await app.inject({url: "/developers"});
      expect(portal.statusCode).toBe(200);
      expect(portal.body).toContain("四段接入航道");
      expect(portal.body).toContain("/v1/redemptions");
      expect(portal.body).not.toMatch(/zovocard|spacexcard/i);
      const portalScript = await app.inject({url: "/developers/assets/portal.js"});
      expect(() => new Function(portalScript.body)).not.toThrow();
      expect(portalScript.body).toContain("syncSectionNavigation");
      expect(portalScript.body).toContain("aria-current");
      const portalStyles = await app.inject({url: "/developers/assets/portal.css"});
      expect(portalStyles.body).toContain("overflow-x:clip");
      expect(portalStyles.body).toContain("position:sticky;top:68px;align-self:start");
      expect(portalStyles.body).toContain("aside>a.is-active");
      const specification = await app.inject({url: "/developers/openapi.yaml"});
      expect(specification.statusCode).toBe(200); expect(specification.body).toContain("/v1/orders:");
    } finally {await app.close(); r.close();}
  });
  it("exposes supplier administration through the authenticated workspace without returning secrets", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PUBLIC_BASE_URL: "https://quefa.test"});
    const r = createRuntime(config), app = await buildApp(config, r);
    try {
      await r.accounts.bootstrap("admin", "workspace-admin-password");
      const login = await loginPlatform(app, "admin", "workspace-admin-password", "https://quefa.test");
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const headers = {cookie, origin: "https://quefa.test", "x-csrf-token": login.json().csrf};
      expect((await app.inject({url: "/workspace/api/supplier/overview"})).statusCode).toBe(401);
      const overview = await app.inject({url: "/workspace/api/supplier/overview", headers: {cookie}});
      expect(overview.statusCode).toBe(200);
      expect(overview.body).not.toContain("secretPayload");
      expect(overview.body).not.toContain("apiKey\"");
      const connection = overview.json().data.connection;
      const saved = await app.inject({method: "PUT", url: "/workspace/api/supplier/connection", headers, payload: {
        name: "测试充值供应连接", environment: connection.environment, open_api_base: connection.open_api_base,
        cdk_base: connection.cdk_base, enabled: false, config_version: connection.config_version,
      }});
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain("secretPayload");
    } finally {await app.close(); r.close();}
  });
  it("runs a full signed local demo -> Quefa -> mock worker flow without exposing secrets to the consumer", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const r = createRuntime(config), app = await buildApp(config, r);
    fundAndApproveApi(r);
    const bundle = r.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const admin = {id: "admin", role: "platform_admin" as const, merchantId: null};
    r.agents.saveProfile(admin, bundle.merchant.id, {tier: "standard", collectionModes: ["platform_collect"], version: 0, customRedemptionEnabled: true});
    const o = await r.orders.create({merchantId: bundle.merchant.id, partnerId: config.demoPartnerId, appId: bundle.app.id, keyId: config.demoKeyId},
      {merchantOrderNo: "demo-http-001", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    r.payment.markPaid(o.merchantId, o.id, {providerRef: "mock-demo", receivedMinor: o.saleAmountMinor});
    const voucher = (await r.cdk.issueOne())!;
    const baseUrl = await app.listen({host: "127.0.0.1", port: 0});
    const demoModule = await import(new URL("../examples/redemption-demo/server.mjs", import.meta.url).href);
    const server: Server = demoModule.createDemoServer({baseUrl, partnerId: config.demoPartnerId, keyId: config.demoKeyId, secret: config.demoClientSecret});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    try {
      const html = await (await fetch(origin)).text();
      expect(html).not.toContain(config.demoClientSecret);
      const token = html.match(/name="demo-token" content="([a-f0-9]+)"/)![1]!;
      const body = JSON.stringify({request_key: "demo-submit-001", mode: "cdk", code: voucher.publicCode, credential: {mode: "session", session: "mock-only"}, customer_confirmed_email: true});
      const send = (requestOrigin: string) => fetch(origin + "/api/redeem", {method: "POST", headers: {origin: requestOrigin, "content-type": "application/json", "x-demo-token": token}, body});
      expect((await send("https://evil.test")).status).toBe(403);
      const first = await send(origin); expect(first.status).toBe(202);
      const accepted = await first.json() as {data: {status: string}; status_path: string};
      expect(accepted.data.status).toBe("queued");
      const repeat = await (await send(origin)).json(); expect(repeat).toEqual(accepted);
      await r.fulfillments.processOne();
      const result = await (await fetch(origin + accepted.status_path)).text();
      expect(result).toContain("succeeded"); expect(result).not.toMatch(/order_id|redemption_id|supply|upstream|mock-only|zovocard|spacexcard/);
      expect((await fetch(origin + "/api/status/" + "x".repeat(32))).status).toBe(404);
      const browserJs = readFileSync(new URL("../examples/redemption-demo/client.js", import.meta.url), "utf8");
      expect(() => new Function(browserJs)).not.toThrow(); expect(browserJs).not.toContain("client_secret");
    } finally {await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); r.close();}
  });
});
