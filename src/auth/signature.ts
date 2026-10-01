import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureInput {
  method: string;
  path: string;
  rawQuery: string;
  timestamp: string;
  nonce: string;
  keyId: string;
  idempotencyKey: string;
  rawBody: Buffer;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(rawQuery: string): string {
  if (!rawQuery) return "";
  return rawQuery
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const separator = part.indexOf("=");
      const rawKey = separator === -1 ? part : part.slice(0, separator);
      const rawValue = separator === -1 ? "" : part.slice(separator + 1);
      return [rfc3986(decodeURIComponent(rawKey)), rfc3986(decodeURIComponent(rawValue))] as const;
    })
    .sort(([keyA, valueA], [keyB, valueB]) => keyA.localeCompare(keyB) || valueA.localeCompare(valueB))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function canonicalString(input: SignatureInput): string {
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  return [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.rawQuery),
    input.timestamp,
    input.nonce,
    input.keyId,
    input.idempotencyKey,
    bodyHash,
  ].join("\n");
}

export function signRequest(input: SignatureInput, secret: string): string {
  return createHmac("sha256", secret).update(canonicalString(input), "utf8").digest("hex");
}

export function signaturesEqual(expected: string, supplied: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(supplied, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

