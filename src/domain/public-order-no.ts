/** Customer-facing platform order numbers (Alipay bill title, APIs, support). */
export const PUBLIC_ORDER_NO_PATTERN = /^QF[0-9]{10}$/;

const WIDTH = 10;

export function formatPublicOrderNo(sequence: bigint): string {
  if (sequence <= 0n) throw new Error("invalid_public_order_sequence");
  const digits = sequence.toString();
  if (digits.length > WIDTH) throw new Error("public_order_sequence_exhausted");
  return "QF" + digits.padStart(WIDTH, "0");
}

export function isPublicOrderNo(value: string): boolean {
  return PUBLIC_ORDER_NO_PATTERN.test(value);
}
