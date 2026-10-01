import {chmodSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {verifySqliteBackupRestore} from "../infra/sqlite-backup-verifier.js";

const args = process.argv.slice(2);
const backupPath = args.find(value => !value.startsWith("--")) ?? process.env.SQLITE_BACKUP_PATH ?? "";
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;

if (!backupPath) throw new Error("用法：verify-sqlite-backup <backup.sqlite> [--report <report.json>]");
if (reportIndex >= 0 && !reportPath) throw new Error("--report 缺少输出路径");

const report = await verifySqliteBackupRestore(resolve(backupPath));
const output = JSON.stringify(report, null, 2) + "\n";
if (reportPath) {
  const target = resolve(reportPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, output, {encoding: "utf8", mode: 0o600});
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, {force: true});
  }
}
process.stdout.write(output);
