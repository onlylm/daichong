import { randomUUID } from "node:crypto";
import type { Order, Settlement, SettlementLine } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { merchantMargin } from "../domain/money.js";
import { assertSettlementTransition } from "../domain/state-machines.js";
import { AppError, notFound } from "../domain/errors.js";

export class SettlementService {
  constructor(private readonly repository: Repository) {}

  createDraft(merchantId: string, periodFrom: Date, periodTo: Date, orders: Order[]): Settlement {
    if (orders.some(o => o.merchantId !== merchantId || o.collectionMode === "agent_collect" || this.repository.getOperations("wallet_credit", o.id))) {
      throw new AppError(409, "settlement_source_conflict", "自收款订单或已释放至收益钱包的订单不能再次结算");
    }
    const id = `st_${randomUUID().replaceAll("-", "")}`;
    const lines: SettlementLine[] = orders.map((order) => ({
      id: `sl_${randomUUID().replaceAll("-", "")}`,
      merchantId,
      orderId: order.id,
      sourceType: "merchant_margin",
      sourceId: order.id,
      amountMinor: merchantMargin(order),
      originalSettlementLineId: null,
    }));
    const grossMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
    const settlement: Settlement = {
      id, merchantId, periodFrom, periodTo, status: "draft", grossMinor, adjustmentMinor: 0n,
      payableMinor: grossMinor, currency: "CNY", sealedAt: null, paidAt: null, createdAt: new Date(), lines,
    };
    this.repository.insertSettlement(settlement);
    for (const order of orders) this.repository.updateOrder({...order, settlementId: id, updatedAt: new Date()});
    return settlement;
  }

  seal(merchantId: string, settlementId: string): Settlement {
    const current = this.repository.findSettlement(merchantId, settlementId);
    if (!current) throw notFound("settlement");
    if (current.status !== "draft") throw new AppError(409, "settlement_not_draft", "只有草稿结算单可以封存");
    assertSettlementTransition("draft", "reviewing");
    assertSettlementTransition("reviewing", "confirmed");
    const sealed: Settlement = {...current, status: "confirmed", sealedAt: new Date()};
    this.repository.updateSettlement(sealed);
    return sealed;
  }
}
