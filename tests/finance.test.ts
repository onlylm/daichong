import { describe, expect, it } from "vitest";
import { merchantMargin, minorToMoney, moneyToMinor } from "../src/domain/money.js";
import { assertBalanced, buildPaymentJournal } from "../src/modules/ledger-service.js";
import type { Order } from "../src/domain/model.js";

describe("financial invariants", () => {
  it("keeps agent margin when only a price-adjustment rebate is paid to the buyer", () => {
    const margin = merchantMargin({
      saleAmountMinor: moneyToMinor("135.00"),
      supplyAmountMinor: moneyToMinor("110.00"),
      ordinaryRefundedMinor: 0n,
      priceAdjustmentRefundedMinor: moneyToMinor("10.00"),
    });
    // 差价退款由平台承担（上游实扣降低），不冲代理佣金：135 - 110 = 25
    expect(minorToMoney(margin)).toBe("25.00");
  });

  it("reduces agent margin only for ordinary customer refunds", () => {
    const margin = merchantMargin({
      saleAmountMinor: moneyToMinor("135.00"),
      supplyAmountMinor: moneyToMinor("110.00"),
      ordinaryRefundedMinor: moneyToMinor("10.00"),
      priceAdjustmentRefundedMinor: 0n,
    });
    expect(minorToMoney(margin)).toBe("15.00");
  });

  it("builds a balanced payment journal including the payment fee", () => {
    const order = sampleOrder();
    const lines = buildPaymentJournal(order);
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(lines.filter((line) => line.direction === "debit").reduce((sum, line) => sum + line.amountMinor, 0n)).toBe(13_500n);
  });
});

function sampleOrder(): Order {
  const now = new Date();
  return {
    id: "ord_finance", merchantId: "merchant", appId: "app", merchantOrderNo: "M1",
    productCode: "p", quantity: 1, saleAmountMinor: 13_500n, supplyAmountMinor: 11_000n,
    ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n, currency: "CNY", paymentStatus: "paid",
    metadata: {},
    paymentProviderRef: "pay", paymentReceivedMinor: 13_500n, paymentFeeMinor: 81n,
    qrPayload: null, qrImageUrl: null, settlementId: null, paidAt: now,
    fulfillmentMode: "direct", upstreamProduct: "gpt", upstreamPlan: "plus",
    fulfillmentUrl: "https://pay.quefa.example/recharge/ord_finance?token=test", voucherCode: null,
    expiresAt: now, createdAt: now, updatedAt: now,
  };
}
