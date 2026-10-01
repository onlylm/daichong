import {describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {readWorkerHealth, WorkerHealthReporter} from "../src/worker/worker-health.js";

describe("durable worker health", () => {
  it("reports healthy, failed, stuck and stale lanes without persisting exception details", () => {
    const repository = new MemoryRepository();
    let now = new Date("2026-10-01T00:00:00.000Z");
    const reporter = new WorkerHealthReporter(repository, ["payment", "fulfillment"], () => now);
    reporter.start("payment"); reporter.succeed("payment"); reporter.persist();
    expect(readWorkerHealth(repository, now)).toMatchObject({status: "healthy", failedLanes: [], stuckLanes: []});

    now = new Date("2026-10-01T00:00:01.000Z");
    reporter.start("payment"); reporter.fail("payment"); reporter.persist();
    expect(readWorkerHealth(repository, now)).toMatchObject({status: "degraded", failedLanes: ["payment"]});
    expect(JSON.stringify(repository.getOperations("worker_health", "primary"))).not.toContain("secret upstream exception");

    reporter.start("fulfillment"); reporter.persist();
    now = new Date("2026-10-01T00:03:00.000Z");
    expect(readWorkerHealth(repository, now, 300_000, 120_000)).toMatchObject({status: "degraded", stuckLanes: ["fulfillment"]});
    expect(readWorkerHealth(repository, now, 15_000, 120_000).status).toBe("stale");
  });

  it("keeps API readiness non-circular and exposes a failing worker probe", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent"});
    const runtime = createRuntime(config), app = await buildApp(config, runtime);
    try {
      const ready = await app.inject({url: "/health/ready"});
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({status: "ok", worker: "missing"});
      const missing = await app.inject({url: "/health/worker"});
      expect(missing.statusCode).toBe(503);
      expect(missing.json()).toMatchObject({status: "missing", failures: 0, stuck: 0});

      new WorkerHealthReporter(runtime.repository, ["payment"], () => new Date(Date.now()-60_000)).persist();
      const stopped = await app.inject({url: "/health/worker"});
      expect(stopped.statusCode).toBe(503);
      expect(stopped.json()).toMatchObject({status: "stale", failures: 0, stuck: 0});

      new WorkerHealthReporter(runtime.repository, ["payment"]).persist();
      const healthy = await app.inject({url: "/health/worker"});
      expect(healthy.statusCode).toBe(200);
      expect(healthy.json()).toMatchObject({status: "healthy", failures: 0, stuck: 0});

      const failed = new WorkerHealthReporter(runtime.repository, ["payment"]);
      failed.start("payment"); failed.fail("payment"); failed.persist();
      const degraded = await app.inject({url: "/health/worker"});
      expect(degraded.statusCode).toBe(503);
      expect(degraded.json()).toMatchObject({status: "degraded", failures: 1, stuck: 0});
    } finally { await app.close(); runtime.close(); }
  });
});
