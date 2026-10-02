/** Keep actionable short business text, but never relay response dumps or credential-like content. */
export function safeBusinessMessage(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/(?:zovo\s*card|spacex\s*card|raw[ _-]*supplier|supplier|upstream|上游|供应商|卡台|api[ _-]*key|secret|token|session|password|passwd|cookie|authorization|bearer|https?:\/\/|\beyJ[A-Za-z0-9_-]+\.|[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:凭据|密码|密钥)\s*[:=：]|[A-Za-z0-9_+/=-]{40,})/i.test(value)) return fallback;
  const sanitized = value.trim().replace(/\b\d{12,19}\b/g, "****").replace(/\s+/g, " ").slice(0, 240).trim();
  return sanitized || fallback;
}
