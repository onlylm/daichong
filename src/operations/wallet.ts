import {randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import type {Order} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import {merchantMargin, moneyToMinor, minorToMoney} from "../domain/money.js";
import {AuditService} from "../modules/audit-service.js";
import {WebhookService} from "../modules/webhook-service.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import type {Actor, WalletDeposit, WalletEntry, WalletWithdrawal} from "./model.js";
import {queryRecords} from '../infra/record-query.js';

export class WalletService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService, private readonly webhooks: WebhookService) {}

  summary(actor: Actor, merchantId: string) {
    requirePermission(actor, "wallet.read"); requireTenantScope(actor, merchantId);
    return this.repository.transaction(() => {
      const totals = this.totals(merchantId);
      const pendingRows = this.pendingEarningOrders(merchantId);
      const pending = pendingRows.reduce((sum, o) => sum + positive(merchantMargin(o)), 0n);
      return {currency: "CNY", procurementAvailable: minorToMoney(totals.procurement), earningsAvailable: minorToMoney(positive(totals.earnings)),
        earningsDebt: minorToMoney(positive(-totals.earnings)), withdrawalFrozen: minorToMoney(totals.frozen), pendingReviewEarnings: minorToMoney(pending),
        autoPayoutEnabled: false};
    });
  }

  /** Leftover orders that failed auto-credit (normally empty once fulfillment succeeds). */
  listPendingEarnings(actor: Actor, merchantId: string) {
    requirePermission(actor, "wallet.review");
    requireTenantScope(actor, merchantId);
    return this.repository.transaction(() => {
      return this.pendingEarningOrders(merchantId).map((order) => {
        const fulfillment = this.repository.listFulfillments(order.merchantId, order.id)
          .find((item) => item.status === "succeeded") ?? null;
        const margin = positive(merchantMargin(order));
        return {
          orderId: order.id,
          merchantOrderNo: order.merchantOrderNo,
          productCode: order.productCode,
          saleAmount: minorToMoney(order.saleAmountMinor),
          supplyAmount: minorToMoney(order.supplyAmountMinor),
          margin: minorToMoney(margin),
          paidAt: order.paidAt?.toISOString() ?? null,
          fulfilledAt: fulfillment?.finishedAt?.toISOString() ?? null,
          accountEmailMasked: fulfillment?.accountEmailMasked ?? null,
        };
      });
    });
  }

  releaseEarningsBatch(actor: Actor, orderIds: readonly string[]): {released: string[]; skipped: Array<{orderId: string; reason: string}>} {
    requirePermission(actor, "wallet.review");
    const unique = [...new Set(orderIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) throw new AppError(422, "order_ids_required", "请选择至少一笔待核对订单");
    if (unique.length > 100) throw new AppError(422, "too_many_orders", "单次最多释放 100 笔");
    const released: string[] = [];
    const skipped: Array<{orderId: string; reason: string}> = [];
    for (const orderId of unique) {
      try {
        this.releaseEarning(actor, orderId);
        released.push(orderId);
      } catch (error) {
        const reason = error instanceof AppError ? error.message : "释放失败";
        skipped.push({orderId, reason});
      }
    }
    return {released, skipped};
  }

  entries(actor: Actor, merchantId: string) {
    requirePermission(actor, "wallet.read"); requireTenantScope(actor, merchantId);
    return this.repository.listOperations("wallet_entry", merchantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(x => ({...x, procurementDelta: minorToMoney(x.procurementDelta), earningsDelta: minorToMoney(x.earningsDelta), frozenDelta: minorToMoney(x.frozenDelta)}));
  }
  historyPage(actor: Actor, merchantId: string, kind: "deposits" | "withdrawals" | "ledger", page: number, limit: number) {
    requirePermission(actor, "wallet.read"); requireTenantScope(actor, merchantId);
    if (kind === "deposits") return queryRecords(this.repository, "wallet_deposit", {merchantId, page, limit, orderBy: "createdAt", direction: "desc"});
    if (kind === "withdrawals") return queryRecords(this.repository, "wallet_withdrawal", {merchantId, page, limit, orderBy: "createdAt", direction: "desc"});
    const result = queryRecords(this.repository, "wallet_entry", {merchantId, page, limit, orderBy: "createdAt", direction: "desc"});
    return {...result, data: result.data.map(x => ({...x, procurementDelta: minorToMoney(x.procurementDelta),
      earningsDelta: minorToMoney(x.earningsDelta), frozenDelta: minorToMoney(x.frozenDelta)}))};
  }
  adminOverview(actor: Actor) {
    requirePermission(actor, "wallet.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    if(this.repository.walletOverview){
      const summaries=new Map(this.repository.walletOverview().map(item=>[item.merchantId,item]));
      return this.repository.listMerchants().map(merchant=>{
        const item=summaries.get(merchant.id)??{procurement:0n,earnings:0n,frozen:0n,pendingEarning:0n,lastEntryAt:null};
        return {merchantId:merchant.id,name:merchant.name,partnerId:merchant.partnerId,status:merchant.status,
          procurementAvailable:minorToMoney(item.procurement),earningsAvailable:minorToMoney(positive(item.earnings)),
          earningsDebt:minorToMoney(positive(-item.earnings)),withdrawalFrozen:minorToMoney(item.frozen),
          pendingReviewEarnings:minorToMoney(item.pendingEarning),lastEntryAt:item.lastEntryAt};
      }).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN"));
    }
    return this.repository.listMerchants().map(m => this.snapshot(m)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  /**
   * Platform GMV / order dashboard (Asia/Shanghai calendar days).
   * "收入" = platform_collect sale amounts confirmed paid that day (buyer money into Quefa).
   */
  platformFinanceSummary(actor: Actor, days = 7) {
    requirePermission(actor, "wallet.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台可查看资金看板");
    const windowDays = Math.min(31, Math.max(1, days));
    const merchants = new Map(this.repository.listMerchants().map((m) => [m.id, m]));
    const todayKey = shanghaiDayKey(new Date());
    const from=new Date(shanghaiDayOffset(todayKey,-windowDays+1)+'T00:00:00+08:00').toISOString(),to=new Date(shanghaiDayOffset(todayKey,1)+'T00:00:00+08:00').toISOString();
    const sql=this.repository.financeWindow?.(from,to);
    const orders=sql?.todayOrders??this.repository.listOrdersInternal().filter(order=>!order.liveTest);
    const dayMap = new Map<string, DayBucket>();
    for (let i = 0; i < windowDays; i++) {
      const key = shanghaiDayOffset(todayKey, -i);
      dayMap.set(key, emptyDay(key));
    }
    if(sql)for(const row of sql.daily){const bucket=dayMap.get(String(row.day));if(!bucket)continue;for(const key of Object.keys(bucket)){if(key==='day')continue;(bucket as any)[key]=typeof (bucket as any)[key]==='bigint'?BigInt(String(row[key]??0)):Number(row[key]??0);}}

    const todayOrders: Array<{
      orderId: string; merchantName: string; partnerId: string; productCode: string;
      saleAmount: string; supplyAmount: string; collectionMode: string; paymentStatus: string;
      fulfillmentStatus: string | null; paidAt: string | null;
    }> = [];

    for (const order of orders) {
      const paidAt = order.paidAt;
      if (!paidAt) continue;
      if (!["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)) continue;
      const key = shanghaiDayKey(paidAt);
      const bucket = dayMap.get(key);
      if (!bucket) continue;

      if(!sql){bucket.paidOrders += 1;
      if ((order.collectionMode ?? "platform_collect") === "platform_collect") {
        bucket.platformCollectOrders += 1;
        bucket.saleAmountMinor += order.saleAmountMinor;
        bucket.supplyAmountMinor += order.supplyAmountMinor;
        bucket.ordinaryRefundedMinor += order.ordinaryRefundedMinor;
        bucket.priceAdjustmentRefundedMinor += order.priceAdjustmentRefundedMinor;
        bucket.marginMinor += merchantMargin(order);
      } else {
        bucket.agentCollectOrders += 1;
        bucket.agentCollectSupplyMinor += order.supplyAmountMinor;
      }

      const succeeded = this.repository.listFulfillments(order.merchantId, order.id).some((f) => f.status === "succeeded");
      if (succeeded) bucket.succeededOrders += 1;
      }

      if (key === todayKey) {
        const merchant = merchants.get(order.merchantId);
        const fulfillments = this.repository.listFulfillments(order.merchantId, order.id)
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const latest = fulfillments[0] ?? null;
        todayOrders.push({
          orderId: order.id,
          merchantName: merchant?.name ?? "—",
          partnerId: merchant?.partnerId ?? "",
          productCode: order.productCode,
          saleAmount: minorToMoney(order.saleAmountMinor),
          supplyAmount: minorToMoney(order.supplyAmountMinor),
          collectionMode: order.collectionMode ?? "platform_collect",
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: latest?.status ?? null,
          paidAt: paidAt.toISOString(),
        });
      }
    }

    todayOrders.sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)));
    const today = dayMap.get(todayKey) ?? emptyDay(todayKey);
    const daily = [...dayMap.values()]
      .sort((a, b) => b.day.localeCompare(a.day))
      .map(serializeDay);

    return {
      timezone: "Asia/Shanghai",
      today: serializeDay(today),
      daily,
      todayOrders: todayOrders.slice(0, 50),
    };
  }

  adminEntries(actor: Actor, query: {merchantId?: string | undefined; scope?: "all" | "commission"; page: number; limit: number}) {
    requirePermission(actor, "wallet.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    const merchants = new Map(this.repository.listMerchants().map(m => [m.id, m]));
    const merchantId = query.merchantId && query.merchantId !== "all" ? query.merchantId : undefined;
    const commissionKinds: WalletEntry["kind"][] = ["earning_release", "earning_reversal", "settlement_payout"];
    const result=queryRecords(this.repository,'wallet_entry',{...(merchantId?{merchantId}:{}),
      ...(query.scope==="commission"?{filters:[{field:"kind",op:"in" as const,value:commissionKinds}]}:{}),
      page:query.page,limit:query.limit});
    const {total,pages,page}=result.meta;
    const data = result.data.map(x => {
      const merchant = merchants.get(x.merchantId);
      return {id: x.id, merchantId: x.merchantId, merchantName: merchant?.name??'历史代理商', partnerId: merchant?.partnerId??'', kind: x.kind,
        procurementDelta: minorToMoney(x.procurementDelta), earningsDelta: minorToMoney(x.earningsDelta), frozenDelta: minorToMoney(x.frozenDelta),
        reference: x.reference, actorId: x.actorId, reason: x.reason ?? null, adjustmentAccount: x.adjustmentAccount ?? null,
        beforeAmount: x.beforeMinor === undefined ? null : minorToMoney(x.beforeMinor),
        afterAmount: x.afterMinor === undefined ? null : minorToMoney(x.afterMinor), createdAt: x.createdAt};
    });
    return {data, meta: {total, page, limit: query.limit, pages}};
  }
  private snapshot(merchant: {id: string; name: string; partnerId: string; status: string}) {
    const totals = this.totals(merchant.id);
    const lastEntry = queryRecords(this.repository,'wallet_entry',{merchantId:merchant.id,limit:1,count:false}).data[0];
    const pending = this.pendingEarningOrders(merchant.id).reduce((sum, o) => sum + positive(merchantMargin(o)), 0n);
    return {merchantId: merchant.id, name: merchant.name, partnerId: merchant.partnerId, status: merchant.status,
      procurementAvailable: minorToMoney(totals.procurement), earningsAvailable: minorToMoney(positive(totals.earnings)),
      earningsDebt: minorToMoney(positive(-totals.earnings)), withdrawalFrozen: minorToMoney(totals.frozen),
      pendingReviewEarnings: minorToMoney(pending), lastEntryAt: lastEntry?.createdAt ?? null};
  }
  requestDeposit(actor: Actor, merchantId: string, amount: string, requestKey: string, payerReference: string): WalletDeposit {
    requirePermission(actor, "wallet.deposit"); requireTenantScope(actor, merchantId);
    const amountMinor = requirePositive(amount);
    return this.repository.transaction(() => {
      const id = merchantId + ":" + requestKey;
      const current = this.repository.getOperations("wallet_deposit", id);
      if (current) {
        if (current.amountMinor !== amountMinor || current.payerReference !== payerReference) throw new AppError(409, "deposit_conflict", "申请号已用于不同充值请求");
        return current;
      }
      const value: WalletDeposit = {id, merchantId, amountMinor, requestKey, payerReference, paymentProvider: "manual", verifiedReference: null, reviewerId: null, status: "requested", createdAt: new Date(), updatedAt: new Date()};
      this.repository.saveOperations("wallet_deposit", value, true); this.log(actor, merchantId, "wallet.deposit.request", id);
      return value;
    });
  }
  requestAlipayDeposit(actor: Actor, merchantId: string, amount: string, requestKey: string, paymentConfigId: string, expiresAt: Date): WalletDeposit {
    requirePermission(actor, "wallet.deposit"); requireTenantScope(actor, merchantId);
    if (isPlatform(actor)) throw new AppError(403, "agent_wallet_required", "平台账号不能代代理商发起在线充值");
    const amountMinor = requirePositive(amount);
    return this.repository.transaction(() => {
      const existing = this.repository.listOperations("wallet_deposit", merchantId).find(item => item.requestKey === requestKey);
      if (existing) {
        if (existing.amountMinor !== amountMinor || existing.paymentProvider !== "alipay_page") throw new AppError(409, "deposit_conflict", "充值单号已用于不同请求");
        return existing;
      }
      const id = "wdep_" + randomUUID().replaceAll("-", "");
      const now = new Date();
      const value: WalletDeposit = {id, merchantId, amountMinor, requestKey, payerReference: "支付宝在线充值", paymentProvider: "alipay_page",
        paymentConfigId, providerRef: id, expiresAt, paidAt: null, nextCheckAt: null, verifiedReference: null, reviewerId: null,
        status: "requested", createdAt: now, updatedAt: now};
      this.repository.saveOperations("wallet_deposit", value, true);
      this.log(actor, merchantId, "wallet.deposit.alipay.create", id);
      return value;
    });
  }
  creditAlipayDeposit(id: string, providerReference: string, amountMinor: bigint): WalletDeposit {
    providerReference = providerReference.trim().toLowerCase();
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("wallet_deposit", id);
      if (!current || current.paymentProvider !== "alipay_page") throw new AppError(404, "wallet_payment_not_found", "余额充值订单不存在");
      if (current.amountMinor !== amountMinor || providerReference.length < 8) throw new AppError(409, "payment_binding_mismatch", "支付宝交易与余额充值订单不匹配");
      if (current.status === "credited") {
        if (current.verifiedReference !== providerReference) throw new AppError(409, "payment_reference_mismatch", "支付宝交易号不匹配");
        return current;
      }
      if (current.status !== "requested") throw new AppError(409, "deposit_already_reviewed", "余额充值订单已终结");
      if (this.repository.listOperations("wallet_deposit").some(item => item.id !== current.id && item.verifiedReference === providerReference && item.status === "credited")) {
        throw new AppError(409, "receipt_used", "该支付宝交易已入账");
      }
      this.entry(current.merchantId, "deposit:" + id, "deposit", current.amountMinor, 0n, 0n, providerReference, "payment:alipay");
      const updated = {...current, status: "credited" as const, verifiedReference: providerReference, reviewerId: "payment:alipay",
        paidAt: new Date(), nextCheckAt: null, updatedAt: new Date()};
      this.repository.saveOperations("wallet_deposit", updated);
      this.audit.record({merchantId: current.merchantId, actorId: "payment:alipay", actorType: "system", action: "wallet.deposit.credited",
        targetType: "wallet", targetId: id, requestId: randomUUID()});
      this.webhooks.emit(current.merchantId, id + ":wallet.deposit.credited", "wallet.deposit.credited", id,
        {event: "wallet.deposit.credited", deposit_id: id, amount: minorToMoney(current.amountMinor)});
      return updated;
    });
  }
  reviewDeposit(actor: Actor, id: string, approve: boolean, verifiedReference: string): WalletDeposit {
    requirePermission(actor, "wallet.review");
    verifiedReference = verifiedReference.trim().toLowerCase();
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("wallet_deposit", id);
      if (!current) throw new AppError(404, "deposit_not_found", "充值申请不存在");
      if (current.paymentProvider === "alipay_page") throw new AppError(409, "online_deposit_auto_reviewed", "支付宝在线充值由验签回调自动入账，不能人工审批");
      if (current.status === "credited" && approve && current.verifiedReference === verifiedReference) return current;
      if (current.status !== "requested") throw new AppError(409, "deposit_already_reviewed", "充值申请已处理");
      if (approve) {
        if (verifiedReference.trim().length < 6) throw new AppError(422, "receipt_required", "必须填写核实到账的唯一渠道流水");
        if (this.repository.listOperations("wallet_deposit").some(x => x.verifiedReference === verifiedReference && x.status === "credited")) throw new AppError(409, "receipt_used", "该渠道流水已入账，不能重复记账");
        this.entry(current.merchantId, "deposit:" + id, "deposit", current.amountMinor, 0n, 0n, verifiedReference, actor.id);
      }
      const updated = {...current, status: approve ? "credited" as const : "rejected" as const, verifiedReference: approve ? verifiedReference : null, reviewerId: actor.id, updatedAt: new Date()};
      this.repository.saveOperations("wallet_deposit", updated); this.log(actor, current.merchantId, "wallet.deposit." + updated.status, id);
      return updated;
    });
  }

  /** Called inside order transaction: do not trust a partner's claimed retail payment. */
  purchase(order: Order): Order {
    this.reconcileEarnings(order.merchantId);
    if (this.totals(order.merchantId).earnings < 0n) throw new AppError(409, "wallet_debt", "存在收益冲减欠额，暂不能继续采购");
    const merchant = this.repository.findMerchantById(order.merchantId);
    if (!merchant || merchant.status !== "active") throw new AppError(403, "merchant_inactive", "代理商不可采购");
    const modes = this.repository.getOperations("agent_profile", order.merchantId)?.collectionModes ?? ["platform_collect"];
    if (!modes.includes("agent_collect")) throw new AppError(403, "collection_mode_denied", "平台尚未为此代理启用自收款采购");
    if (this.totals(order.merchantId).procurement < order.supplyAmountMinor) throw new AppError(409, "procurement_balance_insufficient", "采购余额不足");
    this.entry(order.merchantId, "purchase:" + order.id, "purchase", -order.supplyAmountMinor, 0n, 0n, order.id, "partner-api");
    const paid: Order = {...order, paymentStatus: "paid", paymentProviderRef: "wallet:" + order.id, paymentReceivedMinor: order.supplyAmountMinor, paymentFeeMinor: 0n, paidAt: new Date(), updatedAt: new Date()};
    this.repository.updateOrder(paid);
    const attempt = this.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    this.repository.updatePaymentAttempt({...attempt, provider: "agent_wallet", status: "paid", providerRef: paid.paymentProviderRef,
      requestedMinor: order.supplyAmountMinor, receivedMinor: order.supplyAmountMinor, feeMinor: 0n, paidAt: paid.paidAt, updatedAt: new Date()});
    this.webhooks.emit(order.merchantId, order.id + ":order.paid", "order.paid", order.id,
      {event: "order.paid", order_id: order.id, merchant_order_no: order.merchantOrderNo, collection_mode: "agent_collect", payment_scope: "procurement"});
    return paid;
  }
  refundPurchase(actor: Actor, orderId: string): Order {
    requirePermission(actor, "wallet.review");
    return this.repository.transaction(() => {
      const order = this.repository.findOrderInternal(orderId);
      if (!order || order.collectionMode !== "agent_collect") throw new AppError(404, "procurement_order_not_found", "采购订单不存在");
      if (this.repository.getOperations("wallet_entry", "purchase_refund:" + orderId)) return order;
      if ((this.repository.getOperations("order_cost",orderId)?.paidUsdMinor??0n)>0n)throw new AppError(409,"cost_payment_conflict","本单已有真实补差付款，须先核对，不能重复退款");
      const voucher = this.repository.findCdkVoucherByOrder(orderId);
      if (order.paymentStatus !== "paid" || this.repository.listFulfillments(order.merchantId, orderId).some(f => ["queued", "running", "succeeded"].includes(f.status))
          || (voucher && !["failed", "disabled"].includes(voucher.status))) throw new AppError(409, "procurement_refund_blocked", "采购订单已履约、处理中或兑换码仍有效，不能退采购余额");
      this.entry(order.merchantId, "purchase_refund:" + orderId, "purchase_refund", order.supplyAmountMinor, 0n, 0n, orderId, actor.id);
      const refunded: Order = {...order, paymentStatus: "refunded", ordinaryRefundedMinor: order.supplyAmountMinor, updatedAt: new Date()};
      this.repository.updateOrder(refunded);
      const attempt = this.repository.findPaymentAttemptByOrder(order.merchantId, orderId)!;
      this.repository.updatePaymentAttempt({...attempt, status: "refunded", updatedAt: new Date()});
      this.webhooks.emit(order.merchantId, order.id + ":procurement.refunded", "procurement.refunded", order.id, {event: "procurement.refunded", order_id: order.id, amount: minorToMoney(order.supplyAmountMinor)});
      this.log(actor, order.merchantId, "wallet.purchase.refund", orderId);
      return refunded;
    });
  }

  releaseEarning(actor: Actor, orderId: string): void {
    requirePermission(actor, "wallet.review");
    this.repository.transaction(() => {
      if (this.creditEarningLocked(orderId, actor.id)) {
        this.log(actor, this.repository.findOrderInternal(orderId)!.merchantId, "wallet.earning.release", orderId);
        return;
      }
      const order = this.repository.findOrderInternal(orderId);
      if (order && this.repository.getOperations("wallet_credit", orderId)) return;
      throw new AppError(409, "earning_not_releasable", "须为实际履约完成、无退款争议且未纳入旧结算的分销订单；测试单不可入账收益");
    });
  }

  /** Called when fulfillment succeeds — credits margin into withdrawable earnings immediately. */
  creditEarningOnFulfillmentSuccess(orderId: string): void {
    this.repository.transaction(() => {
      this.creditEarningLocked(orderId, "system");
    });
  }

  private creditEarningLocked(orderId: string, actorId: string): boolean {
    const order = this.repository.findOrderInternal(orderId);
    if (!order || !this.eligibleEarning(order) || order.settlementId) return false;
    if (this.repository.getOperations("wallet_credit", orderId)) return false;
    if (this.repository.listRefundsForOrder(order.merchantId, orderId).some(r => ["requested", "approved", "processing"].includes(r.status))) return false;
    const amount = positive(merchantMargin(order));
    if (amount <= 0n) return false;
    this.repository.saveOperations("wallet_credit", {id: orderId, orderId, merchantId: order.merchantId, recognizedMinor: amount, createdAt: new Date()}, true);
    this.entry(order.merchantId, "earning:" + orderId, "earning_release", 0n, amount, 0n, orderId, actorId);
    return true;
  }
  transfer(actor: Actor, merchantId: string, amount: string, requestKey: string): void {
    requirePermission(actor, "wallet.transfer"); requireTenantScope(actor, merchantId);
    const value = requirePositive(amount); const id = "transfer:" + merchantId + ":" + requestKey;
    this.repository.transaction(() => {
      this.reconcileEarnings(merchantId);
      const existing = this.repository.getOperations("wallet_entry", id);
      if (existing) { if (existing.procurementDelta !== value) throw new AppError(409, "transfer_conflict", "划转号已使用"); return; }
      this.assertNoPendingRefund(merchantId);
      if (this.totals(merchantId).earnings < value) throw new AppError(409, "earnings_insufficient", "可用收益不足");
      this.entry(merchantId, id, "transfer", value, -value, 0n, requestKey, actor.id); this.log(actor, merchantId, "wallet.transfer", id);
    });
  }
  requestWithdrawal(actor: Actor, merchantId: string, amount: string, requestKey: string, payout: {method: "alipay" | "bank"; account: string; name: string}): WalletWithdrawal {
    requirePermission(actor, "wallet.withdraw"); requireTenantScope(actor, merchantId);
    const amountMinor = requirePositive(amount);
    const payoutAccount = payout.account.trim();
    const payoutName = payout.name.trim();
    if (payoutName.length < 2 || payoutName.length > 80) throw new AppError(422, "invalid_payout_name", "收款户名无效");
    if (payoutAccount.length < 4 || payoutAccount.length > 120) throw new AppError(422, "invalid_payout_account", "收款账号无效");
    return this.repository.transaction(() => {
      this.reconcileEarnings(merchantId);
      const id = merchantId + ":" + requestKey;
      const existing = this.repository.getOperations("wallet_withdrawal", id);
      if (existing) {
        if (existing.amountMinor !== amountMinor || existing.payoutMethod !== payout.method || existing.payoutAccount !== payoutAccount || existing.payoutName !== payoutName) throw new AppError(409, "withdrawal_conflict", "提现申请号已使用");
        return existing;
      }
      this.assertNoPendingRefund(merchantId);
      if (this.totals(merchantId).earnings < amountMinor) throw new AppError(409, "earnings_insufficient", "可提现收益不足");
      const value: WalletWithdrawal = {id, merchantId, amountMinor, requestKey, requestedBy: actor.id, reviewerId: null, payoutReference: null, status: "requested", reason: "",
        payoutMethod: payout.method, payoutAccount, payoutName, createdAt: new Date(), updatedAt: new Date()};
      this.repository.saveOperations("wallet_withdrawal", value, true);
      this.entry(merchantId, "withdraw_hold:" + id, "withdraw_hold", 0n, -amountMinor, amountMinor, id, actor.id);
      this.log(actor, merchantId, "wallet.withdraw.request", id);
      return value;
    });
  }
  reviewWithdrawal(actor: Actor, id: string, action: "approve" | "reject" | "paid", reference: string): WalletWithdrawal {
    requirePermission(actor, "wallet.review");
    if (action === "paid") reference = reference.trim().toLowerCase();
    return this.repository.transaction(() => {
      const current = this.repository.getOperations("wallet_withdrawal", id);
      if (!current) throw new AppError(404, "withdrawal_not_found", "提现申请不存在");
      this.reconcileEarnings(current.merchantId);
      if (current.status === "paid" && action === "paid" && current.payoutReference === reference) return current;
      if (!["requested", "approved"].includes(current.status)) throw new AppError(409, "withdrawal_final", "提现申请已终结");
      if (action !== "reject") this.assertNoPendingRefund(current.merchantId);
      if (action !== "reject" && this.totals(current.merchantId).earnings < 0n) throw new AppError(409, "wallet_debt", "存在退款冲减欠额，请先处理");
      let updated: WalletWithdrawal;
      if (action === "approve") {
        if (current.status !== "requested") throw new AppError(409, "withdrawal_approved", "已审核，请勿重复审核");
        updated = {...current, status: "approved", reviewerId: actor.id};
      } else if (action === "reject") {
        this.entry(current.merchantId, "withdraw_release:" + id, "withdraw_release", 0n, current.amountMinor, -current.amountMinor, id, actor.id);
        updated = {...current, status: "rejected", reason: reference};
      } else {
        // Single reviewer may approve then confirm payout (or jump from requested → paid).
        if (!["requested", "approved"].includes(current.status)) {
          throw new AppError(409, "withdrawal_final", "提现申请已终结");
        }
        if (reference.trim().length < 6 || this.repository.listOperations("wallet_withdrawal").some(w => w.payoutReference === reference && w.id !== id)) {
          throw new AppError(409, "invalid_payout_reference", "打款流水无效或已使用");
        }
        if (current.status === "requested") {
          // freeze already applied on request; mark reviewed + paid in one step
        }
        this.entry(current.merchantId, "withdraw_paid:" + id, "withdraw_paid", 0n, 0n, -current.amountMinor, reference, actor.id);
        updated = {...current, status: "paid", reviewerId: current.reviewerId ?? actor.id, payoutReference: reference};
      }
      updated.updatedAt = new Date(); this.repository.saveOperations("wallet_withdrawal", updated); this.log(actor, current.merchantId, "wallet.withdraw." + action, id);
      return updated;
    });
  }
  private eligibleEarning(order: Order): boolean {
    return order.collectionMode !== "agent_collect" && !order.liveTest && ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)
      && ["alipay_page", "dujiaopay"].includes(this.repository.findPaymentAttemptByOrder(order.merchantId, order.id)?.provider ?? "")
      && this.repository.listFulfillments(order.merchantId, order.id).some(f => f.status === "succeeded" && !!f.upstreamProvider && f.upstreamProvider !== "mock");
  }

  private pendingEarningOrders(merchantId: string): Order[] {
    if(this.repository.pendingEarningOrders)return this.repository.pendingEarningOrders(merchantId);
    return this.repository.listOrders(merchantId)
      .filter((order) => this.eligibleEarning(order) && !this.repository.getOperations("wallet_credit", order.id) && positive(merchantMargin(order)) > 0n)
      .sort((a, b) => (b.paidAt ?? b.createdAt).getTime() - (a.paidAt ?? a.createdAt).getTime());
  }

  reconcileOrderEarnings(orderId: string): void {
    const order = this.repository.findOrderInternal(orderId);
    if (order) this.repository.transaction(() => this.reconcileEarnings(order.merchantId, orderId));
  }

  adjustBalance(actor: Actor, merchantId: string, input: {account: "procurement" | "earnings"; direction: "credit" | "debit"; amount: string; reason: string; requestKey: string; expectedBalance: string}) {
    if (actor.role !== "platform_admin" || actor.merchantId !== null) throw new AppError(403, "permission_denied", "仅平台管理员可调整余额");
    const amount = requirePositive(input.amount), reason = input.reason.trim();
    if (reason.length < 4 || reason.length > 500) throw new AppError(422, "adjustment_reason_required", "请填写 4 至 500 字的调整原因");
    const delta = input.direction === "credit" ? amount : -amount;
    const id = "adjustment:" + merchantId + ":" + input.requestKey;
    return this.repository.transaction(() => {
      if (!this.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
      const old = this.repository.getOperations("wallet_entry", id);
      if (old) {
        if (old.adjustmentAccount !== input.account || old.reason !== reason || (input.account === "procurement" ? old.procurementDelta : old.earningsDelta) !== delta) {
          throw new AppError(409, "adjustment_conflict", "调整编号已用于不同请求");
        }
        return old;
      }
      const totals = this.totals(merchantId), before = totals[input.account];
      const expected = input.expectedBalance.startsWith("-") ? -moneyToMinor(input.expectedBalance.slice(1)) : moneyToMinor(input.expectedBalance);
      if (before !== expected) throw new AppError(409, "wallet_balance_changed", "余额已变动，请刷新并重新确认调整");
      if (delta < 0n && before + delta < 0n) throw new AppError(409, "wallet_balance_insufficient", "扣减金额超过可用余额");
      const entry: WalletEntry = {id, merchantId, kind: "adjustment", procurementDelta: input.account === "procurement" ? delta : 0n,
        earningsDelta: input.account === "earnings" ? delta : 0n, frozenDelta: 0n, reference: input.requestKey, actorId: actor.id,
        reason, adjustmentAccount: input.account, beforeMinor: before, afterMinor: before + delta, createdAt: new Date()};
      this.repository.saveOperations("wallet_entry", entry, true);
      this.log(actor, merchantId, "wallet.balance.adjust", id);
      return entry;
    });
  }

  reconcileMerchantEarnings(merchantId: string): void {
    this.repository.transaction(() => this.reconcileEarnings(merchantId));
  }

  private reconcileEarnings(merchantId: string, onlyOrderId?: string): void {
    // Auto-credit any succeeded retail orders so agents can withdraw without a platform release step.
    for (const order of this.pendingEarningOrders(merchantId).filter(item => !onlyOrderId || item.id === onlyOrderId)) {
      this.creditEarningLocked(order.id, "system");
    }
    for (const credit of this.repository.listOperations("wallet_credit", merchantId).filter(item => !onlyOrderId || item.orderId === onlyOrderId)) {
      const order = this.repository.findOrder(merchantId, credit.orderId);
      const target = order && this.eligibleEarning(order) ? positive(merchantMargin(order)) : 0n;
      if (target >= credit.recognizedMinor) continue;
      this.entry(merchantId, "earning_reversal:" + credit.id + ":" + target, "earning_reversal", 0n, target - credit.recognizedMinor, 0n, credit.orderId, "system");
      this.repository.saveOperations("wallet_credit", {...credit, recognizedMinor: target});
    }
  }
  private totals(merchantId: string) {
    if(this.repository.walletTotals)return this.repository.walletTotals(merchantId);
    return this.repository.listOperations("wallet_entry", merchantId).reduce((x, e) => ({procurement: x.procurement + e.procurementDelta, earnings: x.earnings + e.earningsDelta, frozen: x.frozen + e.frozenDelta}), {procurement: 0n, earnings: 0n, frozen: 0n});
  }
  private assertNoPendingRefund(merchantId: string): void {
    if (this.repository.listOperations("wallet_credit", merchantId).some(c => this.repository.listRefundsForOrder(merchantId, c.orderId)
      .some(r => ["requested", "approved", "processing"].includes(r.status)))) throw new AppError(409, "earnings_refund_pending", "已释放收益的订单有退款待确认，暂不能划转或提现");
  }
  private entry(merchantId: string, id: string, kind: WalletEntry["kind"], procurementDelta: bigint, earningsDelta: bigint, frozenDelta: bigint, reference: string, actorId: string) {
    this.repository.saveOperations("wallet_entry", {id, merchantId, kind, procurementDelta, earningsDelta, frozenDelta, reference, actorId, createdAt: new Date()}, true);
  }
  private log(actor: Actor, merchantId: string, action: string, targetId: string) {
    this.audit.record({merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user", action, targetType: "wallet", targetId, requestId: randomUUID()});
  }
}
function positive(value: bigint): bigint { return value > 0n ? value : 0n; }
function requirePositive(amount: string): bigint {
  const value = moneyToMinor(amount);
  if (value <= 0n || value > 100_000_000n) throw new AppError(422, "wallet_amount_invalid", "金额必须大于 0 且不超过 100 万元");
  return value;
}

type DayBucket = {
  day: string;
  paidOrders: number;
  platformCollectOrders: number;
  agentCollectOrders: number;
  succeededOrders: number;
  saleAmountMinor: bigint;
  supplyAmountMinor: bigint;
  ordinaryRefundedMinor: bigint;
  priceAdjustmentRefundedMinor: bigint;
  marginMinor: bigint;
  agentCollectSupplyMinor: bigint;
};

function emptyDay(day: string): DayBucket {
  return {
    day, paidOrders: 0, platformCollectOrders: 0, agentCollectOrders: 0, succeededOrders: 0,
    saleAmountMinor: 0n, supplyAmountMinor: 0n, ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n,
    marginMinor: 0n, agentCollectSupplyMinor: 0n,
  };
}

function serializeDay(bucket: DayBucket) {
  const refunded = bucket.ordinaryRefundedMinor + bucket.priceAdjustmentRefundedMinor;
  const netSale = bucket.saleAmountMinor > refunded ? bucket.saleAmountMinor - refunded : 0n;
  return {
    day: bucket.day,
    paidOrders: bucket.paidOrders,
    platformCollectOrders: bucket.platformCollectOrders,
    agentCollectOrders: bucket.agentCollectOrders,
    succeededOrders: bucket.succeededOrders,
    saleAmount: minorToMoney(bucket.saleAmountMinor),
    refundedAmount: minorToMoney(refunded),
    netSaleAmount: minorToMoney(netSale),
    supplyAmount: minorToMoney(bucket.supplyAmountMinor),
    marginAmount: minorToMoney(bucket.marginMinor),
    agentCollectSupplyAmount: minorToMoney(bucket.agentCollectSupplyMinor),
  };
}

function shanghaiDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function shanghaiDayOffset(dayKey: string, offsetDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const utc = Date.UTC(y!, m! - 1, d! + offsetDays, 4, 0, 0); // noon-ish CST as UTC+8 stable
  return shanghaiDayKey(new Date(utc));
}
