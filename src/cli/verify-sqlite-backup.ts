import {chmodSync, existsSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {verifySqliteBackupRestore} from "../infra/sqlite-backup-verifier.js";

const {backupPath,reportPath}=parseArguments(process.argv.slice(2));

if (!backupPath) throw new Error("用法：verify-sqlite-backup <backup.sqlite> [--report <report.json>]");
const resolvedBackup=realpathSync(resolve(backupPath));
const resolvedReport=reportPath?resolveOutputPath(reportPath):undefined;
if(resolvedReport)assertDistinctFiles(resolvedBackup,resolvedReport);

const report = await verifySqliteBackupRestore(resolvedBackup);
const output = JSON.stringify(report, null, 2) + "\n";
if (resolvedReport) {
  const target = resolvedReport;
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

function parseArguments(args:string[]):{backupPath:string;reportPath?:string}{
  let positional:string|undefined,reportPath:string|undefined;
  for(let index=0;index<args.length;index+=1){
    const value=args[index]!;
    if(value==="--report"){
      if(reportPath!==undefined)throw new Error("--report 只能指定一次");
      const next=args[index+1];
      if(!next||next.startsWith("--"))throw new Error("--report 缺少输出路径");
      reportPath=next;index+=1;continue;
    }
    if(value.startsWith("--"))throw new Error(`未知参数：${value}`);
    if(positional!==undefined)throw new Error("只能指定一个 SQLite 备份路径");
    positional=value;
  }
  return {backupPath:positional??process.env.SQLITE_BACKUP_PATH??"",...(reportPath!==undefined?{reportPath}:{})};
}

/** Resolve symlinked parents even when the output file does not exist yet. */
function resolveOutputPath(path:string):string{
  const target=resolve(path);
  return existsSync(target)?realpathSync(target):join(realpathSync(dirname(target)),basename(target));
}

function assertDistinctFiles(backupPath:string,reportPath:string):void{
  const normalize=(value:string)=>process.platform==="win32"?value.toLowerCase():value;
  if(normalize(backupPath)===normalize(reportPath))throw new Error("sqlite_backup_report_path_conflict");
  if(existsSync(reportPath)){
    const backup=statSync(backupPath),report=statSync(reportPath);
    if(backup.dev===report.dev&&backup.ino===report.ino)throw new Error("sqlite_backup_report_path_conflict");
  }
}
