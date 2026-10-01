import {readFileSync, statSync} from "node:fs";

export interface BackupRestoreCheck {
  status: "undetected" | "degraded" | "failed" | "healthy";
  label: string;
  checkedAt: string | null;
  scope: "restore_rehearsal";
}

const undetected: BackupRestoreCheck = {
  status: "undetected", label: "未检测", checkedAt: null, scope: "restore_rehearsal",
};

/** Read only the sanitized result produced by the isolated restore rehearsal. */
export function readBackupRestoreCheck(path: string | null, maxAgeMs: number, now = new Date()): BackupRestoreCheck {
  if (!path) return {...undetected};
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024) return invalid("恢复报告无效", null);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value.status === "failed") return invalid("恢复演练失败", validTime(value.checkedAt));
    const checkedAt = validTime(value.verifiedAt);
    const inspection = object(value.inspection);
    const trustworthy = value.status === "ok" && checkedAt !== null && positiveInteger(value.transferredPages)
      && inspection.integrity === "ok" && nonnegativeInteger(inspection.recordCount)
      && sha256(inspection.schemaSha256) && sha256(inspection.logicalSha256);
    if (!trustworthy) return invalid("恢复报告无效", checkedAt);
    const checkedTime = Date.parse(checkedAt);
    if (checkedTime > now.getTime() + 5 * 60_000) return invalid("恢复报告时间异常", checkedAt);
    if (now.getTime() - checkedTime > maxAgeMs) {
      return {status: "degraded", label: "恢复演练已过期", checkedAt, scope: "restore_rehearsal"};
    }
    return {status: "healthy", label: "备份恢复已验证", checkedAt, scope: "restore_rehearsal"};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {...undetected};
    return invalid("恢复报告不可用", null);
  }
}

function invalid(label: string, checkedAt: string | null): BackupRestoreCheck {
  return {status: "failed", label, checkedAt, scope: "restore_rehearsal"};
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validTime(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
