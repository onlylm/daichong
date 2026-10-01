import crypto from "node:crypto";

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(rawQuery) {
  if (!rawQuery) return "";
  return rawQuery.split("&").filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      const key = index === -1 ? part : part.slice(0, index);
      const value = index === -1 ? "" : part.slice(index + 1);
      return [rfc3986(decodeURIComponent(key)), rfc3986(decodeURIComponent(value))];
    })
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function sign({ method, url, body = "", timestamp, nonce, keyId, idempotencyKey = "", clientSecret }) {
  const parsed = new URL(url);
  const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [
    method.toUpperCase(), parsed.pathname, canonicalQuery(parsed.search.slice(1)), String(timestamp),
    nonce, keyId, idempotencyKey, bodyHash,
  ].join("\n");
  return crypto.createHmac("sha256", clientSecret).update(canonical, "utf8").digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const body = JSON.stringify({ merchant_order_no: "M202609250001", product_code: "chatgpt_plus_1m", quantity: 1, sale_amount: "135.00" });
  const input = {
    method: "POST",
    url: "https://sandbox-api.example.invalid/v1/orders",
    body,
    timestamp: 1790323200,
    nonce: "00000000-0000-4000-8000-000000000001",
    keyId: "key_demo_01",
    idempotencyKey: "checkout_20260925_0001",
    clientSecret: "demo_secret_never_use_in_production",
  };
  console.log(sign(input));
}
