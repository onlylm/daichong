import {randomBytes} from "node:crypto";
import {AppError} from "../domain/errors.js";

/** Public redemption codes: `{PREFIX}-XXXXX-XXXXX-XXXXX-XXXXX` */
export const CDK_PUBLIC_CODE_PATTERN = /^[A-Z0-9]{2,8}-[A-Z0-9]{5}(?:-[A-Z0-9]{5}){0,3}$/i;

export function normalizeCdkPrefix(value: string | undefined | null, fallback = "QF"): string {
  const candidate = (value ?? fallback).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z0-9]{2,8}$/.test(candidate)) return candidate;
  if (fallback !== "QF") return normalizeCdkPrefix("QF");
  return "QF";
}

export function assertCdkPrefix(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(normalized)) {
    throw new AppError(422, "cdk_prefix_invalid", "CDK 前缀须为 2–8 位大写字母或数字");
  }
  return normalized;
}

export function createPublicCdkCode(prefix: string): string {
  const normalized = normalizeCdkPrefix(prefix);
  const raw = randomBytes(10).toString("hex").toUpperCase();
  return `${normalized}-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

export function isPublicCdkCode(value: string): boolean {
  return CDK_PUBLIC_CODE_PATTERN.test(value.trim());
}
