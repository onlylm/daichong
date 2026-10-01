import { describe, expect, it } from "vitest";
import { canonicalQuery, canonicalString, signRequest } from "../src/auth/signature.js";

describe("HMAC request signature", () => {
  it("canonicalizes repeated and encoded query values without treating plus as a space", () => {
    expect(canonicalQuery("z=2&a=hello+world&a=%E4%B8%AD%E6%96%87&blank=")).toBe(
      "a=%E4%B8%AD%E6%96%87&a=hello%2Bworld&blank=&z=2",
    );
  });

  it("uses the documented deterministic vector", () => {
    const body = Buffer.from('{"merchant_order_no":"M202609250001","product_code":"chatgpt_plus_cdk_1m","quantity":1,"sale_amount":"135.00"}');
    const input = {
      method: "POST",
      path: "/v1/orders",
      rawQuery: "",
      timestamp: "1790323200",
      nonce: "00000000-0000-4000-8000-000000000001",
      keyId: "key_demo_01",
      idempotencyKey: "checkout_20260925_0001",
      rawBody: body,
    };
    expect(canonicalString(input).split("\n")).toHaveLength(8);
    expect(signRequest(input, "demo_secret_never_use_in_production")).toBe(
      "4590adec9a0d0980822e2b23425ce22081545f74c0a7f9886aa5d8419b7acce5",
    );
  });
});
