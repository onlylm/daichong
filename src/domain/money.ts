import { AppError } from "./errors.js";

/** Stored on grants for API compatibility; order validation does not cap sale price below this. */
export const UNBOUNDED_MAX_SALE_PRICE_MINOR = 999_999_999n;

export function moneyToMinor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(value)) {
    throw new AppError(422, "invalid_money", "金额必须是非负、两位小数的字符串");
  }
  const [whole = "0", fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

export function minorToMoney(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Agent commission on a platform-collect order.
 * Ordinary customer refunds reduce margin; price-adjustment (upstream undercharge
 * rebate to the buyer) does not — that cost is borne by the platform.
 */
export function merchantMargin(order: {
  saleAmountMinor: bigint;
  supplyAmountMinor: bigint;
  ordinaryRefundedMinor: bigint;
  priceAdjustmentRefundedMinor?: bigint;
}): bigint {
  const value = order.saleAmountMinor - order.supplyAmountMinor - order.ordinaryRefundedMinor;
  return value > 0n ? value : 0n;
}

