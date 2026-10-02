import type {CdkVoucher, Fulfillment, Order} from "../domain/model.js";
import type {CdkService} from "../modules/cdk-service.js";
import {merchantMargin, minorToMoney} from "../domain/money.js";
import {AppError} from "../domain/errors.js";
import type {Repository} from "../infra/repository.js";
import {managedGptProducts} from "../modules/gpt-products.js";
import {partnerFulfillmentDetails, partnerFulfillmentMessage, partnerFulfillmentProgress, platformFulfillmentDetails} from "../modules/fulfillment-public.js";
import {canResubmitFulfillment, isConfirmedUnsuccessfulFulfillment} from "../domain/recharge-policy.js";
import {orderSyncMark, type OrderSyncMark} from "../domain/order-sync-mark.js";
import type {Actor, OrderVisibilityField} from "./model.js";
import {isPlatform} from "./accounts.js";
import {queryRecords, type RecordPage} from "../infra/record-query.js";
import {manualCompletionBlock} from "./manual-completion.js";

export function workspacePayUrl(order: Order): string | null {
  return order.paymentStatus === "pending" ? order.qrPayload : null;
}

export interface WorkspaceOrderTrace {
  merchantOrderNo: string;
  platformOrderId: string;
  voucherCode: string | null;
  upstreamCdkId: string | null;
  upstreamCdkCode: string | null;
  fulfillmentReference: string | null;
}

export interface WorkspaceOrderRow {
  id: string;
  merchantId: string;
  merchantName: string | null;
  merchantOrderNo: string;
  productCode: string;
  collectionMode: "platform_collect" | "agent_collect";
  paymentStatus: Order["paymentStatus"];
  saleAmount: string;
  supplyAmount: string;
  payUrl: string | null;
  fulfillmentUrl: string;
  deliveryMode: "auto_recharge" | "cdk";
  voucherCode: string | null;
  fallbackRechargeAvailable: boolean;
  fulfillmentStatus: Fulfillment["status"] | null;
  completionSource: "manual" | null;
  syncMark: OrderSyncMark | null;
  fulfillment: Record<string, unknown> | null;
  trace: WorkspaceOrderTrace;
  createdAt: Date;
}

export interface WorkspaceOrderListMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
  /** Paid / partially_refunded / refunded count in the filtered set. */
  paidCount: number;
  /** Gross sale amount of paid-family orders in the filtered set. */
  paidSaleAmount: string;
  /** Paid-family orders with paidAt on Asia/Shanghai today. */
  todayPaidCount: number;
  todayPaidSaleAmount: string;
}

function matchesProductFilter(orderProductCode: string, filter?: string): boolean {
  if (!filter) return true;
  if (orderProductCode === filter) return true;
  const managed = managedGptProducts.find(item => item.productCode === filter);
  return managed?.legacyProductCode === orderProductCode;
}

function mapWorkspaceOrder(
  order: Order,
  merchantName: string | null,
  fulfillment: Fulfillment | undefined,
  voucher: CdkVoucher | null,
  actor: Actor,
  visibility: OrderVisibilityField[],
): WorkspaceOrderRow {
  const deliveryMode = order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
  const details = fulfillment
    ? {
      status: fulfillment.status,
      retryAllowed: canResubmitFulfillment(fulfillment),
      ...partnerFulfillmentProgress(fulfillment),
      failureCode: fulfillment.failureCode,
      message: isPlatform(actor) ? fulfillment.message : partnerFulfillmentMessage(fulfillment),
      ...(isPlatform(actor) ? platformFulfillmentDetails(fulfillment) : partnerFulfillmentDetails(fulfillment, visibility)),
    } as Record<string, unknown>
    : null;
  return {
    id: order.id,
    merchantId: order.merchantId,
    merchantName,
    merchantOrderNo: order.merchantOrderNo,
    productCode: order.productCode,
    collectionMode: order.collectionMode ?? "platform_collect",
    paymentStatus: order.paymentStatus,
    saleAmount: minorToMoney(order.saleAmountMinor),
    supplyAmount: minorToMoney(order.supplyAmountMinor),
    payUrl: workspacePayUrl(order),
    fulfillmentUrl: order.fulfillmentUrl,
    deliveryMode,
    voucherCode: deliveryMode === "cdk" ? order.voucherCode : null,
    fallbackRechargeAvailable: Boolean(order.fallbackRechargeAvailable),
    fulfillmentStatus: fulfillment?.status ?? null,
    completionSource: fulfillment?.completionSource ?? null,
    syncMark: orderSyncMark(order.paymentStatus, fulfillment),
    fulfillment: details,
    trace: {
      merchantOrderNo: order.merchantOrderNo,
      platformOrderId: order.id,
      voucherCode: isPlatform(actor) || deliveryMode === "cdk"
        ? order.voucherCode ?? voucher?.publicCode ?? null
        : null,
      upstreamCdkId: isPlatform(actor) ? voucher?.upstreamCdkId ?? null : null,
      upstreamCdkCode: null,
      fulfillmentReference: isPlatform(actor)
        ? fulfillment?.upstreamOrderId ?? null
        : visibility.includes("upstream_order_id") && fulfillment?.completionSource !== "manual" ? fulfillment?.upstreamOrderId ?? null : null,
    },
    createdAt: order.createdAt,
  };
}

function maskEmailForSearch(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local[0] ?? "*"}***${local.length > 1 ? local.at(-1) : ""}@${domain}`;
}

function looksLikeEmail(value: string): boolean {
  return value.includes("@") && value.indexOf("@") === value.lastIndexOf("@");
}

function matchesOrderSearch(
  order: Order,
  voucher: CdkVoucher | null,
  fulfillment: Fulfillment | undefined,
  needle: string,
  includeSupplierTrace: boolean,
): boolean {
  const maskedEmail = fulfillment?.accountEmailMasked?.toLowerCase() ?? "";
  const haystack = [
    order.id,
    order.merchantOrderNo,
    order.voucherCode ?? "",
    voucher?.publicCode ?? "",
    ...(includeSupplierTrace ? [voucher?.upstreamCdkId ?? "", fulfillment?.upstreamOrderId ?? ""] : []),
    maskedEmail,
  ].join("\n").toLowerCase();
  if (haystack.includes(needle)) return true;
  if (looksLikeEmail(needle)) {
    const masked = maskEmailForSearch(needle);
    if (masked && maskedEmail === masked.toLowerCase()) return true;
  }
  return false;
}

export function readUpstreamCdkCode(cdk: CdkService, voucher: CdkVoucher): string | null {
  try {
    const code = cdk.readUpstreamCode(voucher);
    return code || null;
  } catch {
    return null;
  }
}

export function platformOrderTrace(
  repository: Repository,
  cdk: CdkService,
  orderId: string,
): {upstreamCdkId: string | null; upstreamCdkCode: string | null} {
  const voucher = repository.findCdkVoucherByOrder(orderId);
  return {
    upstreamCdkId: voucher?.upstreamCdkId ?? null,
    upstreamCdkCode: voucher?.upstreamCdkId ? readUpstreamCdkCode(cdk, voucher) : null,
  };
}

export function listWorkspaceOrders(
  repository: Repository,
  actor: Actor,
  merchantIds: string[],
  merchantNames: Map<string, string>,
  visibilityFor: (merchantId: string) => OrderVisibilityField[],
  query: {productCode?: string; search?: string; status?: string; createdFrom?: string; createdTo?: string; paidFrom?: string; paidTo?: string; page: number; limit: number},
): {data: WorkspaceOrderRow[]; meta: WorkspaceOrderListMeta} {
  const search = query.search?.trim().toLowerCase() ?? "";
  if (repository.queryWorkspaceOrders) {
    const product=managedGptProducts.find(p=>p.productCode===query.productCode);
    const result=repository.queryWorkspaceOrders(merchantIds,{...query,search,today:shanghaiDayKey(new Date()),includeSupplierTrace:isPlatform(actor),
      ...(query.productCode?{productCodes:[query.productCode,...(product?.legacyProductCode?[product.legacyProductCode]:[])]}:{})});
    const tasks=new Map(result.fulfillments.map(f=>[f.orderId,f])),vouchers=new Map(result.vouchers.map(v=>[v.orderId,v]));
    return {data:result.orders.map(o=>mapWorkspaceOrder(o,merchantNames.get(o.merchantId)??null,tasks.get(o.id),vouchers.get(o.id)??null,actor,visibilityFor(o.merchantId))),
      meta:{total:result.meta.total,page:result.meta.page,limit:result.meta.limit,pages:result.meta.pages,
        paidCount:result.meta.paidCount,paidSaleAmount:minorToMoney(result.meta.paidSaleMinor),todayPaidCount:result.meta.todayPaidCount,todayPaidSaleAmount:minorToMoney(result.meta.todayPaidSaleMinor)}};
  }
  const batch = repository.listWorkspaceRecords?.(merchantIds);
  const tasks = new Map<string, Fulfillment>();
  const vouchers = new Map<string, CdkVoucher>();
  for (const task of batch?.fulfillments ?? []) {
    const previous = tasks.get(task.orderId);
    if (!previous || previous.attemptNo < task.attemptNo) tasks.set(task.orderId, task);
  }
  for (const voucher of batch?.vouchers ?? []) vouchers.set(voucher.orderId, voucher);
  const taskFor = (o: Order) => batch ? tasks.get(o.id) : repository.listFulfillments(o.merchantId, o.id).at(-1);
  const voucherFor = (o: Order) => batch ? vouchers.get(o.id) ?? null : repository.findCdkVoucherByOrder(o.id);
  const orders = (batch?.orders ?? merchantIds.flatMap(merchantId => repository.listOrders(merchantId)))
    .filter(order => !order.archivedAt)
    .filter(order => !query.createdFrom || order.createdAt.toISOString() >= query.createdFrom)
    .filter(order => !query.createdTo || order.createdAt.toISOString() < query.createdTo)
    .filter(order => !query.paidFrom || !!order.paidAt && order.paidAt.toISOString() >= query.paidFrom)
    .filter(order => !query.paidTo || !!order.paidAt && order.paidAt.toISOString() < query.paidTo)
    .filter(order => matchesProductFilter(order.productCode, query.productCode))
    .filter(order => {
      const status = query.status ?? "all";
      const task = taskFor(order);
      if (status === "pending") return order.paymentStatus === "pending";
      if (status === "paid") return ["paid", "partially_refunded"].includes(order.paymentStatus) && !["succeeded", "failed"].includes(task?.status ?? "");
      if (status === "running") return task?.status === "queued" || task?.status === "running";
      if (status === "succeeded") return task?.status === "succeeded";
      if (status === "failed") return task?.status === "failed" || voucherFor(order)?.status === "failed";
      if (status === "refunded") return order.paymentStatus === "refunded";
      return true;
    })
    .filter(order => {
      if (!search) return true;
      const voucher = voucherFor(order);
      const fulfillment = taskFor(order);
      return matchesOrderSearch(order, voucher ?? null, fulfillment, search, isPlatform(actor));
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const total = orders.length;
  const pages = Math.max(1, Math.ceil(total / query.limit));
  const page = Math.min(query.page, pages);
  const start = (page - 1) * query.limit;
  const slice = orders.slice(start, start + query.limit);
  const todayKey = shanghaiDayKey(new Date());
  let paidCount = 0;
  let paidSaleMinor = 0n;
  let todayPaidCount = 0;
  let todayPaidSaleMinor = 0n;
  for (const order of orders) {
    if (!["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)) continue;
    paidCount += 1;
    paidSaleMinor += order.saleAmountMinor;
    if (order.paidAt && shanghaiDayKey(order.paidAt) === todayKey) {
      todayPaidCount += 1;
      todayPaidSaleMinor += order.saleAmountMinor;
    }
  }
  return {
    data: slice.map(order => {
      const voucher = voucherFor(order);
      return mapWorkspaceOrder(
        order,
        merchantNames.get(order.merchantId) ?? null,
        taskFor(order),
        voucher ?? null,
        actor,
        visibilityFor(order.merchantId),
      );
    }),
    meta: {
      total, page, limit: query.limit, pages,
      paidCount,
      paidSaleAmount: minorToMoney(paidSaleMinor),
      todayPaidCount,
      todayPaidSaleAmount: minorToMoney(todayPaidSaleMinor),
    },
  };
}

const shanghaiDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
function shanghaiDayKey(date: Date): string {
  return shanghaiDayFormatter.format(date);
}

export function workspaceOrderDetail(
  repository: Repository,
  actor: Actor,
  orderId: string,
  visibility: OrderVisibilityField[],
  merchantName: string | null,
): Record<string, unknown> {
  const order = isPlatform(actor)
    ? repository.findOrderInternal(orderId)
    : (actor.merchantId ? repository.findOrder(actor.merchantId, orderId) : null);
  if (!order) throw new AppError(404, "order_not_found", "订单不存在");
  const voucher = repository.findCdkVoucherByOrder(order.id) ?? null;
  const fulfillments = repository.listFulfillments(order.merchantId, order.id)
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const latest = fulfillments.at(-1);
  const manualCompletion = repository.getOperations("manual_completion", order.id);
  const row = mapWorkspaceOrder(order, merchantName, latest, voucher, actor, visibility);
  const refundRecords = repository.listRefundsForOrder(order.merchantId, order.id)
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const refunds = refundRecords.map(refund => ({
      id: refund.id,
      type: refund.type,
      amount: minorToMoney(refund.amountMinor),
      status: refund.status,
      reason: refund.reason,
      failureCode: refund.failureCode,
      providerRefundNo: refund.providerRefundNo ?? null,
      createdAt: refund.createdAt.toISOString(),
      refundedAt: refund.refundedAt?.toISOString() ?? null,
      cancelledReview: isPlatform(actor) ? refund.cancelledReview ?? null : null,
    }));
  const reservedMinor = refundRecords
    .filter(item => !["rejected", "cancelled"].includes(item.status))
    .reduce((sum, item) => sum + item.amountMinor, 0n);
  const refundableMinor = order.saleAmountMinor > reservedMinor ? order.saleAmountMinor - reservedMinor : 0n;
  const canRefundCustomer = isPlatform(actor)
    && (order.collectionMode ?? "platform_collect") === "platform_collect"
    && ["paid", "partially_refunded"].includes(order.paymentStatus)
    && refundableMinor > 0n
    && !fulfillments.some(item => ["queued", "running", "succeeded"].includes(item.status))
    && (
      !(voucher && !["failed", "disabled", "consumed"].includes(voucher.status))
      || fulfillments.some(item => ["failed", "cancelled"].includes(item.status))
    );
  const canRecordExternalRefund = isPlatform(actor)
    && (order.collectionMode ?? "platform_collect") === "platform_collect"
    && ["paid", "partially_refunded"].includes(order.paymentStatus)
    && refundableMinor > 0n;
  const attempt = repository.findPaymentAttemptByOrder(order.merchantId, order.id);
  const marginMinor = merchantMargin(order);
  const canPriceAdjust = isPlatform(actor)
    && (order.collectionMode ?? "platform_collect") === "platform_collect"
    && ["paid", "partially_refunded"].includes(order.paymentStatus)
    && refundableMinor > 0n;
  return {
    ...row,
    ...(isPlatform(actor) ? {cdkDiagnostic: voucher?.diagnostic ?? null} : {}),
    paidAt: order.paidAt?.toISOString() ?? null,
    ordinaryRefunded: minorToMoney(order.ordinaryRefundedMinor),
    priceAdjustmentRefunded: minorToMoney(order.priceAdjustmentRefundedMinor),
    margin: minorToMoney(marginMinor),
    refundableAmount: minorToMoney(refundableMinor),
    canRefundCustomer,
    canRecordExternalRefund,
    canPriceAdjust,
    canRecordManualCompletion: isPlatform(actor) && actor.role === "platform_admin" && manualCompletionBlock(repository, order) === null,
    manualCompletion: manualCompletion ? isPlatform(actor) ? {
      completedAt:manualCompletion.completedAt.toISOString(), externalOrderRef:manualCompletion.externalOrderRef,
      evidence:manualCompletion.evidence, reason:manualCompletion.reason, actorId:manualCompletion.actorId,
      registeredAt:manualCompletion.createdAt.toISOString(), fulfillmentId:manualCompletion.fulfillmentId,
    } : {completedAt:manualCompletion.completedAt.toISOString()} : null,
    canResolveRecharge: isPlatform(actor) && !!latest && ["paid", "partially_refunded"].includes(order.paymentStatus)
      && order.ordinaryRefundedMinor === 0n && !refundRecords.some(refund => ["requested", "approved", "processing"].includes(refund.status))
      && !fulfillments.some(task => task.id !== latest.id && ["queued", "running", "succeeded"].includes(task.status))
      && ((latest.status === "queued" && !latest.leaseToken && !latest.upstreamOrderId) || isConfirmedUnsuccessfulFulfillment(latest)),
    latestFulfillmentId: latest?.id ?? null,
    payment: {
      provider: attempt?.provider ?? null,
      status: attempt?.status ?? null,
      providerRef: order.paymentProviderRef ?? attempt?.providerRef ?? null,
      receivedAmount: minorToMoney(attempt?.receivedMinor ?? order.paymentReceivedMinor ?? 0n),
      paidAt: order.paidAt?.toISOString() ?? attempt?.paidAt?.toISOString() ?? null,
    },
    timeline: {
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      fulfillmentSubmittedAt: fulfillments[0]?.createdAt.toISOString() ?? null,
      fulfillmentFinishedAt: latest?.finishedAt?.toISOString() ?? null,
      fulfillmentStatus: latest?.status ?? null,
      manualCompletedAt: manualCompletion?.completedAt.toISOString() ?? null,
    },
    fulfillments: fulfillments.map((item, index) => ({
      id: item.id,
      attemptNo: index + 1,
      status: item.status,
      completionSource:item.completionSource ?? null,
      failureCode: item.failureCode,
      message: isPlatform(actor) ? item.message : partnerFulfillmentMessage(item),
      ...partnerFulfillmentProgress(item),
      accountEmailMasked: item.accountEmailMasked,
      upstreamOrderId: isPlatform(actor) || (visibility.includes("upstream_order_id") && item.completionSource !== "manual") ? item.upstreamOrderId : null,
      createdAt: item.createdAt.toISOString(),
      finishedAt: item.finishedAt?.toISOString() ?? null,
      updatedAt: (item.progressUpdatedAt ?? item.finishedAt ?? item.createdAt).toISOString(),
      ...(isPlatform(actor) ? platformFulfillmentDetails(item) : partnerFulfillmentDetails(item, visibility)),
    })),
    refunds,
  };
}

export interface WorkspaceOrderAuditRow {
  action: string;
  actorId: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

export function workspaceOrderAudit(
  repository: Repository,
  actor: Actor,
  orderId: string,
  page: number,
  limit: number,
): RecordPage<WorkspaceOrderAuditRow> {
  if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权查看平台操作审计");
  const order = repository.findOrderInternal(orderId);
  if (!order) throw new AppError(404, "order_not_found", "订单不存在");
  const targetIds = [
    order.id,
    ...repository.listRefundsForOrder(order.merchantId, order.id).map(item => item.id),
    ...repository.listFulfillments(order.merchantId, order.id).map(item => item.id),
  ];
  const result = queryRecords(repository, "audit", {
    merchantId: order.merchantId,
    filters: [{field: "targetId", op: "in", value: targetIds}],
    page,
    limit,
    orderBy: "createdAt",
    direction: "desc",
  });
  return {
    data: result.data.map(item => ({
      action: item.action,
      actorId: item.actorId,
      targetType: item.targetType,
      targetId: item.targetId,
      createdAt: item.createdAt.toISOString(),
    })),
    meta: result.meta,
  };
}
