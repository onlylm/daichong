import {randomUUID} from "node:crypto";
import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";
import type {Repository} from "../infra/repository.js";
import {AuditService} from "../modules/audit-service.js";
import {managedGptProduct} from "../modules/gpt-products.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import type {Actor, DailySettlementStatement, WalletEntry} from "./model.js";
import {queryRecords} from "../infra/record-query.js";

const DAY = 86_400_000;

/**
 * Daily reconciliation is deliberately a two-stage process:
 * 1. the worker creates a read-only calculation after 22:00 Asia/Shanghai;
 * 2. a platform administrator records an already completed external payout.
 * Generation never calls a payment provider and never changes a wallet balance.
 */
export class DailySettlementService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService) {}

  tick(now = new Date()) {
    const due = latestDueBusinessDate(now);
    return this.generate(due);
  }

  generate(businessDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new AppError(422, "settlement_date_invalid", "核算日期无效");
    const checkpointId = "daily-settlement:" + businessDate;
    return this.repository.transaction(() => {
      if (this.repository.getOperations("service_checkpoint", checkpointId)) return {generated: false, businessDate, count: 0};
      const periodTo = new Date(businessDate + "T22:00:00+08:00");
      const periodFrom = new Date(periodTo.getTime() - DAY);
      if (periodTo.getTime() > Date.now() + 60_000) return {generated: false, businessDate, count: 0};
      const now = new Date();
      const databaseCandidates=this.repository.listDailySettlementCandidates?.(periodTo)??null;
      const candidatesByMerchant=new Map<string,NonNullable<typeof databaseCandidates>>();
      for(const candidate of databaseCandidates??[]){const values=candidatesByMerchant.get(candidate.order.merchantId)??[];values.push(candidate);candidatesByMerchant.set(candidate.order.merchantId,values);}
      const funds=new Map((this.repository.dailySettlementFunds?.([...candidatesByMerchant.keys()])??[]).map(value=>[value.merchantId,value]));
      const catalog=this.repository.getOperations("global_product_catalog","default")?.products??[];
      let count = 0;
      for (const merchant of this.repository.listMerchants().filter(item => item.status === "active")) {
        const id = `ds_${businessDate.replaceAll("-", "")}_${merchant.id}`;
        if (this.repository.getOperations("daily_settlement", id)) continue;
        const candidates=databaseCandidates?candidatesByMerchant.get(merchant.id)??[]:this.fallbackCandidates(merchant.id,periodTo);
        const orders=candidates.map(value=>value.order);
        if (orders.length === 0) continue;
        const orderIds = orders.map(order => order.id);
        const supplyAmountMinor = orders.reduce((sum, order) => sum + order.supplyAmountMinor, 0n);
        const platformCostMinor = orders.reduce((sum, order) => {
          const configured = catalog.find(item => item.productCode === order.productCode)?.standardCostCnyMinor;
          const unit = order.costTerms?.standardCnyMinor ?? configured ?? managedGptProduct(order.productCode)?.costPriceMinor ?? 0n;
          return sum + unit * BigInt(order.quantity);
        }, 0n);
        const agentEarningsMinor = candidates.reduce((sum,value)=>sum+value.credit.recognizedMinor,0n);
        const financial=funds.get(merchant.id),earningsBalance=financial?.earningsBalance??this.repository.walletTotals?.(merchant.id).earnings
          ??this.repository.listOperations("wallet_entry",merchant.id).reduce((sum,entry)=>sum+entry.earningsDelta,0n);
        const alreadyScheduled=financial?.alreadyScheduled??this.repository.listOperations("daily_settlement",merchant.id)
          .filter(statement=>statement.status==="pending_payment").reduce((sum,statement)=>sum+statement.payableMinor,0n);
        const payableMinor = min(agentEarningsMinor, positive(earningsBalance - alreadyScheduled));
        const statement: DailySettlementStatement = {
          id, merchantId: merchant.id, businessDate, periodFrom, periodTo,
          status: payableMinor > 0n ? "pending_payment" : "no_payable",
          orderIds, orderCount: orders.length, supplyAmountMinor, agentEarningsMinor, platformCostMinor,
          platformProfitMinor: supplyAmountMinor - platformCostMinor, payableMinor, currency: "CNY",
          payoutMethod: null, payoutReference: null, payoutEvidence: null, note: null, confirmedBy: null,
          version: 1, generatedAt: now, paidAt: null, reconciledAt: payableMinor > 0n ? null : now, updatedAt: now,
        };
        this.repository.saveOperations("daily_settlement", statement, true);
        count++;
      }
      this.repository.saveOperations("service_checkpoint", {id: checkpointId, merchantId: null, createdAt: now}, true);
      return {generated: true, businessDate, count};
    });
  }

  private fallbackCandidates(merchantId:string,periodTo:Date) {
    const assigned=new Set(this.repository.listOperations("daily_settlement",merchantId).filter(statement=>statement.status!=="voided").flatMap(statement=>statement.orderIds));
    return this.repository.listOperations("wallet_credit",merchantId).filter(credit=>credit.createdAt<periodTo&&credit.recognizedMinor>0n&&!assigned.has(credit.orderId))
      .flatMap(credit=>{const order=this.repository.findOrderInternal(credit.orderId);if(!order||order.archivedAt||order.liveTest||(order.collectionMode??"platform_collect")!=="platform_collect")return [];
        const payment=this.repository.findPaymentAttemptByOrder(order.merchantId,order.id),received=payment?.receivedMinor??order.paymentReceivedMinor;
        return payment?.status==="paid"&&received===order.saleAmountMinor&&this.repository.listFulfillments(order.merchantId,order.id).some(task=>task.status==="succeeded")?[{order,credit}]:[];});
  }

  list(actor: Actor, merchantId?: string) {
    requirePermission(actor, "wallet.read");
    const scoped = isPlatform(actor) ? merchantId : actor.merchantId ?? undefined;
    if (scoped) requireTenantScope(actor, scoped);
    return this.mapStatements(this.repository.listOperations("daily_settlement", scoped)
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate) || b.generatedAt.getTime() - a.generatedAt.getTime())
    );
  }

  page(actor: Actor, input: {merchantId?: string; status?: DailySettlementStatement["status"] | "all"; page: number; limit: number}) {
    requirePermission(actor, "wallet.read");
    const scoped = isPlatform(actor) ? input.merchantId : actor.merchantId ?? undefined;
    if (input.merchantId) requireTenantScope(actor, input.merchantId);
    const result = queryRecords(this.repository, "daily_settlement", {
      ...(scoped ? {merchantId: scoped} : {}),
      filters: input.status && input.status !== "all" ? [{field: "status", value: input.status}] : [],
      page: input.page, limit: input.limit, orderBy: "updatedAt", direction: "desc",
    });
    return {...result, data: this.mapStatements(result.data)};
  }

  pendingPage(actor: Actor, limit = 8) {
    requirePermission(actor, "wallet.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台可查看全部待核算单");
    const page = queryRecords(this.repository, "daily_settlement", {filters: [{field: "status", op: "in", value: ["pending_payment", "paid", "disputed"]}],
      page: 1, limit, orderBy: "updatedAt", direction: "desc"});
    return {...page, data: this.mapStatements(page.data)};
  }

  confirmPaid(actor: Actor, id: string, input: {method: "alipay" | "bank" | "other"; reference: string; evidence?: string | undefined; note?: string | undefined}) {
    if (actor.role !== "platform_admin" || actor.merchantId !== null) throw new AppError(403, "permission_denied", "仅平台管理员可确认核算单打款");
    const reference = input.reference.trim();
    const evidence = input.evidence?.trim() || null;
    const note = input.note?.trim() || null;
    if (reference.length < 6 || reference.length > 120) throw new AppError(422, "invalid_payout_reference", "请填写 6–120 位真实付款流水号");
    if (!evidence || evidence.length < 4 || evidence.length > 500 || (note?.length ?? 0) > 500)
      throw new AppError(422, "settlement_evidence_required", "请填写 4–500 字付款凭证说明或凭证存放位置");
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("daily_settlement", id);
      if (!current) throw new AppError(404, "daily_settlement_not_found", "每日核算单不存在");
      if (current.status === "paid") {
        if (current.payoutReference === reference && current.payoutMethod === input.method
          && current.payoutEvidence === evidence && current.note === note) return current;
        throw new AppError(409, "daily_settlement_payment_conflict", "该核算单已登记打款，重放内容与原付款记录不一致");
      }
      if (current.status !== "pending_payment" || current.payableMinor <= 0n) throw new AppError(409, "daily_settlement_final", "该核算单不可确认打款");
      const duplicateStatement = queryRecords(this.repository,"daily_settlement",{filters:[{field:"payoutReference",value:reference},
        {field:"id",op:"ne",value:id}],limit:1,count:false}).data.length>0;
      const duplicateWithdrawal = queryRecords(this.repository,"wallet_withdrawal",{filters:[{field:"payoutReference",value:reference}],limit:1,count:false}).data.length>0;
      if (duplicateStatement || duplicateWithdrawal) throw new AppError(409, "payout_reference_used", "该付款流水号已使用");
      const refundPending=this.repository.hasPendingRefundForReleasedEarnings?.(current.merchantId,current.orderIds)
        ??current.orderIds.some(orderId=>this.repository.listRefundsForOrder(current.merchantId,orderId)
          .some(refund=>["requested","approved","processing"].includes(refund.status)));
      if(refundPending)throw new AppError(409,"settlement_refund_pending","代理收益关联订单仍有退款待确认，暂不能登记打款");
      const currentStatementEarnings=this.repository.walletCreditTotalForOrders?.(current.merchantId,current.orderIds)
        ??this.repository.listOperations("wallet_credit",current.merchantId)
          .filter(credit=>current.orderIds.includes(credit.orderId)).reduce((sum,credit)=>sum+credit.recognizedMinor,0n);
      if(currentStatementEarnings!==current.agentEarningsMinor){
        throw new AppError(409,"settlement_amount_changed","核算单内订单收益已因退款或纠偏变化，请作废本单并在下一核算周期重新生成");
      }
      const earnings = this.repository.walletTotals?.(current.merchantId).earnings
        ??this.repository.listOperations("wallet_entry", current.merchantId).reduce((sum, entry) => sum + entry.earningsDelta, 0n);
      if (earnings < current.payableMinor) throw new AppError(409, "settlement_balance_changed", "代理收益余额已变化，当前不足以确认该核算单；请取消本单并按新余额处理");
      const entry: WalletEntry = {id: "settlement_payout:" + current.id, merchantId: current.merchantId, kind: "settlement_payout",
        procurementDelta: 0n, earningsDelta: -current.payableMinor, frozenDelta: 0n, reference, actorId: actor.id,
        reason: `每日核算单 ${current.businessDate} 已人工确认打款`, createdAt: new Date()};
      this.repository.saveOperations("wallet_entry", entry, true);
      const now = new Date();
      const updated: DailySettlementStatement = {...current, status: "paid", payoutMethod: input.method,
        payoutReference: reference, payoutEvidence: evidence, note, confirmedBy: actor.id, paidAt: now,
        updatedAt: now, version: current.version + 1};
      this.repository.saveOperations("daily_settlement", updated);
      this.audit.record({merchantId: current.merchantId, actorId: actor.id, actorType: "platform_user",
        action: "daily_settlement.paid", targetType: "daily_settlement", targetId: current.id, requestId: randomUUID()});
      return updated;
    });
  }

  reconcile(actor: Actor, id: string, note: string) {
    if (actor.role !== "platform_admin" || actor.merchantId !== null) throw new AppError(403, "permission_denied", "仅平台管理员可核销核算单");
    const value = note.trim();
    if (value.length < 4 || value.length > 500) throw new AppError(422, "settlement_reconcile_note_required", "请填写 4–500 字核销说明");
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("daily_settlement", id);
      if (!current) throw new AppError(404, "daily_settlement_not_found", "每日核算单不存在");
      if (current.status === "reconciled") return current;
      if (current.status !== "paid" || !current.payoutReference || !current.payoutEvidence)
        throw new AppError(409, "settlement_not_paid", "只有已记录真实付款流水与凭证的核算单才能核销");
      const now = new Date();
      const updated: DailySettlementStatement = {...current, status: "reconciled", note: [current.note, value].filter(Boolean).join("；"),
        reconciledAt: now, updatedAt: now, version: current.version + 1};
      this.repository.saveOperations("daily_settlement", updated);
      this.audit.record({merchantId: current.merchantId, actorId: actor.id, actorType: "platform_user",
        action: "daily_settlement.reconciled", targetType: "daily_settlement", targetId: current.id, requestId: randomUUID()});
      return updated;
    });
  }

  cancel(actor: Actor, id: string, reason: string) {
    if (actor.role !== "platform_admin" || actor.merchantId !== null) throw new AppError(403, "permission_denied", "仅平台管理员可取消核算单");
    const note = reason.trim();
    if (note.length < 4 || note.length > 500) throw new AppError(422, "settlement_cancel_reason_required", "请填写 4–500 字取消原因");
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("daily_settlement", id);
      if (!current) throw new AppError(404, "daily_settlement_not_found", "每日核算单不存在");
      if (current.status === "voided" && current.note === note) return current;
      if (current.status !== "pending_payment") throw new AppError(409, "daily_settlement_final", "该核算单不能作废");
      const updated: DailySettlementStatement = {...current, status: "voided", note, confirmedBy: actor.id,
        updatedAt: new Date(), version: current.version + 1};
      this.repository.saveOperations("daily_settlement", updated);
      this.audit.record({merchantId: current.merchantId, actorId: actor.id, actorType: "platform_user",
        action: "daily_settlement.cancel", targetType: "daily_settlement", targetId: current.id, requestId: randomUUID()});
      return updated;
    });
  }

  private mapStatements(statements: DailySettlementStatement[]) {
    const merchants = new Map(this.repository.listMerchants().map(item => [item.id, item]));
    return statements.map(statement => {
      const merchant = merchants.get(statement.merchantId);
      return {...statement, merchantName: merchant?.name ?? "历史代理商", partnerId: merchant?.partnerId ?? "",
        supplyAmount: minorToMoney(statement.supplyAmountMinor), agentEarnings: minorToMoney(statement.agentEarningsMinor),
        platformCost: minorToMoney(statement.platformCostMinor), platformProfit: minorToMoney(statement.platformProfitMinor),
        payable: minorToMoney(statement.payableMinor)};
    });
  }
}

function latestDueBusinessDate(now: Date): string {
  const shanghai = new Date(now.getTime() + 8 * 3600_000);
  const today = shanghai.toISOString().slice(0, 10);
  if (shanghai.getUTCHours() >= 22) return today;
  return new Date(new Date(today + "T00:00:00+08:00").getTime() - DAY + 8 * 3600_000).toISOString().slice(0, 10);
}

function positive(value: bigint): bigint { return value > 0n ? value : 0n; }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
