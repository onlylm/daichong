import type {Repository} from "../infra/repository.js";
import type {Actor} from "./model.js";
import {isPlatform, requirePermission} from "./accounts.js";
import {AppError} from "../domain/errors.js";
import {merchantMargin, minorToMoney} from "../domain/money.js";
import {latestFulfillmentOf} from "../domain/order-sync-mark.js";

export const financeMetrics = ["paid_orders","platform_orders","receipts","net_receipts","refunds","succeeded","margin","procurement"] as const;
export type FinanceMetric = typeof financeMetrics[number];
export function financeDrilldown(repo: Repository, actor: Actor, q: {day:string;metric:FinanceMetric;page:number;limit:number}) {
  requirePermission(actor,"wallet.read");
  if(!isPlatform(actor))throw new AppError(403,"permission_denied","仅平台可查看全平台对账明细");
  const from=new Date(q.day+"T00:00:00+08:00"),to=new Date(from.getTime()+86400000);
  if(!Number.isFinite(from.getTime())||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(from)!==q.day)
    throw new AppError(422,"finance_day_invalid","日期无效，请使用 YYYY-MM-DD");
  const merchants=new Map(repo.listMerchants().map(m=>[m.id,m]));
  const collectionMode=q.metric==="procurement"?"agent_collect":["paid_orders","succeeded"].includes(q.metric)?undefined:"platform_collect";
  const sql=repo.queryWorkspaceOrders?.([...merchants.keys()],{...q,today:q.day,paidFrom:from.toISOString(),paidTo:to.toISOString(),
    ...(collectionMode?{collectionMode}:{}),financeMetric:q.metric});
  const fallback=sql?null:repo.listOrdersInternal().filter(o=>!o.liveTest&&["paid","partially_refunded","refunded"].includes(o.paymentStatus)
    &&o.paidAt&&o.paidAt>=from&&o.paidAt<to&&(!collectionMode||(o.collectionMode??"platform_collect")===collectionMode)
    &&(q.metric!=="refunds"||o.ordinaryRefundedMinor+o.priceAdjustmentRefundedMinor>0n)
    &&(q.metric!=="margin"||merchantMargin(o)>0n)
    &&(q.metric!=="succeeded"||repo.listFulfillments(o.merchantId,o.id).some(f=>f.status==="succeeded")))
    .sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()||b.id.localeCompare(a.id));
  const pages=Math.max(1,Math.ceil((fallback?.length??0)/q.limit)),page=Math.min(q.page,pages);
  const orders=sql?.orders??fallback!.slice((page-1)*q.limit,page*q.limit);
  const tasks=new Map((sql?.fulfillments??[]).map(f=>[f.orderId,f]));
  return {day:q.day,metric:q.metric,timezone:"Asia/Shanghai",
    basis:"按该日付款订单统计其当前收款、退款及分佣；不是退款发生日或支付宝账单对账口径。分佣计算额不等于已入账收益。",
    meta:sql?{total:sql.meta.total,page:sql.meta.page,limit:sql.meta.limit,pages:sql.meta.pages}:{total:fallback!.length,page,limit:q.limit,pages},
    data:orders.map(o=>{
      const refunded=o.ordinaryRefundedMinor+o.priceAdjustmentRefundedMinor,margin=merchantMargin(o),credit=repo.getOperations("wallet_credit",o.id);
      const task=sql?tasks.get(o.id):latestFulfillmentOf(repo.listFulfillments(o.merchantId,o.id));
      return {orderId:o.id,merchantName:merchants.get(o.merchantId)?.name??"历史代理商",paidAt:o.paidAt,
        collectionMode:o.collectionMode??"platform_collect",paymentStatus:o.paymentStatus,fulfillmentStatus:task?.status??null,
        saleAmount:minorToMoney(o.saleAmountMinor),supplyAmount:minorToMoney(o.supplyAmountMinor),
        ordinaryRefunded:minorToMoney(o.ordinaryRefundedMinor),priceAdjustmentRefunded:minorToMoney(o.priceAdjustmentRefundedMinor),
        netReceipts:minorToMoney(o.saleAmountMinor>refunded?o.saleAmountMinor-refunded:0n),
        margin:minorToMoney(margin>0n?margin:0n),recognizedEarning:minorToMoney(credit?.recognizedMinor??0n)};
    })};
}
