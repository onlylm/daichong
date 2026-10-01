import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {signRequest} from "../src/auth/signature.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig, type AppConfig} from "../src/config.js";
import {SqliteRepository} from "../src/infra/sqlite-repository.js";

describe("partner API rate limits", () => {
  let runtime: Runtime | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  afterEach(async () => {if (app) await app.close(); runtime?.close(); app = null; runtime = null;});

  async function setup(readPerMinute: number, writePerMinute: number) {
    const config: AppConfig = {...loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}),
      apiRateLimitReadPerMinute: readPerMinute, apiRateLimitWritePerMinute: writePerMinute};
    runtime = createRuntime(config); app = await buildApp(config, runtime);
    return config;
  }

  function signed(config: AppConfig, method: "GET" | "POST", path: string, payload?: unknown, valid = true) {
    const rawBody = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    const idempotencyKey = method === "POST" ? randomUUID() : "";
    const signature = signRequest({method, path, rawQuery: "", timestamp, nonce, keyId: config.demoKeyId,
      idempotencyKey, rawBody}, config.demoClientSecret);
    return app!.inject({method, url: path, headers: {"x-partner-id": config.demoPartnerId, "x-key-id": config.demoKeyId,
      "x-timestamp": timestamp, "x-nonce": nonce, "x-signature": valid ? signature : "0".repeat(64),
      ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
      ...(payload === undefined ? {} : {"content-type": "application/json"})},
      ...(payload === undefined ? {} : {payload: rawBody})});
  }

  it("separates read and write quotas and returns standard reset headers", async () => {
    const config = await setup(2, 1);
    const first = await signed(config, "GET", "/v1/products");
    const second = await signed(config, "GET", "/v1/products");
    const blocked = await signed(config, "GET", "/v1/products");
    expect([first.statusCode, second.statusCode, blocked.statusCode]).toEqual([200, 200, 429]);
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(Number(blocked.headers["x-ratelimit-reset"])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json().error).toMatchObject({code: "rate_limited", retryable: true});

    const created = await signed(config, "POST", "/v1/orders", {merchant_order_no: randomUUID(),
      product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: "135.00"});
    expect(created.statusCode).toBe(201);
    const writeBlocked = await signed(config, "POST", "/v1/orders", {merchant_order_no: randomUUID(),
      product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: "135.00"});
    expect(writeBlocked.statusCode).toBe(429);
  });

  it("does not spend quota for requests that fail signature verification", async () => {
    const config = await setup(1, 1);
    expect((await signed(config, "GET", "/v1/products", undefined, false)).statusCode).toBe(401);
    expect((await signed(config, "GET", "/v1/products")).statusCode).toBe(200);
    expect((await signed(config, "GET", "/v1/products")).statusCode).toBe(429);
  });
});

describe("SQLite shared rate-limit bucket", () => {
  it("counts atomically across repository connections and resets in a new window", () => {
    const directory = mkdtempSync(join(tmpdir(), "quefa-rate-limit-")), path = join(directory, "state.sqlite");
    const first = new SqliteRepository(path), second = new SqliteRepository(path);
    try {
      expect(first.consumeRateLimit("key", 60_000, 2)).toEqual({allowed: true, count: 1});
      expect(second.consumeRateLimit("key", 60_000, 2)).toEqual({allowed: true, count: 2});
      expect(first.consumeRateLimit("key", 60_000, 2)).toEqual({allowed: false, count: 3});
      expect(second.consumeRateLimit("key", 120_000, 2)).toEqual({allowed: true, count: 1});
    } finally {
      first.close(); second.close(); rmSync(directory, {recursive: true, force: true});
    }
  });
});
