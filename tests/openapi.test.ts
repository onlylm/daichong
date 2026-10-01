import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";

describe("OpenAPI document", () => {
  it("is parseable OpenAPI 3.1 and contains the required surface", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/v1/products", "/v1/payment-methods", "/v1/payment-tests", "/v1/orders", "/v1/orders/{order_id}", "/v1/orders/{order_id}/payment-code",
      "/v1/orders/{order_id}/fulfillments", "/v1/orders/{order_id}/refunds",
      "/v1/ledger", "/v1/settlements", "/v1/settlements/{settlement_id}", "/v1/webhooks/test",
      "/v1/redemptions", "/v1/redemptions/{redemption_id}", "/v1/tier-applications", "/v1/tickets", "/v1/wallet",
    ]) expect(document.paths[path]).toBeDefined();
    expect(document.paths["/v1/orders"].get).toBeDefined();
    expect(document.paths["/v1/orders"].post).toBeDefined();
    expect(document.paths["/v1/orders/{order_id}/payment-code"].post.requestBody.content["application/json"].schema)
      .toMatchObject({additionalProperties: false, maxProperties: 0});
    expect(document.components.schemas.Order.properties.qr_payload.description).toContain("付款页 URL");
    expect(document.components.schemas.PaymentCode.properties.qr_image_data_url.pattern).toBe("^data:image/png;base64,");
    expect(document.info.version).toBe("1.3.0");
    expect(document.paths["/v1/payment-tests"].post.description).toContain("不会生成 CDK");
    expect(document["x-rate-limit"]).toMatchObject({scope: "API Key", buckets: ["read", "write"],
      exceeded: {status: 429, code: "rate_limited", retry_header: "Retry-After"}});
    expect(document.components.responses.RateLimited.headers).toHaveProperty("X-RateLimit-Reset");
    expect(document["x-idempotency-claim"]).toMatchObject({lease_seconds: 300, concurrent_status: 409,
      concurrent_code: "idempotency_in_progress", retry_header: "Retry-After"});
  });

  it("does not expose per-agent Alipay configuration", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    const pathNames = Object.keys(document.paths);
    expect(pathNames.some((path) => /alipay|payment[-_]?config|payment[-_]?setting/i.test(path))).toBe(false);

    const forbiddenFields = new Set([
      "alipay_app_id", "alipay_merchant_id", "alipay_private_key", "alipay_public_key",
      "seller_id", "payment_config", "payment_credentials",
    ]);
    for (const field of collectPropertyNames(document.components?.schemas ?? {})) {
      expect(forbiddenFields.has(field)).toBe(false);
    }
  });

  it("keeps every registered Partner API route and HTTP method in sync with OpenAPI", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const runtime = createRuntime(config), app = await buildApp(config, runtime);
    try {
      const registered = parseRegisteredRoutes(app.printRoutes({commonPrefix: false}), "/v1/");
      const documented = new Map<string, string[]>();
      for (const [path, value] of Object.entries(document.paths as Record<string, Record<string, unknown>>)) {
        if (!path.startsWith("/v1/")) continue;
        documented.set(canonicalRoute(path), Object.keys(value).filter(key => HTTP_METHODS.has(key)).sort());
      }
      expect([...registered.keys()].sort()).toEqual([...documented.keys()].sort());
      for (const [path, methods] of registered) expect(documented.get(path)).toEqual(methods);
    } finally {
      await app.close();
      runtime.close();
    }
  });

  it("keeps every Partner API success response machine-readable and every local reference resolvable", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    for (const [path, value] of Object.entries(document.paths as Record<string, Record<string, any>>)) {
      if (!path.startsWith("/v1/")) continue;
      for (const [method, operation] of Object.entries(value)) {
        if (!HTTP_METHODS.has(method)) continue;
        const successes = Object.entries(operation.responses as Record<string, any>).filter(([status]) => /^2\d\d$/.test(status));
        expect(successes.length, `${method.toUpperCase()} ${path} has no success response`).toBeGreaterThan(0);
        for (const [status, response] of successes) {
          expect(response.content?.["application/json"]?.schema,
            `${method.toUpperCase()} ${path} ${status} has no JSON schema`).toBeDefined();
        }
      }
    }
    for (const reference of collectReferences(document)) {
      expect(resolveLocalReference(document, reference), `unresolved OpenAPI reference: ${reference}`).toBeDefined();
    }
  });

  it("documents the real account, support and wallet response fields", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const runtime = createRuntime(config), app = await buildApp(config, runtime);
    try {
      const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
      const merchantId = credential.merchant.id;
      const agent = {id: credential.app.id, merchantId, role: "agent_api" as const};
      const admin = {id: "openapi-contract-admin", merchantId: null, role: "platform_admin" as const};
      const ticket = runtime.support.create(agent, merchantId, {
        orderId: null, title: "契约校验工单", category: "other", body: "检查公开响应字段",
      });
      runtime.announcements.save(admin, {
        title: "契约校验公告", body: "只包含代理商可见字段", status: "published", audience: "all",
        merchantIds: [], tierCodes: [], pinned: false, startsAt: new Date(Date.now() - 60_000), endsAt: null,
      });
      runtime.repository.saveOperations("wallet_entry", {
        id: "openapi-wallet-entry", merchantId, kind: "adjustment", procurementDelta: 100n,
        earningsDelta: 0n, frozenDelta: 0n, reference: "openapi-contract", actorId: admin.id, createdAt: new Date(),
      }, true);

      const profile = (await signedGet(app, config, "/v1/agent-profile")).json();
      assertSchemaObject(document, "AgentProfileEnvelope", profile);
      assertSchemaObject(document, "AgentSummary", profile.data);
      assertSchemaObject(document, "AgentProfile", profile.data.profile);
      assertSchemaObject(document, "TierRules", profile.rules);
      expect(profile.data).not.toHaveProperty("suggestedTier");

      const tickets = (await signedGet(app, config, "/v1/tickets?page=1&limit=10")).json();
      assertSchemaObject(document, "TicketPageEnvelope", tickets);
      assertSchemaObject(document, "PageMeta", tickets.meta);
      assertSchemaObject(document, "Ticket", tickets.data[0]);
      const detail = (await signedGet(app, config, `/v1/tickets/${ticket.id}`)).json();
      assertSchemaObject(document, "TicketEnvelope", detail);
      assertSchemaObject(document, "Ticket", detail.data);
      assertSchemaObject(document, "TicketMessage", detail.data.messages[0]);

      const announcements = (await signedGet(app, config, "/v1/announcements")).json();
      assertSchemaObject(document, "AnnouncementListEnvelope", announcements);
      assertSchemaObject(document, "Announcement", announcements.data[0]);
      const read = (await signedPost(app, config, `/v1/announcements/${announcements.data[0].id}/read`)).json();
      assertSchemaObject(document, "OkEnvelope", read);

      const wallet = (await signedGet(app, config, "/v1/wallet?page=1&limit=10")).json();
      assertSchemaObject(document, "WalletEnvelope", wallet);
      assertSchemaObject(document, "WalletSummary", wallet.data);
      assertSchemaObject(document, "WalletEntry", wallet.entries[0]);
      assertSchemaObject(document, "PageMeta", wallet.entries_meta);
    } finally {
      await app.close();
      runtime.close();
    }
  });

  it("defines the outbound progress contract without exposing admin cancellation endpoints", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    const receiver = document.webhooks.fulfillmentProgress.post;
    expect(receiver.security).toEqual([]);
    expect(receiver.parameters.map((value: {name: string}) => value.name)).toContain("X-Quefa-Signature");
    expect(receiver.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/FulfillmentWebhookEnvelope");
    const fields = document.components.schemas.FulfillmentProgressEvent.properties;
    for (const field of ["order_id", "redemption_id", "attempt_no", "progress_stage", "progress_version", "progress_updated_at", "retry_allowed", "recovery_action"]) {
      expect(fields[field]).toBeDefined();
    }
    expect(fields.recovery_action.enum).toEqual(["retry", "refund", null]);
    expect(Object.keys(document.paths).some(path => path.includes("recharge/resolve") || path.includes("recharge/cancel"))).toBe(false);
  });

  it("documents only the internal recharge supplier surface", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/internal-admin.yaml"), "utf8"));
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/internal/admin/api/supply/connection",
      "/internal/admin/api/supply/test-orders",
      "/internal/admin/api/supply/test-orders/{orderId}/disable-cdk",
      "/internal/admin/api/supply/test-orders/{orderId}/fulfillments/{fulfillmentId}/{action}",
      "/internal/admin/api/supply/test",
      "/internal/admin/api/supply/balance",
      "/internal/admin/api/supply/plans",
      "/internal/admin/api/supply/plans/sync",
      "/internal/admin/api/supply/mappings",
      "/internal/admin/api/supply/mappings/{productCode}",
      "/internal/admin/api/supply/reconciliation/direct-orders",
      "/internal/admin/api/supply/reconciliation/cdks",
      "/internal/admin/api/supply/reconciliation/cdk-orders",
    ]) expect(document.paths[path]).toBeDefined();

    expect(Object.keys(document.paths).some((path) => /(?:^|[/_-])(?:cards?|open-card|card-recharge|card-refund|freeze|cvv)(?:$|[/_-])/i.test(path))).toBe(false);
    const forbiddenFields = new Set([
      "card_id", "card_number", "cvv", "expiry_month", "expiry_year", "billing_address",
    ]);
    for (const field of collectPropertyNames(document.components?.schemas ?? {})) {
      expect(forbiddenFields.has(field)).toBe(false);
    }
  });
});

function collectPropertyNames(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectPropertyNames);
  const object = value as Record<string, unknown>;
  const names = object.properties && typeof object.properties === "object"
    ? Object.keys(object.properties as Record<string, unknown>)
    : [];
  return names.concat(Object.values(object).flatMap(collectPropertyNames));
}

function collectReferences(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectReferences);
  const object = value as Record<string, unknown>;
  const current = typeof object.$ref === "string" && object.$ref.startsWith("#/") ? [object.$ref] : [];
  return current.concat(Object.values(object).flatMap(collectReferences));
}

function resolveLocalReference(document: any, reference: string): unknown {
  return reference.slice(2).split("/").reduce((value: any, segment) => value?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")], document);
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function canonicalRoute(path: string): string {
  return path.replace(/\/(?:\:[^/]+|\{[^/]+\})/g, "/{}");
}

function parseRegisteredRoutes(tree: string, prefix: string): Map<string, string[]> {
  const stack: string[] = [], routes = new Map<string, string[]>();
  for (const line of tree.split(/\r?\n/)) {
    const match = /^((?:│   |    )*)[├└]── (.+?)(?: \(([^)]+)\))?$/.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4, segment = match[2]!;
    const path = depth === 0 ? segment : (stack[depth - 1] ?? "") + segment;
    stack[depth] = path;
    stack.length = depth + 1;
    if (!path.startsWith(prefix) || !match[3]) continue;
    const methods = match[3].split(",").map(value => value.trim().toLowerCase())
      .filter(value => HTTP_METHODS.has(value)).sort();
    routes.set(canonicalRoute(path), methods);
  }
  return routes;
}

function assertSchemaObject(document: any, schemaName: string, value: Record<string, unknown>): void {
  const schema = document.components.schemas[schemaName] as {
    required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean;
  };
  expect(value).toBeTypeOf("object");
  for (const field of schema.required ?? []) expect(value).toHaveProperty(field);
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) expect(schema.properties).toHaveProperty(field);
  }
}

async function signedGet(app: Awaited<ReturnType<typeof buildApp>>, config: ReturnType<typeof loadConfig>, url: string) {
  const separator = url.indexOf("?"), path = separator < 0 ? url : url.slice(0, separator),
    rawQuery = separator < 0 ? "" : url.slice(separator + 1), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
  return app.inject({method: "GET", url, headers: partnerHeaders(config, "GET", path, rawQuery, timestamp, nonce, "", Buffer.alloc(0))});
}

async function signedPost(app: Awaited<ReturnType<typeof buildApp>>, config: ReturnType<typeof loadConfig>, path: string) {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID(), key = `openapi-${randomUUID()}`, rawBody = Buffer.alloc(0);
  return app.inject({method: "POST", url: path, headers: partnerHeaders(config, "POST", path, "", timestamp, nonce, key, rawBody)});
}

function partnerHeaders(config: ReturnType<typeof loadConfig>, method: string, path: string, rawQuery: string,
  timestamp: string, nonce: string, idempotencyKey: string, rawBody: Buffer) {
  return {"x-partner-id": config.demoPartnerId, "x-key-id": config.demoKeyId, "x-timestamp": timestamp, "x-nonce": nonce,
    ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
    "x-signature": signRequest({method, path, rawQuery, timestamp, nonce, keyId: config.demoKeyId, idempotencyKey, rawBody}, config.demoClientSecret)};
}
