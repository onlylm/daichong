import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {inspectSqliteBackup, verifySqliteBackupRestore} from "../src/infra/sqlite-backup-verifier.js";

describe("SQLite backup restore rehearsal", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true});
  });

  it("restores an isolated copy and verifies schema, logical contents, JSON and counts", async () => {
    const folder=mkdtempSync(join(tmpdir(),"quefa-backup-test-"));folders.push(folder);
    const source=join(folder,"source.sqlite"),snapshot=join(folder,"snapshot.sqlite");
    const runtime=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:source,LOG_LEVEL:"silent"}));
    runtime.repository.consumeNonce("backup-test-nonce",Date.now()+60_000,Date.now());
    runtime.close();
    copyFileSync(source,snapshot);

    const before=await inspectSqliteBackup(snapshot);
    const report=await verifySqliteBackupRestore(snapshot,folder);
    const after=await inspectSqliteBackup(snapshot);

    expect(report).toMatchObject({status:"ok",backupFile:"snapshot.sqlite"});
    expect(report.transferredPages).toBeGreaterThan(0);
    expect(report.inspection.integrity).toBe("ok");
    expect(report.inspection.recordCount).toBeGreaterThan(0);
    expect(report.inspection.nonceCount).toBe(1);
    expect(report.inspection.kindCounts.merchant).toBeGreaterThan(0);
    expect(after.fileSha256).toBe(before.fileSha256);
    expect(after.logicalSha256).toBe(before.logicalSha256);

    const cliReport=join(folder,"cli-report.json");
    const cli=spawnSync(process.execPath,["--import","tsx","src/cli/verify-sqlite-backup.ts",snapshot,"--report",cliReport],
      {cwd:process.cwd(),encoding:"utf8"});
    expect(cli.status,cli.stderr).toBe(0);
    expect(JSON.parse(readFileSync(cliReport,"utf8"))).toMatchObject({status:"ok",backupFile:"snapshot.sqlite"});

    const reportFirst=join(folder,"cli-report-first.json");
    const reordered=spawnSync(process.execPath,["--import","tsx","src/cli/verify-sqlite-backup.ts","--report",reportFirst,snapshot],
      {cwd:process.cwd(),encoding:"utf8"});
    expect(reordered.status,reordered.stderr).toBe(0);
    expect(JSON.parse(readFileSync(reportFirst,"utf8"))).toMatchObject({status:"ok",backupFile:"snapshot.sqlite"});
  });

  it("rejects a report path that aliases the backup and preserves every input byte",()=>{
    const folder=mkdtempSync(join(tmpdir(),"quefa-backup-conflict-"));folders.push(folder);
    const source=join(folder,"source.sqlite"),snapshot=join(folder,"snapshot.sqlite");
    const runtime=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:source,LOG_LEVEL:"silent"}));
    runtime.repository.consumeNonce("conflict-test-nonce",Date.now()+60_000,Date.now());
    runtime.close();copyFileSync(source,snapshot);
    const before=readFileSync(snapshot);

    const cli=spawnSync(process.execPath,["--import","tsx","src/cli/verify-sqlite-backup.ts","--report",snapshot,snapshot],
      {cwd:process.cwd(),encoding:"utf8"});

    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain("sqlite_backup_report_path_conflict");
    expect(readFileSync(snapshot)).toEqual(before);
  });

  it("rejects a truncated backup instead of producing a successful report", async () => {
    const folder=mkdtempSync(join(tmpdir(),"quefa-backup-corrupt-"));folders.push(folder);
    const source=join(folder,"source.sqlite"),snapshot=join(folder,"truncated.sqlite");
    const runtime=createRuntime(loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:source,LOG_LEVEL:"silent"}));
    runtime.close();
    const bytes=readFileSync(source);
    writeFileSync(snapshot,bytes.subarray(0,Math.min(512,bytes.length)));

    await expect(verifySqliteBackupRestore(snapshot,folder)).rejects.toThrow();
  });
});
