import http, {type Server} from "node:http";
import net from "node:net";
import {lstat, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {afterEach, describe, expect, it} from "vitest";

const bridge = await import(new URL("../deploy/preview/bridge.mjs", import.meta.url).href);
const servers: Server[] = [], directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

async function socketPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\quefa-preview-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "qfp-")); directories.push(directory);
  return join(directory, "api.sock");
}

async function listen(server: Server, path?: string): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (path) server.listen(path, resolve); else server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address(); return typeof address === "object" && address ? address.port : 0;
}

function request(port: number, path: string, options: {method?: string; headers?: Record<string, string>; body?: string} = {}) {
  return new Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}>((resolve, reject) => {
    const request = http.request({host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers}, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8")}));
    });
    request.on("error", reject); request.end(options.body);
  });
}

async function fixture(handler: http.RequestListener) {
  const socket = await socketPath();
  await listen(http.createServer(handler), socket);
  const gateway = bridge.createPreviewGateway({socketPath: socket});
  const port = await listen(gateway);
  return {port, gateway};
}

describe("isolated preview HTTP bridge", () => {
  it("uses only its configured socket, ignores proxy headers and forwards no password to an external target", async () => {
    const seen: Array<{url: string | undefined; headers: http.IncomingHttpHeaders; body: string}> = [];
    const {port} = await fixture((req, res) => {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {seen.push({url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString()});
        res.setHeader("content-type", "application/json"); res.end('{"ok":true}');});
    });
    const result = await request(port, "/workspace/api/auth/login?target=https%3A%2F%2Foutside.invalid", {method: "POST",
      headers: {host: "outside.invalid", "x-forwarded-host": "outside.invalid", forwarded: "host=outside.invalid",
        "proxy-authorization": "must-not-forward", "content-type": "application/json"}, body: '{"password":"synthetic-only"}'});
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.host).toBe("127.0.0.1:13200");
    expect(seen[0]?.headers["x-forwarded-host"]).toBeUndefined();
    expect(seen[0]?.headers.forwarded).toBeUndefined();
    expect(seen[0]?.headers["proxy-authorization"]).toBeUndefined();
    expect(seen[0]?.body).toBe('{"password":"synthetic-only"}');
    expect((await request(port, "http://outside.invalid/workspace")).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it.each(["/payments/order/start", "/wallet-payments/deposit", "/invoice-payments/inv/status", "/recharge/order",
    "/redeem", "/public/cdk/redeem", "/v1/orders", "/internal/webhooks/alipay", "/sandbox/payments/order",
    "/workspace/../payments/order", "/workspace/api/../../payments/order", "/workspace/%2e%2e/payments/order",
    "/workspace/api%2f..%2fpayments", "//outside.invalid/workspace", "/workspaceevil"])("blocks %s before reaching the API", async path => {
    let called = 0;
    const {port} = await fixture((_req, res) => {called++; res.end("unexpected");});
    const result = await request(port, path);
    expect(result.status).toBe(403); expect(called).toBe(0);
    expect(result.body).toContain("此入口不参与隔离验收");
  });

  it("permits only the required page/assets routes and GET health", async () => {
    const {port} = await fixture((_req, res) => res.end("allowed"));
    for (const path of ["/workspace", "/workspace/app", "/workspace/assets/app.hash.js", "/assets/app.css",
      "/favicon.ico", "/favicon.svg", "/brand/logo-mark.svg", "/developers", "/developers/assets/portal.js", "/health/ready"]) {
      expect((await request(port, path)).body).toBe("allowed");
    }
    for (const path of ["/workspace", "/developers", "/assets/app.css", "/health/ready"]) {
      expect((await request(port, path, {method: "POST"})).status).toBe(403);
    }
  });

  it.each(["https://tibo.ink/payments/order", "//outside.invalid/workspace", "/payments/order", "javascript:alert(1)"])(
    "does not follow or return an external/transaction Location: %s", async location => {
      let calls = 0;
      const {port} = await fixture((_req, res) => {calls++; res.writeHead(302, {location, refresh: "0;url=" + location}); res.end();});
      const result = await request(port, "/workspace");
      expect(result.status).toBe(302); expect(result.headers.location).toBe("/preview-disabled");
      expect(result.headers.refresh).toBeUndefined(); expect(calls).toBe(1);
    });

  it("preserves a permitted same-origin redirect as a relative URL", async () => {
    const {port} = await fixture((_req, res) => {res.writeHead(302, {location: "http://127.0.0.1:13200/workspace/app?view=orders"}); res.end();});
    expect((await request(port, "/workspace")).headers.location).toBe("/workspace/app?view=orders");
  });

  it("adds self-only CSP and the isolation notice to HTML while discarding stale lengths and meta refresh", async () => {
    const html = '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://outside.invalid"></head><body class="app"><h1>工作台</h1></body></html>';
    const {port} = await fixture((_req, res) => {
      res.writeHead(200, {"content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html),
        "content-security-policy": "default-src *", "cache-control": "public,max-age=31536000,immutable", etag: '"old"'});
      res.end(html);
    });
    const result = await request(port, "/workspace/app");
    expect(result.headers["content-security-policy"]).toBe(bridge.PREVIEW_CSP);
    expect(result.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(result.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(result.headers["content-security-policy"]).toContain("frame-src 'none'");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers.etag).toBeUndefined(); expect(result.headers["content-length"]).toBeUndefined();
    expect(result.body).toContain('<body class="app"><style id="quefa-preview-style">');
    expect(result.body).toContain("隔离验收环境"); expect(result.body).toContain("<h1>工作台</h1>");
    expect(result.body).not.toMatch(/http-equiv="refresh"/);
  });

  it.each(["CONNECT outside.invalid:443 HTTP/1.1\r\nHost: outside.invalid\r\n\r\n",
    "GET /workspace HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"])("rejects tunneling and protocol upgrades", async raw => {
    let called = 0;
    const {port} = await fixture((_req, res) => {called++; res.end("unexpected");});
    const result = await new Promise<string>((resolve, reject) => {
      const connection = net.connect({host: "127.0.0.1", port}, () => connection.write(raw));
      let data = ""; connection.setEncoding("utf8"); connection.on("data", chunk => {data += chunk;});
      connection.on("end", () => resolve(data)); connection.on("error", reject);
    });
    expect(result).toContain("403 Forbidden"); expect(called).toBe(0);
  });

  it("runs the inner bridge on a local socket and connects only to a loopback API", async () => {
    let local = "", host = "";
    const apiPort = await listen(http.createServer((req, res) => {local = req.socket.localAddress ?? "";
      host = req.headers.host ?? ""; res.end("local-api");}));
    const inner = bridge.createApiSocketBridge({apiPort});
    const socket = await socketPath(); await listen(inner, socket);
    expect(inner.address()).toBe(socket);
    const port = await listen(bridge.createPreviewGateway({socketPath: socket}));
    const result = await request(port, "/workspace", {headers: {host: "outside.invalid"}});
    expect(result.body).toBe("local-api"); expect(local).toBe("127.0.0.1"); expect(host).toBe("127.0.0.1:13200");
  });

  it("refuses external public origins and unsafe API startup configuration before importing anything", async () => {
    expect(() => bridge.createPreviewGateway({publicOrigin: "https://tibo.ink"})).toThrow("loopback");
    await expect(bridge.startBridge("api", {NODE_ENV: "production"})).rejects.toThrow("isolation_configuration_required");
    await expect(bridge.startBridge("worker", {})).rejects.toThrow("preview_mode_required");
  });

  it("does not delete a non-socket file at the requested path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qfp-file-")); directories.push(directory);
    const path = join(directory, "api.sock"); await writeFile(path, "preserve-this-file");
    await expect(bridge.preparePreviewSocket(path)).rejects.toThrow("preview_socket_path_occupied");
    expect(await readFile(path, "utf8")).toBe("preserve-this-file");
  });

  it.skipIf(process.platform === "win32")("refuses to unlink a socket with an active listener", async () => {
    const socket = await socketPath(); await listen(http.createServer(), socket);
    await expect(bridge.preparePreviewSocket(socket)).rejects.toThrow("preview_socket_already_active");
    expect((await lstat(socket)).isSocket()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("recovers a stale Unix socket left by an abruptly stopped process", async () => {
    const socket = await socketPath();
    await promisify(execFile)(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))", socket]);
    expect((await lstat(socket)).isSocket()).toBe(true);
    await bridge.preparePreviewSocket(socket);
    await expect(lstat(socket)).rejects.toMatchObject({code: "ENOENT"});
    await listen(http.createServer(), socket);
    expect((await lstat(socket)).isSocket()).toBe(true);
  });
});
