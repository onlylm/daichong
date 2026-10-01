import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(timestamp: number, rawBody: Buffer, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(String(timestamp), "utf8")
    .update(".", "utf8")
    .update(rawBody)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyWebhook(timestamp: number, rawBody: Buffer, secret: string, supplied: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (Math.abs(nowSeconds - timestamp) > 300) return false;
  const expected = signWebhook(timestamp, rawBody, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

