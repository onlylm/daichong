import {brotliDecompressSync, gunzipSync} from "node:zlib";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {contentAddressedAssetPath, staticAssetHash} from "../src/infra/static-asset.js";
import {workspaceBootJs, workspaceCss, workspaceJs} from "../src/operations/workspace-page.js";

describe("workspace static assets", () => {
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    await app.close();
    runtime.close();
  });

  it("precompresses the workspace bundle and varies by Accept-Encoding", async () => {
    const jsPath = contentAddressedAssetPath("/workspace/assets/app", "js", workspaceJs);
    const gzip = await app.inject({url: jsPath, headers: {"accept-encoding": "gzip"}});
    expect(gzip.statusCode).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers.vary).toContain("Accept-Encoding");
    expect(gunzipSync(gzip.rawPayload).toString()).toContain('button("刷新订单"');

    const br = await app.inject({url: jsPath, headers: {"accept-encoding": "br, gzip"}});
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.rawPayload).toString()).toContain("function syncOrdersLive");

    const identity = await app.inject({url: jsPath, headers: {"accept-encoding": "identity"}});
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toContain('button("刷新订单"');

    expect(identity.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(identity.headers.etag).toBe(`"${staticAssetHash(workspaceJs)}"`);

    const notModified = await app.inject({url: jsPath, headers: {"if-none-match": identity.headers.etag!}});
    expect(notModified.statusCode).toBe(304);
  });

  it("moves browsers from a cached legacy bundle to the current content-hashed bundle after a backend upgrade", async () => {
    const legacy = await app.inject({url: "/workspace/assets/app.js"});
    expect(legacy.statusCode).toBe(200);
    expect(legacy.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");

    const page = await app.inject({url: "/workspace/app"});
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toContain("20261001-cdk-template-v5");
    expect(page.body).not.toContain('src="/workspace/assets/app.js"');
    const scriptPaths = [...page.body.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(match => match[1]);
    const scriptPath = contentAddressedAssetPath("/workspace/assets/app", "js", workspaceJs);
    const bootScriptPath = contentAddressedAssetPath("/workspace/assets/boot", "js", workspaceBootJs);
    const stylePath = page.body.match(/<link rel="stylesheet" href="([^"]+)">/)?.[1];
    expect(scriptPaths).toEqual([bootScriptPath, scriptPath]);
    expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(stylePath).toBe(contentAddressedAssetPath("/workspace/assets/app", "css", workspaceCss));

    const boot = await app.inject({url: bootScriptPath});
    expect(boot.statusCode).toBe(200);
    expect(boot.headers["cache-control"]).toContain("immutable");
    expect(boot.body).toContain("页面加载超时");

    const current = await app.inject({url: scriptPath!});
    expect(current.statusCode).toBe(200);
    expect(current.headers["cache-control"]).toContain("immutable");
    expect(current.body).toContain('/audit?page=');
    expect(current.body).toContain('展开后按订单读取审计记录');

    // Any change creates a new cache key; stale immutable bytes cannot shadow it.
    expect(contentAddressedAssetPath("/workspace/assets/app", "js", workspaceJs + "\n// upgraded"))
      .not.toBe(scriptPath);
  });
});
