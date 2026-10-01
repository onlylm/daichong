import { randomUUID } from "node:crypto";
import type { LedgerItem, Order, Refund } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { merchantMargin } from "../domain/money.js";

export interface JournalLine {
  accountCode: "cash_at_channel" | "payment_fee_expense" | "quefa_supply_revenue" | "merchant_margin_payable" | "customer_refund" | "upstream_cost_expense";
  direction: "debit" | "credit";
  amountMinor: bigint;
}

export function assertBalanced(lines: readonly JournalLine[]): void {
  const debit = lines.filter((line) => line.direction === "debit").reduce((sum, line) => sum + line.amountMinor, 0n);
  const credit = lines.filter((line) => line.direction === "credit").reduce((sum, line) => sum + line.amountMinor, 0n);
  if (debit !== credit) throw new Error(`unbalanced_journal:${debit}:${credit}`);
}

export function buildPaymentJournal(order: Order): JournalLine[] {
  const fee = order.paymentFeeMinor ?? 0n;
  if (fee > order.saleAmountMinor) throw new Error("payment_fee_exceeds_sale_amount");
  const lines: JournalLine[] = [
    {accountCode: "cash_at_channel", direction: "debit", amountMinor: order.saleAmountMinor - fee},
    {accountCode: "payment_fee_expense", direction: "debit", amountMinor: fee},
    {accountCode: "quefa_supply_revenue", direction: "credit", amountMinor: order.supplyAmountMinor},
    {accountCode: "merchant_margin_payable", direction: "credit", amountMinor: merchantMargin(order)},
  ];
  assertBalanced(lines);
  return lines;
}

export class LedgerService {
  constructor(private readonly repository: Repository) {}

  recordPayment(order: Order): void {
    buildPaymentJournal(order);
    const margin = merchantMargin(order);
    const now = order.paidAt ?? new Date();
    this.repository.appendLedger([
      this.item(order, "user_payment", order.saleAmountMinor, "increase", now),
      this.item(order, "supply_price", order.supplyAmountMinor, "increase", now),
      this.item(order, "merchant_margin", margin, "increase", now),
      this.item(order, "merchant_pending_settlement", margin, "increase", now),
    ]);
  }

  recordRefund(order: Order, refund: Refund): void {
    const type = refund.type === "price_adjustment" ? "price_adjustment_refund" : "ordinary_refund";
    const occurredAt = refund.refundedAt ?? new Date();
    const items: LedgerItem[] = [this.item(order, type, refund.amountMinor, "decrease", occurredAt)];
    // Price adjustment = platform rebates buyer when upstream charged less than quoted cost.
    // Do not claw back agent margin; only ordinary refunds shrink commission.
    if (refund.type !== "price_adjustment") {
      const priorOrdinary = order.ordinaryRefundedMinor - refund.amountMinor;
      const marginBefore = positive(order.saleAmountMinor - order.supplyAmountMinor - priorOrdinary);
      const marginAfter = merchantMargin(order);
      const reverse = marginBefore > marginAfter ? marginBefore - marginAfter : 0n;
      if (reverse > 0n) {
        items.push(this.item(order, "merchant_margin", reverse, "decrease", occurredAt));
        items.push(this.item(order, "merchant_pending_settlement", reverse, "decrease", occurredAt));
        if (order.settlementId) items.push(this.item(order, "settlement_adjustment", reverse, "decrease", occurredAt));
      }
    }
    this.repository.appendLedger(items);
  }

  private item(order: Order, type: LedgerItem["type"], amountMinor: bigint, direction: LedgerItem["direction"], occurredAt: Date): LedgerItem {
    return {id: `le_${randomUUID().replaceAll("-", "")}`, merchantId: order.merchantId, orderId: order.id, type, amountMinor, direction, occurredAt};
  }
}

function positive(value: bigint): bigint { return value > 0n ? value : 0n; }

