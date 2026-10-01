import {createHash} from "node:crypto";
import {existsSync, mkdtempSync, realpathSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import {backup, DatabaseSync} from "node:sqlite";
import {buildApp} from "../app.js";
import {createRuntime} from "../bootstrap.js";
import {loadConfig} from "../config.js";
import {inspectSqliteBackup} from "./sqlite-backup-verifier.js";

const criticalKinds = [
  "order", "payment_attempt", "fulfillment", "cdk_voucher", "refund", "ledger", "settlement", "outbox",
  "webhook_delivery", "ops_wallet_entry", "ops_wallet_deposit", "ops_wallet_withdrawal", "ops_wallet_credit",
  "ops_daily_settlement", "ops_invoice_application", "ops_invoice_fee_payment", "ops_invoice_payment_reconciliation",
  "ops_order_cost", "ops_cost_saving_payment", "ops_payment_event", "ops_crypto_payment", "ops_crypto_transaction",
] as const;

const allowedStartupMutationKinds = new Set([
  "merchant", "partner_app", "api_key", "product_grant", "supplier_connection", "supplier_mapping",
  "ops_global_product_catalog", "ops_api_access", "ops_agent_profile", "ops_tier_rules", "ops_service_checkpoint",
  "ops_ticket", "ops_ticket_message", "ops_operational_issue", "ops_refund_reconciliation",
  "ops_refund_reconciliation_event",
]);

export interface ProductionSnapshotRehearsalReport {
  status: "ok";
  snapshotFile: string;
  verifiedAt: string;
  snapshotSha256: string;
  criticalRecordCount: number;
  criticalKindCounts: Record<string, number>;
  criticalDigestUnchanged: true;
  sourceSnapshotUnchanged: true;
  startupRoutes: {ready: 200; developers: 200; openapi: 200};
  changedKinds: string[];
  productionWrites: false;
  runtimeMode: {nodeEnv: "production"; executionMode: "production"; storageDriver: "sqlite"};
}

/** Start candidate code only against a temporary restore of a self-contained snapshot. */
export async function rehearseProductionSnapshot(
  snapshotPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProductionSnapshotRehearsalReport> {
  if (environment.AUDIT_ISOLATED_SNAPSHOT !== "true") throw new Error("isolated_snapshot_required");
  // A test/memory runtime can start successfully without ever opening the
  // restored ledger. Never present that as production migration evidence.
  if (environment.NODE_ENV !== "production" || environment.EXECUTION_MODE !== "production"
      || environment.STORAGE_DRIVER !== "sqlite") throw new Error("snapshot_production_sqlite_required");
  const source = requireSnapshot(snapshotPath);
  assertNotConfiguredLiveDatabase(source, environment.SQLITE_PATH);
  const sourceBefore = await inspectSqliteBackup(source);
  const folder = mkdtempSync(join(tmpdir(), "quefa-production-rehearsal-"));
  const restoredPath = join(folder, "candidate.sqlite");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const input = new DatabaseSync(source, {readOnly: true});
    try {
      input.exec("PRAGMA query_only=ON;");
      await backup(input, restoredPath, {rate: 128});
    } finally {
      input.close();
    }
    const restoredBefore = await inspectSqliteBackup(restoredPath);
    if (restoredBefore.logicalSha256 !== sourceBefore.logicalSha256) throw new Error("snapshot_restore_logical_mismatch");
    const criticalBefore = recordDigest(restoredPath, new Set(criticalKinds));
    const kindsBefore = perKindDigests(restoredPath);
    const config = loadConfig({...environment, SQLITE_PATH: restoredPath, BACKUP_HEALTH_REPORT_PATH: ""});
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
    const [ready, developers, openapi] = await Promise.all([
      app.inject({method: "GET", url: "/health/ready"}),
      app.inject({method: "GET", url: "/developers"}),
      app.inject({method: "GET", url: "/developers/openapi.yaml"}),
    ]);
    if (ready.statusCode !== 200) throw new Error(`snapshot_ready_failed:${ready.statusCode}`);
    if (developers.statusCode !== 200) throw new Error(`snapshot_developers_failed:${developers.statusCode}`);
    if (openapi.statusCode !== 200) throw new Error(`snapshot_openapi_failed:${openapi.statusCode}`);
    await app.close(); app = undefined;
    runtime.close(); runtime = undefined;

    const criticalAfter = recordDigest(restoredPath, new Set(criticalKinds));
    if (criticalAfter.digest !== criticalBefore.digest || criticalAfter.count !== criticalBefore.count
        || JSON.stringify(criticalAfter.kindCounts) !== JSON.stringify(criticalBefore.kindCounts)) {
      throw new Error("snapshot_startup_changed_critical_records");
    }
    const kindsAfter = perKindDigests(restoredPath);
    const changedKinds = [...new Set([...kindsBefore.keys(), ...kindsAfter.keys()])]
      .filter(kind => kindsBefore.get(kind) !== kindsAfter.get(kind)).sort();
    const unexpected = changedKinds.filter(kind => !allowedStartupMutationKinds.has(kind));
    if (unexpected.length) throw new Error(`snapshot_unexpected_startup_mutation:${unexpected.join(",")}`);
    await inspectSqliteBackup(restoredPath);
    const sourceAfter = await inspectSqliteBackup(source);
    if (sourceAfter.fileSha256 !== sourceBefore.fileSha256 || sourceAfter.logicalSha256 !== sourceBefore.logicalSha256) {
      throw new Error("source_snapshot_was_modified");
    }
    return {
      status: "ok", snapshotFile: basename(source), verifiedAt: new Date().toISOString(), snapshotSha256: sourceBefore.fileSha256,
      criticalRecordCount: criticalBefore.count, criticalKindCounts: criticalBefore.kindCounts,
      criticalDigestUnchanged: true, sourceSnapshotUnchanged: true,
      startupRoutes: {ready: 200, developers: 200, openapi: 200}, changedKinds, productionWrites: false,
      runtimeMode: {nodeEnv: "production", executionMode: "production", storageDriver: "sqlite"},
    };
  } finally {
    if (app) await app.close();
    runtime?.close();
    let cleanupError: unknown;
    try {
      const sourceAfter = await inspectSqliteBackup(source);
      if (sourceAfter.fileSha256 !== sourceBefore.fileSha256 || sourceAfter.logicalSha256 !== sourceBefore.logicalSha256) {
        cleanupError = new Error("source_snapshot_was_modified");
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      rmSync(folder, {recursive: true, force: true});
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }
}

function recordDigest(path: string, kinds: ReadonlySet<string>) {
  const db = new DatabaseSync(path, {readOnly: true}), hash = createHash("sha256"), kindCounts: Record<string, number> = {};
  let count = 0;
  try {
    db.exec("PRAGMA query_only=ON;");
    for (const row of db.prepare("SELECT kind,id,merchant_id,unique_key,payload,updated_at FROM sandbox_records ORDER BY kind,id").iterate()) {
      const kind = String(row.kind);
      if (!kinds.has(kind)) continue;
      hashParts(hash, kind, row.id, row.merchant_id, row.unique_key, row.payload, row.updated_at);
      kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
      count++;
    }
  } finally { db.close(); }
  return {digest: hash.digest("hex"), count, kindCounts: sortedRecord(kindCounts)};
}

function perKindDigests(path: string): Map<string, string> {
  const db = new DatabaseSync(path, {readOnly: true}), hashes = new Map<string, ReturnType<typeof createHash>>();
  try {
    db.exec("PRAGMA query_only=ON;");
    for (const row of db.prepare("SELECT kind,id,merchant_id,unique_key,payload,updated_at FROM sandbox_records ORDER BY kind,id").iterate()) {
      const kind = String(row.kind), hash = hashes.get(kind) ?? createHash("sha256");
      hashParts(hash, row.id, row.merchant_id, row.unique_key, row.payload, row.updated_at); hashes.set(kind, hash);
    }
  } finally { db.close(); }
  return new Map([...hashes].map(([kind, hash]) => [kind, hash.digest("hex")]));
}

function hashParts(hash: ReturnType<typeof createHash>, ...values: unknown[]): void {
  for (const value of values) {
    const bytes = Buffer.from(value === null ? "<null>" : String(value), "utf8");
    hash.update(String(bytes.length)); hash.update(":"); hash.update(bytes); hash.update(";");
  }
}

function requireSnapshot(path: string): string {
  if (!path || path === ":memory:") throw new Error("snapshot_path_required");
  const resolved = realpathSync(path), stat = statSync(resolved);
  if (!stat.isFile() || stat.size <= 0) throw new Error("snapshot_file_empty");
  return resolved;
}

function assertNotConfiguredLiveDatabase(snapshot: string, configuredPath: string | undefined): void {
  if (!configuredPath || configuredPath === ":memory:") return;
  const configured = resolve(configuredPath);
  if (!existsSync(configured)) return;
  const live = realpathSync(configured), sourceStat = statSync(snapshot), liveStat = statSync(live);
  if (snapshot === live || (sourceStat.dev === liveStat.dev && sourceStat.ino === liveStat.ino)) {
    throw new Error("live_database_snapshot_forbidden");
  }
}

function sortedRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
