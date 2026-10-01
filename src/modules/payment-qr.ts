import QRCode from "qrcode";

const cache = new Map<string, string>();
const maxCacheEntries = 200;

/**
 * Render payment codes locally. Buyer browsers must never contact a third-party
 * QR rendering service just to display a provider-issued payment code.
 */
export async function paymentQrDataUrl(content: string): Promise<string> {
  const cached = cache.get(content);
  if (cached) return cached;
  const value = await QRCode.toDataURL(content, {
    type: "image/png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280,
    color: {dark: "#0f172a", light: "#ffffff"},
  });
  cache.set(content, value);
  if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value!);
  return value;
}
