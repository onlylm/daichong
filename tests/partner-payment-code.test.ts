import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";

describe("signed partner payment-code API", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PUBLIC_BASE_URL: "https://tibo.ink"});
  const admin = {id: "admin", role: "platform_admin" as const, merchantId: null};
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
  });
  afterEach(async () => {await app.close(); runtime.close();});

  async function signed(method: "GET" | "POST", path: string, payload?: unknown, key: string = randomUUID(), partnerB = false) {
    const body = payload === undefined ? "" : JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const partnerId = partnerB ? "pt_demo_b" : config.demoPartnerId;
    const keyId = partnerB ? "key_demo_b_01" : config.demoKeyId;
    const secret = partnerB ? "demo-secret-b-must-be-at-least-32-characters" : config.demoClientSecret;
    return app.inject({method, url: path, headers: {"x-partner-id": partnerId, "x-key-id": keyId,
      "x-timestamp": timestamp, "x-nonce": nonce, ...(method === "POST" ? {"idempotency-key": key} : {}),
      "x-signature": signRequest({method, path, rawQuery: "", timestamp, nonce, keyId,
        idempotencyKey: method === "POST" ? key : "", rawBody: Buffer.from(body)}, secret),
      ...(payload === undefined ? {} : {"content-type": "application/json"})},
      ...(payload === undefined ? {} : {payload: body})});
  }

  async function platformOrder() {
    const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const order = await runtime.orders.create({merchantId: credential.merchant.id, partnerId: config.demoPartnerId,
      appId: credential.app.id, keyId: credential.key.keyId}, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page", providerRef: order.id, updatedAt: new Date()});
    return order;
  }

  function enable(merchantId: string) {
    const profile = runtime.agents.profile(merchantId);
    runtime.agents.saveProfile(admin, merchantId, {...profile, directPaymentCodeEnabled: true});
  }

  it("is opt-in, accepts no price override, and preserves legacy qr_payload", async () => {
    const order = await platformOrder(), path = `/v1/orders/${order.id}/payment-code`;
    expect((await signed("POST", path, {})).json().error.code).toBe("direct_payment_code_disabled");
    enable(order.merchantId);
    expect((await signed("POST", path, {amount: "0.01"}, "override")).json().error.code).toBe("invalid_request");

    const get = await signed("GET", `/v1/orders/${order.id}`);
    expect(get.json().data.qr_payload).toBe(order.qrPayload);
    expect(get.json().data).not.toHaveProperty("payment_code");
  });

  it("returns a locally rendered code without exposing platform URLs or internal configuration", async () => {
    const order = await platformOrder(); enable(order.merchantId);
    const precreate = vi.fn(async (id: string) => {
      expect(id).toBe(order.id);
      const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
      const code = "https://qr.alipay.com/test-partner-payment-code";
      runtime.repository.updatePaymentAttempt({...attempt, qrPayload: code, updatedAt: new Date()});
      return code;
    });
    (runtime as unknown as {alipay: {precreate: (id: string) => Promise<string>}}).alipay = {precreate};

    const path = `/v1/orders/${order.id}/payment-code`, first = await signed("POST", path, {}, "payment-code-one");
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({order_id: order.id, amount: "135.00", currency: "CNY",
      payment_status: "pending", payment_code_type: "alipay_precreate",
      payment_code: "https://qr.alipay.com/test-partner-payment-code"});
    expect(first.json().data.qr_image_data_url).toMatch(/^data:image\/png;base64,/);
    expect(first.body).not.toMatch(/tibo\.ink|admin\.tibo|quefa|client_secret|payment_config|supply_amount/i);

    const replay = await signed("POST", path, {}, "payment-code-one");
    expect(replay.json().data).toEqual(first.json().data);
    expect(replay.json().idempotent).toBe(true);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(precreate).toHaveBeenCalledTimes(1);
  });

  it("enforces tenant ownership and rejects codes after payment", async () => {
    const order = await platformOrder(); enable(order.merchantId);
    const merchantB = runtime.repository.findMerchantByPartner("pt_demo_b")!; enable(merchantB.id);
    const path = `/v1/orders/${order.id}/payment-code`;
    expect((await signed("POST", path, {}, "foreign", true)).statusCode).toBe(404);
    runtime.payment.markPaid(order.merchantId, order.id, {channel: "alipay_page", providerRef: "2026100100000800", receivedMinor: order.saleAmountMinor});
    expect((await signed("POST", path, {}, "already-paid")).json().error.code).toBe("payment_not_available");
  });
});
