import {createHash} from "node:crypto";
import {createReadStream, mkdtempSync, realpathSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {backup, DatabaseSync} from "node:sqlite";

export interface SqliteBackupInspection {
  fileBytes: number;
  fileSha256: string;
  integrity: "ok";
  tableNames: string[];
  schemaSha256: string;
  logicalSha256: string;
  recordCount: number;
  nonceCount: number;
  kindCounts: Record<string, number>;
}

export interface SqliteRestoreVerification {
  status: "ok";
  backupFile: string;
  verifiedAt: string;
  transferredPages: number;
  inspection: SqliteBackupInspection;
}

const requiredTables = ["request_nonces", "sandbox_records"];

/** Inspect a self-contained backup without opening the application repository or running migrations. */
export async function inspectSqliteBackup(path: string): Promise<SqliteBackupInspection> {
  const resolved = requireBackupFile(path);
  const db = new DatabaseSync(resolved, {readOnly: true});
  try {
    db.exec("PRAGMA query_only=ON;");
    const integrityRows = db.prepare("PRAGMA integrity_check;").all();
    const integrity = integrityRows.map(row => String(row.integrity_check ?? "")).filter(Boolean);
    if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error(`sqlite_integrity_failed:${integrity.join("|")}`);
    const foreignKeyRows = db.prepare("PRAGMA foreign_key_check;").all();
    if (foreignKeyRows.length) throw new Error(`sqlite_foreign_key_check_failed:${foreignKeyRows.length}`);

    const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(row => String(row.name));
    for (const table of requiredTables) if (!tableNames.includes(table)) throw new Error(`sqlite_required_table_missing:${table}`);

    const invalidJson = Number(db.prepare("SELECT COUNT(*) AS total FROM sandbox_records WHERE json_valid(payload)=0").get()!.total);
    if (invalidJson) throw new Error(`sqlite_invalid_json_payloads:${invalidJson}`);

    const recordCount = Number(db.prepare("SELECT COUNT(*) AS total FROM sandbox_records").get()!.total);
    const nonceCount = Number(db.prepare("SELECT COUNT(*) AS total FROM request_nonces").get()!.total);
    const kindCounts: Record<string, number> = {};
    for (const row of db.prepare("SELECT kind,COUNT(*) AS total FROM sandbox_records GROUP BY kind ORDER BY kind").iterate()) {
      kindCounts[String(row.kind)] = Number(row.total);
    }

    const schemaHash = createHash("sha256");
    for (const row of db.prepare("SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").iterate()) {
      hashParts(schemaHash, row.type, row.name, row.tbl_name, row.sql);
    }
    const logicalHash = createHash("sha256");
    for (const row of db.prepare("SELECT kind,id,merchant_id,unique_key,payload,updated_at FROM sandbox_records ORDER BY kind,id").iterate()) {
      hashParts(logicalHash, "record", row.kind, row.id, row.merchant_id, row.unique_key, row.payload, row.updated_at);
    }
    for (const row of db.prepare("SELECT nonce_key,expires_at FROM request_nonces ORDER BY nonce_key").iterate()) {
      hashParts(logicalHash, "nonce", row.nonce_key, row.expires_at);
    }

    return {
      fileBytes: statSync(resolved).size,
      fileSha256: await hashFile(resolved),
      integrity: "ok",
      tableNames,
      schemaSha256: schemaHash.digest("hex"),
      logicalSha256: logicalHash.digest("hex"),
      recordCount,
      nonceCount,
      kindCounts,
    };
  } finally {
    db.close();
  }
}

/**
 * Restore one backup into an isolated temporary database and compare its full
 * logical contents with the backup. The input file is opened read-only and is
 * never used as an application database.
 */
export async function verifySqliteBackupRestore(path: string, temporaryRoot = tmpdir()): Promise<SqliteRestoreVerification> {
  const resolved = requireBackupFile(path);
  const before = await inspectSqliteBackup(resolved);
  const folder = mkdtempSync(join(temporaryRoot, "quefa-sqlite-restore-"));
  const restoredPath = join(folder, "restored.sqlite");
  let transferredPages = 0;
  try {
    const source = new DatabaseSync(resolved, {readOnly: true});
    try {
      source.exec("PRAGMA query_only=ON;");
      transferredPages = await backup(source, restoredPath, {rate: 128});
    } finally {
      source.close();
    }
    const restored = await inspectSqliteBackup(restoredPath);
    assertEqual("schema", before.schemaSha256, restored.schemaSha256);
    assertEqual("logical", before.logicalSha256, restored.logicalSha256);
    assertEqual("record_count", before.recordCount, restored.recordCount);
    assertEqual("nonce_count", before.nonceCount, restored.nonceCount);
    assertEqual("kind_counts", JSON.stringify(before.kindCounts), JSON.stringify(restored.kindCounts));
    return {
      status: "ok",
      backupFile: basename(resolved),
      verifiedAt: new Date().toISOString(),
      transferredPages,
      inspection: before,
    };
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
}

function requireBackupFile(path: string): string {
  if (!path || path === ":memory:") throw new Error("sqlite_backup_path_required");
  const resolved = realpathSync(path);
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size <= 0) throw new Error("sqlite_backup_file_empty");
  return resolved;
}

function hashParts(hash: ReturnType<typeof createHash>, ...values: unknown[]): void {
  for (const value of values) {
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value === null ? "<null>" : String(value), "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update(";");
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", chunk => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function assertEqual(label: string, expected: string | number, actual: string | number): void {
  if (expected !== actual) throw new Error(`sqlite_restore_${label}_mismatch`);
}
