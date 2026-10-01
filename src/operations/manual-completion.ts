import type {Order} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import type {Repository} from "../infra/repository.js";
import {queryRecords} from "../infra/record-query.js";
import {hasUnreconciledProviderRefund} from "../domain/provider-refund-review.js";
import {minorToMoney} from "../domain/money.js";
import {hasConfirmedOrderPayment} from "../domain/payment-confirmation.js";
import type {Actor, ManualCompletion} from "./model.js";
import type {FulfillmentService} from "../modules/fulfillment-service.js";
import type {CostAccountingService} from "./cost-accounting.js";
import type {AuditService} from "../modules/audit-service.js";

/** Never turn an uncertain supplier attempt into a local success. */
export function manualCompletionBlock(repo: Repository, order: Order): string | null {
  if (order.archivedAt || order.liveTest || order.paymentPurpose === "payment_test" || (order.deliveryMode ?? "cdk") !== "auto_recharge")
    return "仅正式自动充值订单可登记人工完成";
  if (!["paid", "partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor > 0n)
    return "订单未支付或已有普通退款";
  if (!order.paidAt) return "订单付款时间尚未确认，不能登记人工完成";
  if (!hasConfirmedOrderPayment(order, repo.findPaymentAttemptByOrder(order.merchantId, order.id)))
    return "订单收款记录尚未一致确认，不能登记人工完成";
  if (repo.getOperations("manual_completion", order.id)) return "该订单已登记人工完成";
  if (repo.listRefundsForOrder(order.merchantId, order.id).some(value => ["requested", "approved", "processing"].includes(value.status))
      || hasUnreconciledProviderRefund(repo, order.merchantId, order.id)) return "订单存在待处理退款或渠道退款差异";
  const attempts = repo.listFulfillments(order.merchantId, order.id);
  if (!attempts.length) return "尚无失败的自动充值记录，不能补记人工完成";
  if (attempts.some(value => value.status === "succeeded")) return "订单已完成充值，不能重复登记";
  if (attempts.some(value => !["failed", "cancelled"].includes(value.status) || !!value.leaseToken))
    return "仍有排队、运行中或结果未知的充值任务";
  if (attempts.some(value => {
    const result = value.upstreamStatus?.toLowerCase() ?? null;
    if (result) return !["declined", "failed_precharge", "cancelled"].includes(result);
    if (value.upstreamOrderId || value.upstreamProvider || value.upstreamLookupToken || value.lookupPayload?.ciphertext) return true;
    if (value.status === "cancelled") return value.failureCode !== "cancelled";
    return value.retryAllowed !== true || !["session_invalid", "mailbox_login_failed", "account_has_subscription",
      "precheck_rejected", "subscription_required", "account_unavailable", "order_rejected", "product_unavailable"].includes(value.failureCode ?? "");
  })) return "历史任务尚无明确失败或取消的服务端凭据，须先核实上游结果";
  const voucher = repo.findCdkVoucherByOrder(order.id);
  if (voucher && !["unused", "failed", "disabled"].includes(voucher.status))
    return "供应兑换码仍在签发、占用或停用核对中";
  if (repo.getOperations("wallet_credit", order.id)) return "已有代理收益入账，须先核对账本";
  return null;
}

export interface ManualCompletionInput {
  completedAt: Date;
  externalOrderRef: string;
  evidence: string;
  reason: string;
  cost?: {actualUsd: string; fxRate: string; sourceReference: string; evidence: string;
    destination: "customer_direct" | "platform_pass_through"};
}

export class ManualCompletionService {
  constructor(private readonly repo: Repository, private readonly fulfillments: FulfillmentService,
    private readonly costs: CostAccountingService, private readonly audit: AuditService) {}

  record(actor: Actor, orderId: string, input: ManualCompletionInput, requestId: string): ManualCompletion {
    if (actor.role !== "platform_admin" || actor.merchantId !== null)
      throw new AppError(403, "permission_denied", "仅平台管理员可登记人工完成");
    const externalOrderRef=input.externalOrderRef.trim(),evidence=input.evidence.trim(),reason=input.reason.trim();
    if(!/^[A-Za-z0-9:_.-]{6,120}$/.test(externalOrderRef)||evidence.length<6||evidence.length>1000||reason.length<4||reason.length>500)
      throw new AppError(422,"manual_evidence_required","须填写真实外部订单引用、凭证及补记原因");
    if(!Number.isFinite(input.completedAt.getTime()))throw new AppError(422,"completion_time_invalid","实际完成时间无效");
    return this.repo.transaction(() => {
      const order = this.repo.findOrderInternal(orderId);
      if (!order) throw new AppError(404, "order_not_found", "订单不存在");
      const existing = this.repo.getOperations("manual_completion", orderId);
      if (existing) throw new AppError(409, "manual_completion_exists", "该订单已登记人工完成，请核对原记录");
      const block = manualCompletionBlock(this.repo, order);
      if (block) throw new AppError(409, "manual_completion_blocked", block);
      const now = new Date();
      if (!order.paidAt || input.completedAt.getTime() < order.paidAt.getTime()
          || input.completedAt.getTime() > now.getTime())
        throw new AppError(422, "completion_time_invalid", "完成时间须在实际付款后且不得晚于当前时间");
      const attempts = this.repo.listFulfillments(order.merchantId, order.id);
      const lastEnded = attempts.reduce((latest, value) => Math.max(latest, value.finishedAt?.getTime() ?? 0), 0);
      if (input.completedAt.getTime() < lastEnded)
        throw new AppError(422, "completion_time_conflict", "人工完成时间不能早于此前自动尝试的结束时间");
      const duplicate = queryRecords(this.repo, "manual_completion", {filters:[{field:"externalOrderRef",value:externalOrderRef},
        {field:"orderId",op:"ne",value:order.id}],limit:1,count:false}).data[0]
        ?? queryRecords(this.repo, "fulfillment", {filters:[{field:"upstreamOrderId",value:externalOrderRef},
          {field:"orderId",op:"ne",value:order.id}],limit:1,count:false}).data[0];
      if (duplicate) throw new AppError(409, "external_reference_reused", "外部完成单号已用于其他订单");
      const task = this.fulfillments.recordManualSuccess(order, input.completedAt, externalOrderRef);
      const record: ManualCompletion = {id:order.id, merchantId:order.merchantId, orderId:order.id, fulfillmentId:task.id,
        completedAt:input.completedAt, externalOrderRef, evidence,
        reason, actorId:actor.id, createdAt:now};
      this.repo.saveOperations("manual_completion", record, true);
      this.costs.markManualPending(actor, order.id);
      if (input.cost) {
        const cost = this.repo.getOperations("order_cost", order.id)!;
        this.costs.verify(actor, order.id, {version:cost.version, actualUsd:input.cost.actualUsd, feesUsd:"0.00",
          retainedUsd:minorToMoney(cost.retainedUsdMinor), fxRate:input.cost.fxRate, sourceReference:input.cost.sourceReference,
          evidence:input.cost.evidence, confirmEvidence:true, destination:input.cost.destination,
          confirmHistoricalTerms:!order.costTerms});
      }
      this.audit.record({merchantId:order.merchantId, actorId:actor.id, actorType:"platform_user",
        action:"order.manual_completion.record", targetType:"order", targetId:order.id, requestId});
      return record;
    });
  }
}
