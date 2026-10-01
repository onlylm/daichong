import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {signRequest} from "../src/auth/signature.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig, type AppConfig} from "../src/config.js";
import {AppError} from "../src/domain/errors.js";
import type {IdempotencyRecord} from "../src/domain/model.js";
import {SqliteRepository} from "../src/infra/sqlite-repository.js";

describe("partner API idempotency claims", () => {
  const config: AppConfig = {...loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}),
    apiRateLimitReadPerMinute: 1_000, apiRateLimitWritePerMinute: 1_000};
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {if (app) await app.close(); runtime?.close();});

  async function setup() {runtime = createRuntime(config); app = await buildApp(config, runtime);}

  function signedOrder(key: string, body: Record<string, unknown>) {
    const path = "/v1/orders", rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    return app.inject({method: "POST", url: path, headers: {"x-partner-id": config.demoPartnerId,
      "x-key-id": config.demoKeyId, "x-timestamp": timestamp, "x-nonce": nonce, "idempotency-key": key,
      "x-signature": signRequest({method: "POST", path, rawQuery: "", timestamp, nonce,
        keyId: config.demoKeyId, idempotencyKey: key, rawBody}, config.demoClientSecret),
      "content-type": "application/json"}, payload: rawBody});
  }

  it("executes one action for concurrent identical requests, then replays the stored response", async () => {
    await setup();
    const original = runtime.orders.create.bind(runtime.orders);
    let executions = 0, signalStarted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {signalStarted = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    (runtime.orders as unknown as {create: typeof runtime.orders.create}).create = async (...args) => {
      executions++; signalStarted(); await gate; return original(...args);
    };
    const key = "concurrent-order-claim", body = {merchant_order_no: "CONCURRENT-001",
      product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: "135.00"};
    const firstPromise = signedOrder(key, body);
    await started;
    const concurrent = await signedOrder(key, body);
    expect(concurrent.statusCode).toBe(409);
    expect(concurrent.json().error).toMatchObject({code: "idempotency_in_progress", retryable: true});
    expect(Number(concurrent.headers["retry-after"])).toBeGreaterThan(0);
    const conflicting = await signedOrder(key, {...body, sale_amount: "136.00"});
    expect(conflicting.json().error.code).toBe("idempotency_conflict");
    release();
    const first = await firstPromise;
    expect(first.statusCode).toBe(201);
    expect(executions).toBe(1);

    const replay = await signedOrder(key, body);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().data.order_id).toBe(first.json().data.order_id);
    expect(executions).toBe(1);
  });

  it("releases the claim after a failed action so the same business request can recover", async () => {
    await setup();
    const original = runtime.orders.create.bind(runtime.orders);
    let executions = 0;
    (runtime.orders as unknown as {create: typeof runtime.orders.create}).create = async (...args) => {
      executions++;
      if (executions === 1) throw new AppError(503, "temporary_test_failure", "临时失败", true);
      return original(...args);
    };
    const key = "recoverable-order-claim", body = {merchant_order_no: "RECOVER-001",
      product_code: "chatgpt_plus_cdk_1m", quantity: 1, sale_amount: "135.00"};
    expect((await signedOrder(key, body)).statusCode).toBe(503);
    expect((await signedOrder(key, body)).statusCode).toBe(201);
    expect(executions).toBe(2);
  });
});

describe("SQLite idempotency claim lease", () => {
  it("serializes claims across connections and only lets the current lease owner complete", () => {
    const directory = mkdtempSync(join(tmpdir(), "quefa-idempotency-")), path = join(directory, "state.sqlite");
    const first = new SqliteRepository(path), second = new SqliteRepository(path);
    const base: IdempotencyRecord = {merchantId: "merchant", appId: "app", routeKey: "POST /v1/orders", key: "same-key",
      requestHash: "hash-a", responseStatus: 0, responseBody: null};
    const now = new Date("2026-10-01T00:00:00.000Z"), leaseUntil = new Date(now.getTime() + 60_000);
    try {
      expect(first.claimIdempotency(base, "lease-a", now, leaseUntil)).toEqual({state: "claimed"});
      expect(second.claimIdempotency(base, "lease-b", now, leaseUntil)).toEqual({state: "processing", leaseUntil});
      expect(second.claimIdempotency({...base, requestHash: "hash-b"}, "lease-b", now, leaseUntil)).toEqual({state: "conflict"});
      const later = new Date(leaseUntil.getTime() + 1), laterLease = new Date(later.getTime() + 60_000);
      expect(second.claimIdempotency(base, "lease-b", later, laterLease)).toEqual({state: "claimed"});
      expect(first.completeIdempotency({...base, responseStatus: 201, responseBody: {data: "old"}}, "lease-a")).toBe(false);
      expect(second.completeIdempotency({...base, responseStatus: 201, responseBody: {data: "new"}}, "lease-b")).toBe(true);
      const replay = first.claimIdempotency(base, "lease-c", later, laterLease);
      expect(replay.state).toBe("replay");
      if (replay.state === "replay") expect(replay.record.responseBody).toEqual({data: "new"});
    } finally {
      first.close(); second.close(); rmSync(directory, {recursive: true, force: true});
    }
  });
});
