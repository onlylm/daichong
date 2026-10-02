import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import YAML from "yaml";
import {buildApp} from "../src/app.js";
import {signRequest} from "../src/auth/signature.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {createPublicCdkCode, isPublicCdkCode} from "../src/modules/cdk-code.js";
import {UpstreamRequestError} from "../src/upstream/recharge-provider.js";

// This is the current public contract, not a list of planned notifications.
// Terminal fulfillment events are emitted dynamically by FulfillmentService.
const CURRENT_EVENTS = [
  "order.paid", "order.expired", "order.closed", "cdk.issued", "cdk.failed", "cdk.disabled",
  "fulfillment.updated", "fulfillment.succeeded", "fulfillment.failed", "fulfillment.cancelled",
  "refund.succeeded", "procurement.refunded", "wallet.deposit.credited", "webhook.test",
];

describe("current partner documentation contract", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {runtime = createRuntime(config); app = await buildApp(config, runtime);});
  afterEach(async () => {vi.restoreAllMocks(); await app.close(); runtime.close();});

  async function signed(method: "GET" | "POST", url: string, payload?: unknown) {
    const separator = url.indexOf("?"), path = separator < 0 ? url : url.slice(0, separator);
    const rawQuery = separator < 0 ? "" : url.slice(separator + 1), body = payload === undefined ? "" : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const idempotencyKey = method === "POST" ? `docs-${randomUUID()}` : "";
    return app.inject({method, url, headers: {
      "x-partner-id": config.demoPartnerId, "x-key-id": config.demoKeyId, "x-timestamp": timestamp, "x-nonce": nonce,
      ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
      ...(payload === undefined ? {} : {"content-type": "application/json"}),
      "x-signature": signRequest({method, path, rawQuery, timestamp, nonce, keyId: config.demoKeyId,
        idempotencyKey, rawBody: Buffer.from(body)}, config.demoClientSecret),
    }, ...(payload === undefined ? {} : {payload: body})});
  }

  async function createOrder() {
    const response = await signed("POST", "/v1/orders", {merchant_order_no: `DOC-${randomUUID()}`,
      product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: "135.00", delivery_mode: "cdk"});
    expect(response.statusCode).toBe(201);
    return runtime.repository.findOrderInternal(response.json().data.order_id)!;
  }

  it("serves only implemented notification names and includes real CDK failure/disable events", async () => {
    const markdown = await app.inject({method: "GET", url: "/developers/integration.md"});
    const rendered = await app.inject({method: "GET", url: "/developers/doc/integration"});
    expect(markdown.statusCode).toBe(200);
    expect(rendered.statusCode).toBe(200);
    const declaration = markdown.body.split(/\r?\n/).find(line => /^(?:当前实现的)?事件包括：/.test(line));
    expect(declaration, "the integration guide must identify its actual event contract").toBeDefined();
    const documented = [...new Set([...declaration!.matchAll(/`([a-z]+(?:\.[a-z]+)+)`/g)].map(match => match[1]!))];
    expect(documented.sort()).toEqual([...CURRENT_EVENTS].sort());
    for (const event of CURRENT_EVENTS) expect(rendered.body).toContain(`<code>${event}</code>`);
    const numberedGuide = readFileSync(new URL("../docs/02-代理商技术接入开发文档.md", import.meta.url), "utf8");
    const numberedDeclaration = numberedGuide.split(/\r?\n/).find(line => /^(?:当前实现的)?事件包括：/.test(line));
    expect(numberedDeclaration).toBeDefined();
    const numberedEvents = [...new Set([...numberedDeclaration!.matchAll(/`([a-z]+(?:\.[a-z]+)+)`/g)].map(match => match[1]!))];
    expect(numberedEvents.sort()).toEqual(documented);
    const portal = await app.inject({method: "GET", url: "/developers"});
    expect(portal.statusCode).toBe(200);
    for (const event of ["cdk.failed", "cdk.disabled", "wallet.deposit.credited"]) expect(portal.body).toContain(event);
    for (const event of ["refund.rejected", "settlement.created", "settlement.paid"]) expect(portal.body).not.toContain(event);

    const first = await createOrder();
    runtime.payment.markPaid(first.merchantId, first.id, {providerRef: "docs-cdk-issued", receivedMinor: first.saleAmountMinor});
    expect(await runtime.cdk.issueOne()).not.toBeNull();
    await runtime.cdk.disable(first.id);
    const second = await createOrder();
    runtime.payment.markPaid(second.merchantId, second.id, {providerRef: "docs-cdk-failed", receivedMinor: second.saleAmountMinor});
    vi.spyOn(runtime.upstream, "issueCdk").mockRejectedValueOnce(new UpstreamRequestError("out_of_stock", false));
    await runtime.cdk.issueOne();
    const emitted = runtime.repository.listOutbox(first.merchantId).map(event => event.eventType);
    expect(emitted).toEqual(expect.arrayContaining(["cdk.issued", "cdk.disabled", "cdk.failed"]));
    for (const event of emitted) expect(documented).toContain(event);
  });

  it("keeps documented cursor pagination aligned with signed API responses and OpenAPI", async () => {
    const document = YAML.parse((await app.inject({method: "GET", url: "/developers/openapi.yaml"})).body);
    const guide = readFileSync(new URL("../docs/27-Quefa下游统一对接标准.md", import.meta.url), "utf8");
    const responses = guide.match(/### 3\.3[^\n]*\n([\s\S]*?)(?=\n### |$)/)?.[1];
    expect(responses).toContain("next_cursor");
    expect(responses).not.toContain("及列表的 `meta`");
    for (const path of ["/v1/orders", "/v1/ledger", "/v1/settlements"]) {
      const response = await signed("GET", `${path}?limit=1`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({data: [], next_cursor: null});
      expect(response.json()).not.toHaveProperty("meta");
      const declared = document.paths[path].get.responses["200"].content["application/json"].schema;
      const schema = declared.$ref
        ? (declared.$ref as string).slice(2).split("/").reduce((value: any, key) => value[key], document)
        : declared;
      expect(schema.properties).toHaveProperty("next_cursor");
      expect(schema.properties).not.toHaveProperty("meta");
    }
  });

  it("documents the signed direct-code route with the real response while preserving legacy payload semantics", async () => {
    const document = YAML.parse((await app.inject({method: "GET", url: "/developers/openapi.yaml"})).body);
    const order = await createOrder(), profile = runtime.agents.profile(order.merchantId);
    runtime.agents.saveProfile({id: "docs-admin", merchantId: null, role: "platform_admin"}, order.merchantId,
      {...profile, directPaymentCodeEnabled: true});
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page", providerRef: order.id, updatedAt: new Date()});
    const precreate = vi.fn(async () => "https://qr.alipay.com/docs-isolated-code");
    (runtime as unknown as {alipay: {precreate: typeof precreate}}).alipay = {precreate};
    const response = await signed("POST", `/v1/orders/${order.id}/payment-code`, {});
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(Object.keys(data).sort()).toEqual([...document.components.schemas.PaymentCode.required].sort());
    expect(data.payment_code).toBe("https://qr.alipay.com/docs-isolated-code");
    expect(data.qr_image_data_url).toMatch(/^data:image\/png;base64,/);
    expect(runtime.repository.findOrderInternal(order.id)?.qrPayload).toBe(order.qrPayload);
    for (const route of ["/developers/integration.md", "/developers/payment-channels.md"]) {
      const page = await app.inject({method: "GET", url: route});
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("POST /v1/orders/{order_id}/payment-code");
      for (const field of ["payment_code", "qr_image_data_url", "qr_payload"]) expect(page.body).toContain(field);
    }
    const renderedPaymentGuide = await app.inject({method: "GET", url: "/developers/doc/payment-channels"});
    expect(renderedPaymentGuide.statusCode).toBe(200);
    expect(renderedPaymentGuide.body).toContain('<a href="/developers/doc/integration">接入文档</a>');
    const standard = readFileSync(new URL("../docs/27-Quefa下游统一对接标准.md", import.meta.url), "utf8");
    expect(standard).toContain("POST /v1/orders/{order_id}/payment-code");
    expect(document.components.schemas.Order.properties.qr_payload.description).toContain("付款页 URL");
  });

  it("accepts real non-QF merchant formats throughout the public code contract", async () => {
    const document = YAML.parse((await app.inject({method: "GET", url: "/developers/openapi.yaml"})).body);
    const voucherSchema = document.components.schemas.Order.properties.voucher_code;
    const publicCodeSchema = document.paths["/public/cdk/redeem"].post.requestBody.content["application/json"].schema.properties.code;
    for (const template of ["{PREFIX}_{RANDOM:10}-{RANDOM:10}", "{PREFIX}{RANDOM:12}{RANDOM:8}"]) {
      const code = createPublicCdkCode("SHOP", template);
      expect(code.startsWith("QF")).toBe(false);
      expect(isPublicCdkCode(code)).toBe(true);
      expect(code).toMatch(new RegExp(voucherSchema.pattern));
      expect(code).toMatch(new RegExp(publicCodeSchema.pattern));
    }
    expect(voucherSchema.description).toContain("不透明字符串");
    expect(document.components.schemas.CreateOrderRequest.properties.delivery_mode.description).not.toContain("QF 码");
    expect(document.paths["/public/cdk/redeem"].post.summary).not.toContain("QF 码");
    for (const route of ["/developers/integration.md", "/developers/redemption.md", "/developers/partner-guide.md"]) {
      const page = await app.inject({method: "GET", url: route});
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("不透明");
    }
    const renderedRedemptionGuide = await app.inject({method: "GET", url: "/developers/doc/redemption"});
    expect(renderedRedemptionGuide.statusCode).toBe(200);
    expect(renderedRedemptionGuide.body).toContain('<a href="/developers/doc/payment-channels">支付通道接入</a>');
  });
});
