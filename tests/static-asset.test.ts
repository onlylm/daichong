import {brotliDecompressSync, gunzipSync} from "node:zlib";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";

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
    const gzip = await app.inject({url: "/workspace/assets/app.js", headers: {"accept-encoding": "gzip"}});
    expect(gzip.statusCode).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.headers.vary).toContain("Accept-Encoding");
    expect(gunzipSync(gzip.rawPayload).toString()).toContain('button("刷新订单"');

    const br = await app.inject({url: "/workspace/assets/app.js", headers: {"accept-encoding": "br, gzip"}});
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.rawPayload).toString()).toContain("function syncOrdersLive");

    const identity = await app.inject({url: "/workspace/assets/app.js", headers: {"accept-encoding": "identity"}});
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toContain('button("刷新订单"');

    const page = await app.inject({url: "/workspace/app"});
    expect(page.body).toContain("20261001-action-center-v2");
  });
});
