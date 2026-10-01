import {randomBytes} from "node:crypto";
import {AppError} from "../domain/errors.js";

/** Existing default format; stored codes remain valid when a merchant changes its template. */
export const DEFAULT_CDK_CODE_TEMPLATE = "{PREFIX}-{RANDOM:5}-{RANDOM:5}-{RANDOM:5}-{RANDOM:5}";
/** Public codes are opaque identifiers. Exact structure is controlled by the issuing merchant template. */
export const CDK_PUBLIC_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{7,63}$/i;
const TEMPLATE_TOKEN_PATTERN = /\{PREFIX\}|\{RANDOM:(\d{1,2})\}/g;

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

export function normalizeCdkTemplate(value: string | undefined | null): string {
  try {
    return assertCdkTemplate(value ?? DEFAULT_CDK_CODE_TEMPLATE);
  } catch {
    return DEFAULT_CDK_CODE_TEMPLATE;
  }
}

/**
 * Controlled format: one `{PREFIX}` plus one or more `{RANDOM:n}` tokens.
 * Literals may contain uppercase letters, digits, `_` and `-`; at least 20 random hex chars preserve 80 bits of entropy.
 */
export function assertCdkTemplate(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized || normalized.length > 120) throw new AppError(422, "cdk_template_invalid", "CDK 模板长度应为 1–120 个字符");
  const tokens = [...normalized.matchAll(TEMPLATE_TOKEN_PATTERN)];
  if (tokens.filter(match => match[0] === "{PREFIX}").length !== 1) {
    throw new AppError(422, "cdk_template_prefix_required", "CDK 模板必须且只能包含一个 {PREFIX}");
  }
  const randomLengths = tokens.filter(match => match[1]).map(match => Number(match[1]));
  if (!randomLengths.length || randomLengths.some(length => length < 4 || length > 12)) {
    throw new AppError(422, "cdk_template_random_invalid", "每个随机段须使用 {RANDOM:n}，n 为 4–12");
  }
  if (randomLengths.reduce((sum, length) => sum + length, 0) < 20) {
    throw new AppError(422, "cdk_template_entropy_low", "随机段总长度不得少于 20 位");
  }
  const literals = normalized.replace(TEMPLATE_TOKEN_PATTERN, "");
  if (!/^[A-Z0-9_-]*$/.test(literals)) throw new AppError(422, "cdk_template_literal_invalid", "模板固定内容仅支持大写字母、数字、横线和下划线");
  const preview = normalized.replace("{PREFIX}", "PREFIX88")
    .replace(TEMPLATE_TOKEN_PATTERN, match => match === "{PREFIX}" ? "PREFIX88" : "X".repeat(Number(match.match(/\d+/)?.[0] ?? 0)));
  if (preview.length < 8 || preview.length > 64) throw new AppError(422, "cdk_template_length_invalid", "生成后的 CDK 长度须为 8–64 位");
  if (!CDK_PUBLIC_CODE_PATTERN.test(preview)) throw new AppError(422, "cdk_template_shape_invalid", "CDK 必须以字母或数字开头，且只能包含字母、数字、横线和下划线");
  return normalized;
}

export function createPublicCdkCode(prefix: string, template = DEFAULT_CDK_CODE_TEMPLATE): string {
  const normalized = normalizeCdkPrefix(prefix);
  const format = normalizeCdkTemplate(template);
  return format.replace(TEMPLATE_TOKEN_PATTERN, (token, size: string | undefined) => {
    if (token === "{PREFIX}") return normalized;
    const length = Number(size);
    return randomBytes(Math.ceil(length / 2)).toString("hex").toUpperCase().slice(0, length);
  });
}

export function isPublicCdkCode(value: string): boolean {
  return CDK_PUBLIC_CODE_PATTERN.test(value.trim());
}
