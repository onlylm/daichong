import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {loadConfig} from "../src/config.js";
import {readBackupRestoreCheck} from "../src/operations/backup-health.js";

describe("backup restore health summary", () => {
  const folders: string[] = [];
  afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true}); });

  it("derives the protected health report beside a persistent SQLite ledger", () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: "/app/data/production.sqlite"});
    expect(config.backupHealthReportPath).toBe(join("/app/data", "sqlite-restore-health.json"));
    expect(config.backupRestoreMaxAgeMs).toBe(192 * 60 * 60 * 1000);
    expect(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:"}).backupHealthReportPath).toBeNull();
  });

  it("distinguishes missing, verified, stale, failed and invalid reports", () => {
    const folder = mkdtempSync(join(tmpdir(), "quefa-backup-health-")); folders.push(folder);
    const path = join(folder, "health.json"), now = new Date("2026-10-01T12:00:00.000Z"), hash = "a".repeat(64);
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({status: "undetected", label: "未检测"});

    const report = {status: "ok", verifiedAt: "2026-09-30T12:00:00.000Z", transferredPages: 4,
      inspection: {integrity: "ok", recordCount: 20, schemaSha256: hash, logicalSha256: hash}};
    writeFileSync(path, JSON.stringify(report));
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({
      status: "healthy", label: "备份恢复已验证", checkedAt: report.verifiedAt, scope: "restore_rehearsal",
    });
    expect(readBackupRestoreCheck(path, 12 * 60 * 60 * 1000, now)).toMatchObject({status: "degraded", label: "恢复演练已过期"});

    writeFileSync(path, JSON.stringify({status: "failed", checkedAt: "2026-10-01T11:00:00Z", failureCode: "restore_verification_failed"}));
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({status: "failed", label: "恢复演练失败"});
    writeFileSync(path, "not-json");
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({status: "failed", label: "恢复报告不可用"});
  });

  it("rejects forged success summaries and future timestamps", () => {
    const folder = mkdtempSync(join(tmpdir(), "quefa-backup-health-invalid-")); folders.push(folder);
    const path = join(folder, "health.json"), hash = "b".repeat(64), now = new Date("2026-10-01T12:00:00.000Z");
    writeFileSync(path, JSON.stringify({status: "ok", verifiedAt: "2026-10-01T13:00:00.000Z", transferredPages: 1,
      inspection: {integrity: "ok", recordCount: 0, schemaSha256: hash, logicalSha256: hash}}));
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({status: "failed", label: "恢复报告时间异常"});
    writeFileSync(path, JSON.stringify({status: "ok", verifiedAt: "2026-10-01T11:00:00.000Z", transferredPages: 0,
      inspection: {integrity: "ok", recordCount: 0, schemaSha256: hash, logicalSha256: hash}}));
    expect(readBackupRestoreCheck(path, 8 * 24 * 60 * 60 * 1000, now)).toMatchObject({status: "failed", label: "恢复报告无效"});
  });
});
