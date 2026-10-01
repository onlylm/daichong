import {randomUUID} from "node:crypto";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";

describe("partner-owned storefront example", () => {
  const original = new Map<string, string | undefined>();
  let demoServer: Server | undefined;

  afterEach(async () => {
    if (demoServer?.listening) await new Promise<void>(resolve => demoServer!.close(() => resolve()));
    demoServer = undefined;
    for (const [key, value] of original) value === undefined ? delete process.env[key] : process.env[key] = value;
    original.clear();
  });

  it("keeps payment and CDK-backed auto recharge on the agent page without exposing platform fields", async () => {
    const registeredWebhook = "http://127.0.0.1:3300/webhooks/quefa";
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", ENABLE_SANDBOX_ROUTES: "true",
      DEMO_WEBHOOK_URL: registeredWebhook});
    const runtime = createRuntime(config), app = await buildApp(config, runtime);
    const baseUrl = await app.listen({host: "127.0.0.1", port: 0});
    setEnv("QUEFA_BASE_URL", baseUrl);
    setEnv("QUEFA_PARTNER_ID", config.demoPartnerId);
    setEnv("QUEFA_KEY_ID", config.demoKeyId);
    setEnv("QUEFA_CLIENT_SECRET", config.demoClientSecret);
    setEnv("QUEFA_WEBHOOK_SECRET", config.demoWebhookSecret);
    setEnv("QUEFA_REGISTERED_WEBHOOK_URL", registeredWebhook);
    setEnv("PARTNER_DEMO_ALLOW_MOCK_PAY", "true");
    try {
      const demo = await import(new URL(`../examples/partner-demo/server.mjs?e2e=${randomUUID()}`, import.meta.url).href);
      demoServer = demo.server as Server;
      await new Promise<void>(resolve => demoServer!.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(demoServer.address() as AddressInfo).port}`;

      const products = await responseJson(origin + "/api/products");
      expect(products.data).toHaveLength(4);
      expect(products.data[0]).not.toHaveProperty("supply_price");
      const created = await responseJson(origin + "/api/orders", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({merchant_order_no: "AGENT-DEMO-001", product_code: "chatgpt_plus_cdk_1m", sale_amount: "135.00"})}, 201);
      expect(created.data).toMatchObject({merchant_order_no: "AGENT-DEMO-001", payment_status: "pending", delivery_mode: "auto_recharge"});
      expect(JSON.stringify(created)).not.toMatch(/qr_payload|fulfillment_url|supply_amount|merchant_margin|tibo\.ink|quefa/i);

      const paid = await responseJson(`${origin}/api/orders/${created.data.order_id}/mock-pay`, {method: "POST"});
      expect(paid.data.payment_status).toBe("paid");
      expect((await runtime.cdk.issueOne())?.orderId).toBe(created.data.order_id);

      const accepted = await responseJson(`${origin}/api/orders/${created.data.order_id}/redeem`, {method: "POST",
        headers: {"content-type": "application/json"}, body: JSON.stringify({request_key: "agent-demo-recharge-001",
          credential: {mode: "session", session: "isolated-demo-session"}, customer_confirmed_email: true})}, 202);
      expect(accepted.data.status).toBe("queued");
      expect(accepted).not.toHaveProperty("redemption_id");
      await runtime.fulfillments.processOne();
      const result = await responseJson(origin + accepted.status_path);
      expect(result.data.status).toBe("succeeded");
      expect(JSON.stringify(result)).not.toMatch(/order_id|redemption_id|supply|merchant_margin|upstream|isolated-demo-session|tibo\.ink|quefa/i);
    } finally {
      await app.close();
      runtime.close();
    }
  });

  function setEnv(key: string, value: string): void {
    if (!original.has(key)) original.set(key, process.env[key]);
    process.env[key] = value;
  }
});

async function responseJson(url: string, init?: RequestInit, expectedStatus = 200): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(expectedStatus);
  return body;
}
