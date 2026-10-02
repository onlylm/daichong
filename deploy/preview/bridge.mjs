import http from "node:http";
import net from "node:net";
import {chmod, lstat, mkdir, unlink} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {pathToFileURL} from "node:url";

export const PREVIEW_SOCKET_PATH = "/run/quefa-preview/api.sock";
export const PREVIEW_ORIGIN = "http://127.0.0.1:13200";
export const PREVIEW_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'";
const htmlLimit = 2 * 1024 * 1024;
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const banner = `<style id="quefa-preview-style">:root{--preview-notice-height:56px}body{padding-top:var(--preview-notice-height)!important}.shell{top:var(--preview-notice-height)!important;height:calc(100svh - var(--preview-notice-height))!important}#quefa-preview-notice{position:fixed;inset:0 0 auto;z-index:2147483647;box-sizing:border-box;min-height:var(--preview-notice-height);display:flex;align-items:center;justify-content:center;padding:8px 16px;background:#fff3cd;color:#543b00;border-bottom:1px solid #cda83f;font:600 15px/1.4 system-ui,sans-serif;text-align:center;overflow-wrap:anywhere}#quefa-preview-notice strong{margin-right:8px}@media(max-width:720px){:root{--preview-notice-height:80px}.shell{height:auto!important}#quefa-preview-notice{font-size:14px;flex-wrap:wrap}}</style><aside id="quefa-preview-notice" role="note"><strong>隔离验收环境</strong><span>仅操作测试副本，不代表生产结果；真实交易入口已禁用，请勿输入真实充值资料。</span></aside>`;

/** Only HTTP origin-form paths are accepted; encoded route delimiters never reach the backend. */
export function previewPathAllowed(rawUrl, method = "GET") {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || rawUrl.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(rawUrl)) return false;
  const path = rawUrl.split("?")[0];
  if (path.includes("%") || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return false;
  if (path.startsWith("/workspace/api/")) return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!["GET", "HEAD"].includes(method)) return false;
  if (path === "/workspace" || path === "/workspace/" || path === "/workspace/app") return true;
  if (["/favicon.ico", "/favicon.svg", "/brand/logo-mark.svg"].includes(path)) return true;
  if (path.startsWith("/workspace/assets/") || path.startsWith("/assets/") || path === "/developers" || path.startsWith("/developers/")) return true;
  return method === "GET" && ["/health/live", "/health/ready", "/health/worker"].includes(path);
}

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("preview_origin_must_be_loopback");
  return url.origin;
}

function filteredHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...String(headers.connection ?? "").toLowerCase().split(",").map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

function browserHeaders(headers = {}) {
  const result = filteredHeaders(headers);
  for (const key of ["content-security-policy", "content-security-policy-report-only", "refresh", "link", "content-location", "etag", "last-modified", "content-length"]) delete result[key];
  return {...result, "content-security-policy": PREVIEW_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", "x-quefa-preview": "isolated"};
}

function blocked(response, method, status = 403) {
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离验收 · 交易入口已禁用</title><body>${banner}<main style="max-width:640px;margin:48px auto;padding:16px;font:16px/1.7 system-ui"><h1>此入口不参与隔离验收</h1><p>真实支付、充值、开放 API 与回调入口均已阻断。请返回工作台查看测试副本。</p><a href="/workspace">返回工作台</a></main></body></html>`;
  response.writeHead(status, browserHeaders({"content-type": "text/html; charset=utf-8"}));
  response.end(method === "HEAD" ? undefined : body);
}

function safeLocation(value, requestPath, origin) {
  try {
    const target = new URL(value, origin + requestPath);
    return target.origin === origin && !target.username && !target.password && previewPathAllowed(target.pathname + target.search)
      ? target.pathname + target.search + target.hash : "/preview-disabled";
  } catch { return "/preview-disabled"; }
}

function decorateHtml(html) {
  // Remove meta redirects before injecting the non-dismissible environment notice.
  const cleaned = html.replace(/<meta\b[^>]*http-equiv\s*=\s*(?:["']\s*refresh\s*["']|refresh)[^>]*>/gi, "");
  return /<body\b[^>]*>/i.test(cleaned) ? cleaned.replace(/<body\b[^>]*>/i, match => match + banner) : banner + cleaned;
}

function rejectTunnel(_request, socket) {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function proxyServer(target, publicOrigin, decorate) {
  const origin = localOrigin(publicOrigin);
  const server = http.createServer((request, response) => {
    if (request.url === "/" && ["GET", "HEAD"].includes(request.method)) {
      response.writeHead(302, browserHeaders({location: "/workspace"})); response.end(); return;
    }
    if (request.url === "/preview-disabled") {blocked(response, request.method, 403); return;}
    if (!previewPathAllowed(request.url, request.method) || request.headers.upgrade) {blocked(response, request.method); return;}
    const headers = filteredHeaders(request.headers);
    for (const key of Object.keys(headers)) if (key.startsWith("x-forwarded-") || key === "forwarded" || key.startsWith("proxy-")) delete headers[key];
    headers.host = new URL(origin).host;
    headers["accept-encoding"] = "identity";
    const upstream = http.request({...target, method: request.method, path: request.url, headers}, incoming => {
      const outgoing = decorate ? browserHeaders(incoming.headers) : filteredHeaders(incoming.headers);
      if (incoming.headers.location) outgoing.location = safeLocation(incoming.headers.location, request.url, origin);
      delete outgoing.refresh;
      if (incoming.statusCode === 101) {incoming.destroy(); blocked(response, request.method); return;}
      const html = decorate && /\btext\/html\b/i.test(String(incoming.headers["content-type"]));
      if (html && request.method !== "HEAD") {
        if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
          incoming.destroy(); blocked(response, request.method, 502); return;
        }
        const chunks = []; let bytes = 0;
        incoming.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > htmlLimit) {incoming.destroy(); blocked(response, request.method, 502);}
          else chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (response.writableEnded) return;
          response.writeHead(incoming.statusCode ?? 502, outgoing);
          response.end(decorateHtml(Buffer.concat(chunks).toString("utf8")));
        });
      } else {
        response.writeHead(incoming.statusCode ?? 502, outgoing);
        incoming.pipe(response);
      }
      incoming.on("error", () => {if (!response.headersSent) blocked(response, request.method, 502); else response.destroy();});
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on("error", () => {if (!response.headersSent) blocked(response, request.method, 502); else response.destroy();});
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {if (!response.writableEnded) upstream.destroy();});
    request.pipe(upstream);
  });
  server.on("connect", rejectTunnel);
  server.on("upgrade", rejectTunnel);
  return server;
}

/** Gateway has no network-selectable destination and needs no database or credential. */
export function createPreviewGateway({socketPath = PREVIEW_SOCKET_PATH, publicOrigin = PREVIEW_ORIGIN} = {}) {
  return proxyServer({socketPath}, publicOrigin, true);
}

/** apiPort is a constructor-only test seam; the CLI always targets local port 3200. */
export function createApiSocketBridge({apiPort = 3200, publicOrigin = PREVIEW_ORIGIN} = {}) {
  return proxyServer({host: "127.0.0.1", port: apiPort}, publicOrigin, false);
}

/** Recover only an unchanged, listenerless socket; never remove files or a live peer. */
export async function preparePreviewSocket(socketPath = PREVIEW_SOCKET_PATH) {
  const previous = await lstat(socketPath).catch(error => {if (error.code === "ENOENT") return null; throw error;});
  if (!previous) return;
  if (!previous.isSocket()) throw new Error("preview_socket_path_occupied");
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {probe.destroy(); reject(new Error("preview_socket_already_active"));});
    probe.once("error", error => {
      if (["ECONNREFUSED", "ENOENT"].includes(error.code)) resolve(); else reject(new Error("preview_socket_probe_failed"));
    });
    probe.setTimeout(500, () => {probe.destroy(); reject(new Error("preview_socket_probe_timeout"));});
  });
  const current = await lstat(socketPath).catch(error => {if (error.code === "ENOENT") return null; throw error;});
  if (!current) return;
  if (!current.isSocket() || current.dev !== previous.dev || current.ino !== previous.ino) throw new Error("preview_socket_changed");
  await unlink(socketPath);
}

export async function startBridge(mode, env = process.env) {
  const publicOrigin = localOrigin(env.PREVIEW_PUBLIC_ORIGIN || PREVIEW_ORIGIN);
  if (mode === "gateway") {
    const server = createPreviewGateway({publicOrigin});
    await new Promise((resolve, reject) => {server.once("error", reject); server.listen(3200, "0.0.0.0", resolve);});
    return server;
  }
  if (mode !== "api") throw new Error("preview_mode_required");
  if (env.NODE_ENV !== "development" || env.EXECUTION_MODE !== "disabled" || env.PAYMENT_PROVIDER !== "mock"
    || env.FULFILLMENT_PROVIDER !== "mock" || env.ENABLE_SANDBOX_ROUTES !== "false") throw new Error("preview_isolation_configuration_required");
  // The API process and Unix bridge run in the network-none container, never a Worker.
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "3200";
  await import(pathToFileURL(resolve(env.PREVIEW_APP_ROOT || "/app", "dist/server.js")).href);
  await mkdir(dirname(PREVIEW_SOCKET_PATH), {recursive: true, mode: 0o750});
  await preparePreviewSocket();
  const server = createApiSocketBridge({publicOrigin});
  await new Promise((resolve, reject) => {server.once("error", reject); server.listen(PREVIEW_SOCKET_PATH, resolve);});
  await chmod(PREVIEW_SOCKET_PATH, 0o660);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startBridge(process.argv[2]).then(server => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
  }).catch(() => {console.error("隔离预览桥接启动失败，请检查隔离配置、固定端口及专用套接字目录。"); process.exitCode = 1;});
}
