import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("OpenAPI document", () => {
  it("is parseable OpenAPI 3.1 and contains the required surface", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const document = YAML.parse(readFileSync(join(here, "../openapi/openapi.yaml"), "utf8"));
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/v1/products", "/v1/payment-methods", "/v1/orders", "/v1/orders/{order_id}",
      "/v1/orders/{order_id}/fulfillments", "/v1/orders/{order_id}/refunds",
      "/v1/ledger", "/v1/settlements", "/v1/settlements/{settlement_id}", "/v1/webhooks/test",
      "/v1/redemptions", "/v1/redemptions/{redemption_id}", "/v1/tier-applications", "/v1/tickets", "/v1/wallet",
    ]) expect(document.paths[path]).toBeDefined();
    expect(document.paths["/v1/orders"].get).toBeDefined();
    expect(document.paths["/v1/orders"].post).toBeDefined();
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
