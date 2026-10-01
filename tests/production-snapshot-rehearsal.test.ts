import {randomBytes} from "node:crypto";
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {inspectSqliteBackup} from "../src/infra/sqlite-backup-verifier.js";
import {rehearseProductionSnapshot} from "../src/infra/production-snapshot-rehearsal.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("production snapshot migration rehearsal", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true});
  });

  it("starts production candidate code only on a temporary restore and preserves critical records and source bytes", async () => {
    const fixture = await createSnapshotFixture();
    const beforeBytes = readFileSync(fixture.snapshot);
    const before = await inspectSqliteBackup(fixture.snapshot);

    const report = await rehearseProductionSnapshot(fixture.snapshot, productionEnvironment(fixture, join(fixture.folder, "live.sqlite")));
    const after = await inspectSqliteBackup(fixture.snapshot);

    expect(report).toMatchObject({
      status: "ok",
      snapshotFile: "snapshot.sqlite",
      criticalDigestUnchanged: true,
      sourceSnapshotUnchanged: true,
      productionWrites: false,
      startupRoutes: {ready: 200, developers: 200, openapi: 200},
    });
    expect(report.criticalRecordCount).toBeGreaterThanOrEqual(3);
    expect(report.criticalKindCounts).toMatchObject({order: 1, payment_attempt: 1, ops_wallet_entry: 1});
    expect(after.fileSha256).toBe(before.fileSha256);
    expect(after.logicalSha256).toBe(before.logicalSha256);
    expect(readFileSync(fixture.snapshot)).toEqual(beforeBytes);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("snapshot-migration-order");
    expect(serialized).not.toContain("secret-value-must-not-leak");
  });

  it("refuses the configured live database and leaves every source byte unchanged", async () => {
    const fixture = await createSnapshotFixture(), before = readFileSync(fixture.snapshot);
    await expect(rehearseProductionSnapshot(fixture.snapshot, productionEnvironment(fixture, fixture.snapshot)))
      .rejects.toThrow("live_database_snapshot_forbidden");
    expect(readFileSync(fixture.snapshot)).toEqual(before);
  });

  it("requires the explicit isolated-snapshot safety flag before opening the backup", async () => {
    const fixture = await createSnapshotFixture(), before = readFileSync(fixture.snapshot);
    const environment = productionEnvironment(fixture, join(fixture.folder, "live.sqlite"));
    delete environment.AUDIT_ISOLATED_SNAPSHOT;
    await expect(rehearseProductionSnapshot(fixture.snapshot, environment)).rejects.toThrow("isolated_snapshot_required");
    expect(readFileSync(fixture.snapshot)).toEqual(before);
  });

  async function createSnapshotFixture() {
    const folder = mkdtempSync(join(tmpdir(), "quefa-production-snapshot-")); folders.push(folder);
    const source = join(folder, "source.sqlite"), snapshot = join(folder, "snapshot.sqlite");
    const dataKey = randomBytes(32).toString("base64");
    const runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: source,
      LOG_LEVEL: "silent", DATA_ENCRYPTION_KEY: dataKey}));
    try {
      publishTestRechargeProduct(runtime);
      const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
      const order = await runtime.orders.create({merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
        appId: credential.app.appId, keyId: credential.key.keyId}, {merchantOrderNo: "snapshot-migration-order",
        productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect",
        metadata: {testSecret: "secret-value-must-not-leak"}});
      runtime.repository.saveOperations("wallet_entry", {id: "snapshot-wallet-entry", merchantId: order.merchantId,
        kind: "adjustment", procurementDelta: 1_000n, earningsDelta: 0n, frozenDelta: 0n, reference: order.id,
        actorId: "snapshot-test", createdAt: new Date("2026-10-01T00:00:00.000Z")}, true);
    } finally {
      runtime.close();
    }
    copyFileSync(source, snapshot);
    return {folder, source, snapshot, dataKey};
  }
});

function productionEnvironment(fixture: {dataKey: string}, liveDatabase: string): NodeJS.ProcessEnv {
  return {
    AUDIT_ISOLATED_SNAPSHOT: "true",
    NODE_ENV: "production",
    EXECUTION_MODE: "production",
    STORAGE_DRIVER: "sqlite",
    SQLITE_PATH: liveDatabase,
    LOG_LEVEL: "silent",
    TRUST_PROXY: "true",
    ENABLE_SANDBOX_ROUTES: "false",
    PUBLIC_BASE_URL: "https://tibo.test",
    ADMIN_BASE_URL: "https://admin.tibo.test",
    PAYMENT_PROVIDER: "managed",
    FULFILLMENT_PROVIDER: "zovocard",
    PLATFORM_ADMIN_TOKEN: "snapshot-production-admin-token-at-least-32-characters",
    PORTAL_TOKEN_SECRET: "snapshot-production-portal-token-at-least-32-characters",
    DEMO_CLIENT_SECRET: "snapshot-production-demo-secret-at-least-32-characters",
    DATA_ENCRYPTION_KEY: fixture.dataKey,
    REGISTRATION_ENABLED: "false",
    ZOVOCARD_API_BASE: "https://zovocard.com/openapi/v1",
    ZOVOCARD_CDK_BASE: "https://zovocard.com/api/v1/cdk",
    SUPPLIER_ALLOWED_HOSTS: "zovocard.com",
  };
}
