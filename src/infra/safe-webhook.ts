import {lookup} from "node:dns/promises";
import {request as httpRequest} from "node:http";
import {request as httpsRequest} from "node:https";
import ipaddr from "ipaddr.js";
import {AppError} from "../domain/errors.js";

function resolveAddresses(host: string) { return lookup(host, {all: true, verbatim: true}); }

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export function validateWebhookUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || /(^|\.)(localhost|local|internal)$/i.test(host) || (ipaddr.isValid(host) && !isPublicAddress(host))) {
    throw new AppError(422, "webhook_url_restricted", "回调地址必须为不含账号密码的公网 HTTP(S) 地址");
  }
  return url;
}

/** Resolve, validate and pin the connection address. Never follow redirects. */
export async function safeWebhookFetch(value: string, init: RequestInit): Promise<{ok: boolean; status: number}> {
  const url = validateWebhookUrl(value), host = url.hostname.replace(/^\[|\]$/g, "");
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
  signal.throwIfAborted();
  const addresses = await new Promise<Awaited<ReturnType<typeof resolveAddresses>>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    resolveAddresses(host).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("webhook_target_restricted");
  signal.throwIfAborted();
  const target = addresses[0]!;
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      hostname: target.address, family: target.family, servername: host,
      method: "POST", headers: {...headers, host: url.host},
      signal,
    }, response => {
      let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 65_536) request.destroy(new Error("webhook_response_too_large")); });
      response.on("error", reject);
      response.on("end", () => { const status = response.statusCode ?? 0; resolve({status, ok: status >= 200 && status < 300}); });
    });
    request.setTimeout(5000, () => request.destroy(new Error("webhook_timeout")));
    request.on("error", reject);
    request.end(typeof init.body === "string" ? init.body : undefined);
  });
}
