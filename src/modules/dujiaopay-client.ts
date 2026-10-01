import {createHash, createHmac, randomUUID, timingSafeEqual} from "node:crypto";
import {AppError} from "../domain/errors.js";

// Only this official origin receives signed credentials; never accept an admin-supplied URL.
export const DUJIAOPAY_ORIGIN = "https://www.dujiaopay.com";
export const USDT_NETWORKS = {
  tron: {tokenId: "tron-usdt", label: "TRON / TRC20", confirmations: 19},
  ethereum: {tokenId: "ethereum-usdt", label: "Ethereum / ERC20", confirmations: 20},
  bsc: {tokenId: "bsc-usdt", label: "BNB Smart Chain / BEP20", confirmations: 15},
  solana: {tokenId: "solana-usdt", label: "Solana", confirmations: 32},
} as const;
export type UsdtNetwork = keyof typeof USDT_NETWORKS;
export interface DujiaoKeys {keyId: string; secret: string}
export function canonicalQuery(query: string): string {
  const groups = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(query)) groups.set(key, [...(groups.get(key) ?? []), value]);
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, ch => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  return [...groups.keys()].sort().flatMap(k => groups.get(k)!.sort().map(v => enc(k) + "=" + enc(v))).join("&");
}
export function signDujiao(keys: DujiaoKeys, method: string, path: string, body = "", query = "", timestamp = Math.floor(Date.now() / 1000).toString(), nonce: string = randomUUID()) {
  const canonical = [method.toUpperCase(), path, canonicalQuery(query), createHash("sha256").update(body).digest("hex"), timestamp, nonce].join("\n");
  return {"DJP-Key-ID": keys.keyId, "DJP-Timestamp": timestamp, "DJP-Nonce": nonce,
    "DJP-Signature": createHmac("sha256", keys.secret).update(canonical).digest("hex")};
}
export function verifyDujiaoWebhook(secret: string, timestamp: string, signature: string, raw: Buffer): boolean {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
export class DujiaoClient {
  constructor(private readonly keys: DujiaoKeys, private readonly transport: typeof fetch = fetch) {}
  whoami(): Promise<Record<string, unknown>> {return this.request("GET", "/v1/whoami");}
  createOrder(input: {merchant_order_id: string; fiat_currency: "CNY"; fiat_amount: string; chain: string; token_id: string}): Promise<Record<string, unknown>> {
    return this.request("POST", "/v1/orders", input, "quefa:" + input.merchant_order_id);
  }
  getOrder(id: string): Promise<Record<string, unknown>> {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new AppError(503, "payment_response_invalid", "支付返回信息不完整");
    return this.request("GET", "/v1/orders/" + id);
  }
  private async request(method: string, path: string, input?: object, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const body = input ? JSON.stringify(input) : "";
    try {
      const response = await this.transport(DUJIAOPAY_ORIGIN + path, {method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: {...signDujiao(this.keys, method, path, body), accept: "application/json", "content-type": "application/json",
          ...(idempotencyKey ? {"Idempotency-Key": idempotencyKey} : {})}, ...(input ? {body} : {})});
      if (!response.ok || !response.body) {await response.body?.cancel(); throw new Error("upstream_status");}
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {while (true) {
        const {done, value} = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 65536) throw new Error("response_too_large");
        chunks.push(value);
      }} finally {await reader.cancel().catch(() => {});}
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
      return value as Record<string, unknown>;
    } catch {throw new AppError(503, "payment_provider_unavailable", "支付服务暂不可用，请稍后核对原订单，不要重复付款", true);}
  }
}
