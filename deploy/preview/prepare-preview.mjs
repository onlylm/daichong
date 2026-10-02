import {createHash, randomBytes} from "node:crypto";
import {chmodSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {backup, DatabaseSync} from "node:sqlite";
import {fileURLToPath, pathToFileURL} from "node:url";

const removedKinds = new Set([
  "ops_account", "ops_session", "ops_mfa_challenge", "ops_login_throttle", "merchant_user", "merchant_role",
  "idempotency", "api_key", "partner_app", "webhook_endpoint", "outbox", "webhook_delivery",
  "ops_worker_health", "ops_service_checkpoint", "ops_payment_settings", "ops_payment_revision", "ops_payment_check",
  "supplier_connection", "supplier_webhook_event",
]);
const financeKinds = new Set([
  "order", "payment_attempt", "refund", "ledger", "settlement", "ops_wallet_entry", "ops_wallet_deposit",
  "ops_wallet_withdrawal", "ops_wallet_credit", "ops_daily_settlement", "ops_order_cost", "ops_cost_saving_payment",
  "ops_invoice_application", "ops_invoice_fee_payment", "ops_invoice_payment_reconciliation",
  "ops_refund_reconciliation", "ops_refund_reconciliation_event", "ops_crypto_payment", "ops_crypto_transaction", "ops_payment_event",
]);
const obsoleteLink = /(?:qr_?payload|qr_?image_?url|(?:pay|payment|fulfillment|recharge|redeem|notify|callback|return|redirect)_?url)$/i;
const secretField = /(?:secret|password|(?:access|refresh|lookup|lease|portal|csrf)_?token|api_?key)$/i;

/** No server/Worker is started. Only an exclusively published, scrubbed restore is returned. */
export async function preparePreview(inputPath, outputPath, environment = process.env, suppliedModules) {
  assertEnvironment(environment, outputPath);
  const source = requireSource(inputPath), output = requireOutput(outputPath, source);
  const sourceBefore = fileHash(source);
  let sourceDb;
  let stagingDir;
  let stage;
  let runtime;
  let report;
  try {
    stagingDir = mkdtempSync(join(dirname(output), ".isolated-preview-"));
    chmodSync(stagingDir, 0o700);
    // A self-contained backup may retain a WAL journal-mode header. Even a
    // readOnly SQLite connection can need writable -wal/-shm sidecars, which a
    // single-file read-only container mount cannot provide. Never open the
    // mounted source with SQLite: read its bytes into our private writable
    // staging directory first; all SQLite sidecars stay confined to that copy.
    const stagedInput = join(stagingDir, "input.sqlite");
    copyFileSync(source, stagedInput, constants.COPYFILE_EXCL);
    chmodSync(stagedInput, 0o600);
    if (fileHash(stagedInput) !== sourceBefore) throw new Error("preview_source_copy_changed");
    sourceDb = new DatabaseSync(stagedInput, {readOnly: true});
    sourceDb.exec("PRAGMA query_only=ON;");
    assertDatabase(sourceDb);
    const financeBefore = financialSummary(sourceDb);
    stage = join(stagingDir, "preview.sqlite");
    await backup(sourceDb, stage, {rate: 128});
    sourceDb.close(); sourceDb = undefined;
    chmodSync(stage, 0o600);
    const counts = sanitizeDatabase(stage);
    const appRoot = resolve(environment.APP_ROOT || fileURLToPath(new URL("../..", import.meta.url)));
    const modules = suppliedModules ?? {...await import(pathToFileURL(join(appRoot, "dist/config.js")).href),
      ...await import(pathToFileURL(join(appRoot, "dist/bootstrap.js")).href)};
    // Never inherit any production supplier/payment secret or destination. The seed
    // encrypts empty supplier credentials with the preview-only key and stays disabled.
    const config = modules.loadConfig({...environment, SQLITE_PATH: stage, REGISTRATION_ENABLED: "false", LIVE_TEST_ENABLED: "false",
      BACKUP_HEALTH_REPORT_PATH: "", ZOVOCARD_API_KEY: "", ZOVOCARD_WEBHOOK_SECRET: "", ZOVOCARD_CARD_ID: "",
      ZOVOCARD_API_BASE: "https://supplier.invalid/openapi/v1", ZOVOCARD_CDK_BASE: "https://supplier.invalid/api/v1/cdk",
      SUPPLIER_ALLOWED_HOSTS: "supplier.invalid", ALIPAY_APP_ID: "", ALIPAY_SELLER_ID: "", ALIPAY_PRIVATE_KEY_PATH: "",
      ALIPAY_PUBLIC_KEY_PATH: "", DEMO_WEBHOOK_URL: ""});
    runtime = modules.createRuntime(config);
    const account = await runtime.accounts.bootstrap(environment.PREVIEW_ADMIN_USERNAME, environment.PREVIEW_ADMIN_PASSWORD);
    runtime.repository.saveOperations("account", {...account, displayName: "隔离验收管理员"});
    runtime.close(); runtime = undefined;
    const db = new DatabaseSync(stage);
    try {
      // Development seed creates demo API identities. Do not publish these identities
      // or any real callback; only the newly bootstrapped workspace admin may log in.
      db.exec("BEGIN IMMEDIATE;");
      for (const kind of ["api_key", "partner_app", "webhook_endpoint", "outbox", "webhook_delivery"]) {
        counts.seededIdentitiesRemoved += Number(db.prepare("DELETE FROM sandbox_records WHERE kind=?").run(kind).changes);
      }
      db.exec("UPDATE sandbox_records SET payload=json_set(payload,'$.enabled',json('false')) WHERE kind='ops_api_access';");
      db.exec("COMMIT;");
      const financeAfter = financialSummary(db);
      if (JSON.stringify(financeBefore) !== JSON.stringify(financeAfter)) throw new Error("preview_financial_summary_changed");
      assertDatabase(db);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; VACUUM;");
      report = {status: "ok", isolated: true, sourceUnchanged: true, financialSummaryUnchanged: true,
        sourceSha256: sourceBefore, financialSummary: financeAfter, cleanup: counts,
        previewAdmin: {username: account.username, displayName: "隔离验收管理员"},
        credentials: "old_removed_preview_only", supplier: "disabled_empty_credentials", workerStarted: false,
        executionMode: "disabled", paymentProvider: "mock", fulfillmentProvider: "mock"};
    } finally { db.close(); }
    if (fileHash(source) !== sourceBefore) throw new Error("preview_source_modified");
    // link() is exclusive, including a symlink/dangling symlink created during work.
    // Check ancestors again and never use an overwriting rename/copy operation.
    requireOutput(output, source);
    linkSync(stage, output);
    report.previewSha256 = fileHash(output);
    return report;
  } finally {
    runtime?.close();
    sourceDb?.close();
    // This is only the exact private directory created above, never an input/output root.
    if (stagingDir) rmSync(stagingDir, {recursive: true, force: true});
    if (fileHash(source) !== sourceBefore) throw new Error("preview_source_modified");
  }
}

function assertEnvironment(env, output) {
  if (env.ISOLATED_PREVIEW !== "true") throw new Error("preview_explicit_isolation_required");
  if (env.NODE_ENV !== "development" || env.EXECUTION_MODE !== "disabled" || env.PAYMENT_PROVIDER !== "mock"
      || env.FULFILLMENT_PROVIDER !== "mock" || env.ENABLE_SANDBOX_ROUTES !== "false" || env.STORAGE_DRIVER !== "sqlite") {
    throw new Error("preview_mock_disabled_sqlite_required");
  }
  if (!output || !env.SQLITE_PATH || resolve(output) !== resolve(env.SQLITE_PATH)) throw new Error("preview_sqlite_path_mismatch");
  const key = Buffer.from(env.DATA_ENCRYPTION_KEY || "", "base64");
  if (key.length !== 32 || key.equals(Buffer.alloc(32)) || !env.PORTAL_TOKEN_SECRET || env.PORTAL_TOKEN_SECRET.length < 32
      || env.PORTAL_TOKEN_SECRET.startsWith("replace-") || !env.DEMO_CLIENT_SECRET || env.DEMO_CLIENT_SECRET.length < 32
      || env.DEMO_CLIENT_SECRET.startsWith("replace-") || !env.PLATFORM_ADMIN_TOKEN || env.PLATFORM_ADMIN_TOKEN.length < 32
      || env.PLATFORM_ADMIN_TOKEN.startsWith("replace-")) throw new Error("preview_fresh_environment_keys_required");
  if (!/^[a-zA-Z0-9_@.-]{3,80}$/.test(env.PREVIEW_ADMIN_USERNAME || "") || !env.PREVIEW_ADMIN_PASSWORD
      || env.PREVIEW_ADMIN_PASSWORD.length < 15) throw new Error("preview_admin_credentials_required");
}

function noSymlinkAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("preview_symlink_forbidden"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
}
function requireSource(path) {
  if (!path || path === ":memory:") throw new Error("preview_backup_required");
  noSymlinkAncestors(path);
  const source = realpathSync(path), info = statSync(source);
  if (!info.isFile() || info.size < 100 || readFileSync(source).subarray(0, 16).toString() !== "SQLite format 3\0") {
    throw new Error("preview_sqlite_backup_required");
  }
  // A self-contained online backup must not depend on an uncheckpointed live WAL.
  for (const suffix of ["-wal", "-shm", "-journal"]) if (existsSync(source + suffix)) throw new Error("preview_self_contained_backup_required");
  return source;
}
function requireOutput(path, source) {
  const output = resolve(path);
  if (output === resolve(source)) throw new Error("preview_source_output_conflict");
  if (basename(output) !== "preview.sqlite") throw new Error("preview_output_name_required");
  noSymlinkAncestors(output);
  if (!statSync(dirname(output)).isDirectory()) throw new Error("preview_output_directory_required");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { lstatSync(output + suffix); throw new Error("preview_output_exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return output;
}
function assertDatabase(db) {
  const rows = db.prepare("PRAGMA integrity_check;").all();
  if (rows.length !== 1 || rows[0].integrity_check !== "ok") throw new Error("preview_integrity_failed");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  if (!["sandbox_records", "request_nonces"].every(name => tables.includes(name))) throw new Error("preview_schema_missing");
  if (db.prepare("PRAGMA foreign_key_check;").all().length || Number(db.prepare("SELECT count(*) AS count FROM sandbox_records WHERE NOT json_valid(payload)").get().count)) {
    throw new Error("preview_invalid_records");
  }
}
function financialSummary(db) {
  const hash = createHash("sha256"), counts = {};
  const financialFields = value => {
    if (value === null || typeof value !== "object") return undefined;
    if (Array.isArray(value)) return value.map(financialFields);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (/(?:Minor|Delta)$|^(?:currency|fxRate|feeRateBps|payableAmount|settledAmount|status|paymentStatus)$/.test(key)) result[key] = value[key];
      else { const nested = financialFields(value[key]); if (nested && Object.keys(nested).length) result[key] = nested; }
    }
    return result;
  };
  for (const row of db.prepare("SELECT kind,id,merchant_id,payload FROM sandbox_records ORDER BY kind,id").iterate()) {
    if (!financeKinds.has(row.kind)) continue;
    counts[row.kind] = (counts[row.kind] || 0) + 1;
    hash.update(JSON.stringify([row.kind, row.id, row.merchant_id, financialFields(JSON.parse(row.payload))]) + "\n");
  }
  return {recordCounts: counts, sha256: hash.digest("hex")};
}
function sanitizeDatabase(path) {
  const db = new DatabaseSync(path), now = new Date().toISOString();
  const counts = {deletedRecords: 0, encryptedPayloadsCleared: 0, linksCleared: 0, secretsCleared: 0,
    publicCodesReplaced: 0, recordsSanitized: 0, noncesCleared: 0, seededIdentitiesRemoved: 0};
  try {
    db.exec("PRAGMA secure_delete=ON; BEGIN IMMEDIATE;");
    for (const kind of removedKinds) counts.deletedRecords += Number(db.prepare("DELETE FROM sandbox_records WHERE kind=?").run(kind).changes);
    counts.noncesCleared = Number(db.prepare("DELETE FROM request_nonces").run().changes);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='request_rate_limits'").get()) db.exec("DELETE FROM request_rate_limits;");
    const rows = db.prepare("SELECT kind,id,payload FROM sandbox_records ORDER BY kind,id").all(), codes = new Map();
    for (const row of rows) {
      const value = JSON.parse(row.payload), code = row.kind === "cdk_voucher" ? value.publicCode : row.kind === "order" ? value.voucherCode : null;
      if (typeof code === "string" && code && !codes.has(code)) codes.set(code, "PREVIEW-" + randomBytes(24).toString("hex").toUpperCase());
    }
    counts.publicCodesReplaced = codes.size;
    const scrub = (value, key = "") => {
      if (value && typeof value === "object" && ["ciphertext", "iv", "authTag", "keyVersion"].every(field => Object.hasOwn(value, field))) {
        counts.encryptedPayloadsCleared++;
        return {ciphertext: null, iv: null, authTag: null, keyVersion: "preview-cleared", clearedAt: now};
      }
      if (obsoleteLink.test(key) || /(?:url|uri)$/i.test(key)) { if (value) counts.linksCleared++; return key === "fulfillmentUrl" ? "" : null; }
      if (secretField.test(key)) { if (value) counts.secretsCleared++; return null; }
      if (Array.isArray(value)) return value.map(item => scrub(item));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, scrub(item, field)]));
      if (typeof value !== "string") return value;
      let result = value;
      for (const [oldCode, newCode] of codes) result = result.split(oldCode).join(newCode);
      return result.replace(/(?:https?:\/\/|alipays?:\/\/|javascript:|data:|intent:\/\/)[^\s<>"']+/gi,
        () => { counts.linksCleared++; return "[隔离链接已移除]"; });
    };
    for (const row of rows) {
      const payload = JSON.stringify(scrub(JSON.parse(row.payload)));
      if (payload !== row.payload) { db.prepare("UPDATE sandbox_records SET payload=? WHERE kind=? AND id=?").run(payload, row.kind, row.id); counts.recordsSanitized++; }
    }
    db.exec("COMMIT;");
    return counts;
  } finally { db.close(); }
}
function fileHash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("preview_usage_source_and_output_required");
    const report = await preparePreview(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    // No raw config, paths, password, payload or stack may be printed.
    const message = /^preview_[a-z_]+$/.test(error.message) ? error.message : "preview_preparation_failed";
    const code = /^[A-Z0-9_]{1,48}$/.test(error.code || "") ? error.code : "unknown";
    const sqlite = Number.isSafeInteger(error.errcode) ? String(error.errcode) : "unknown";
    process.stderr.write(message + " code=" + code + " sqlite=" + sqlite + "\n");
    process.exitCode = 1;
  }
}
