import {createHash} from "node:crypto";
import type {FastifyInstance} from "fastify";
import {z} from "zod";
import type {Runtime} from "../bootstrap.js";
import type {Fulfillment} from "../domain/model.js";
import {partnerFulfillmentDetails, partnerFulfillmentMessage, partnerFulfillmentProgress} from "./fulfillment-public.js";
import type {OrderVisibilityField} from "../operations/model.js";
import {AppError} from "../domain/errors.js";
import {CDK_PUBLIC_CODE_PATTERN} from "./cdk-code.js";
import {canResubmitFulfillment} from "../domain/recharge-policy.js";
import {latestFulfillmentOf} from "../domain/order-sync-mark.js";
import type {RechargeCredential} from "../upstream/recharge-provider.js";

const credentialSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("session"), session: z.string().min(1).max(32_000)}).strict(),
  z.object({mode: z.literal("access_token"), access_token: z.string().min(1).max(32_000)}).strict(),
  z.object({mode: z.literal("mailbox"), email: z.string().email().max(320), password: z.string().min(1).max(1000)}).strict(),
]);
const inputSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("direct"), order_id: z.string().min(1).max(100), credential: credentialSchema, customer_confirmed_email: z.literal(true)}).strict(),
  z.object({mode: z.literal("auto_recharge"), order_id: z.string().min(1).max(100), credential: credentialSchema, customer_confirmed_email: z.literal(true)}).strict(),
  z.object({mode: z.literal("cdk"), code: z.string().regex(CDK_PUBLIC_CODE_PATTERN), credential: credentialSchema, customer_confirmed_email: z.literal(true)}).strict(),
]);

// Explicit allow-list: never spread a stored fulfillment into a partner response.
export function redemptionView(task: Fulfillment, visibility?: OrderVisibilityField[], fallbackRechargeAvailable = false, latestAttempt = true, orderRetryAllowed = true) {
  const retryAllowed = latestAttempt && orderRetryAllowed && canResubmitFulfillment(task);
  return {redemption_id: task.id, order_id: task.orderId, fulfillment_mode: task.mode ?? "direct", status: task.status,
    attempt_no: task.attemptNo, ...partnerFulfillmentProgress(task),
    failure_code: task.failureCode, message: partnerFulfillmentMessage(task), ...partnerFulfillmentDetails(task, visibility), account_email_masked: task.accountEmailMasked,
    fallback_recharge_available: fallbackRechargeAvailable && retryAllowed,
    retry_allowed: retryAllowed, next_action: task.status === "succeeded" ? "none" : retryAllowed ? "resubmit" : "wait",
    created_at: task.createdAt.toISOString(), finished_at: task.finishedAt?.toISOString() ?? null};
}
export function registerPartnerRedemptionRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.post("/v1/redemptions", async (request, reply) => {
    const tenant = request.tenant!;
    reply.header("cache-control", "no-store");
    if (!runtime.agents.profile(tenant.merchantId).customRedemptionEnabled) throw new AppError(403, "custom_redemption_disabled", "请联系平台开通自建兑换页接口");
    const input = inputSchema.parse(request.body);
    const key = String(request.headers["idempotency-key"] ?? "");
    if (!/^[a-zA-Z0-9:_.-]{8,120}$/.test(key)) throw new AppError(400, "idempotency_key_required", "请提供 8–120 位幂等键");
    const routeKey = "POST /v1/redemptions";
    const requestHash = createHash("sha256").update(request.rawBody ?? Buffer.alloc(0)).digest("hex");
    return runtime.repository.transaction(() => {
      const existing = runtime.repository.getIdempotency(tenant.merchantId, tenant.appId, routeKey, key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError(409, "idempotency_conflict", "同一幂等键对应不同兑换请求");
        reply.code(202).header("Idempotent-Replayed", "true"); return existing.responseBody;
      }
      const credential: RechargeCredential = input.credential.mode === "access_token"
        ? {mode: "access_token", accessToken: input.credential.access_token} : input.credential;
      let task: Fulfillment;
      if (input.mode === "direct") {
        const order = runtime.orders.get(tenant.merchantId, input.order_id);
        task = runtime.fulfillments.createDirectPublic(order, credential);
      } else if (input.mode === "auto_recharge") {
        const order = runtime.orders.get(tenant.merchantId, input.order_id);
        if ((order.deliveryMode ?? "cdk") !== "auto_recharge" || order.fulfillmentMode !== "cdk") {
          throw new AppError(409, "auto_recharge_unavailable", "该订单未选择自动充值");
        }
        const voucher = runtime.repository.findCdkVoucherByOrder(order.id);
        if (!voucher || voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "充值资源尚未就绪或已使用");
        task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), credential);
      } else {
        const voucher = runtime.cdk.findPublic(input.code);
        // Do not reveal whether a code belonging to a different agent exists.
        if (!voucher || voucher.merchantId !== tenant.merchantId) throw new AppError(404, "voucher_not_found", "兑换码无效或不可用");
        if (voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "兑换码已使用或正在兑换，请查询原任务");
        const order = runtime.orders.get(tenant.merchantId, voucher.orderId);
        task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), credential);
      }
      const body = {data: redemptionView(task, runtime.agents.profile(tenant.merchantId).orderVisibility)};
      runtime.repository.saveIdempotency({merchantId: tenant.merchantId, appId: tenant.appId, routeKey, key, requestHash,
        responseStatus: 202, responseBody: body});
      runtime.audit.record({merchantId: tenant.merchantId, actorId: tenant.keyId, action: "redemption.create", targetType: "fulfillment", targetId: task.id, requestId: request.id});
      reply.code(202); return body;
    });
  });
  app.get<{Params: {id: string}}>("/v1/redemptions/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const task = runtime.repository.findFulfillment(request.tenant!.merchantId, request.params.id);
    if (!task) throw new AppError(404, "redemption_not_found", "兑换任务不存在");
    const order = runtime.repository.findOrder(task.merchantId, task.orderId);
    const fallbackRechargeAvailable = Boolean(order?.fallbackRechargeAvailable);
    const latestAttempt = latestFulfillmentOf(runtime.repository.listFulfillments(task.merchantId, task.orderId))?.id === task.id;
    // Existing tasks remain queryable if creation permission is revoked.
    return {data: redemptionView(task, runtime.agents.profile(request.tenant!.merchantId).orderVisibility, fallbackRechargeAvailable, latestAttempt, runtime.fulfillments.canResubmit(task))};
  });
}
