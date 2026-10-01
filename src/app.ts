import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from "fastify";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Runtime } from "./bootstrap.js";
import type { Fulfillment, Order, ProductGrant, Refund, Settlement, TenantContext } from "./domain/model.js";
import { AppError } from "./domain/errors.js";
import { minorToMoney } from "./domain/money.js";
import {registerPublicRechargeRoutes} from "./modules/public-recharge-routes.js";
import {registerSupplierAdminRoutes} from "./modules/supplier-admin-routes.js";
import {registerAlipayRoutes} from "./modules/alipay-routes.js";
import {registerLiveTestAdminPage} from "./modules/live-test-admin-page.js";
import {registerOperationsRoutes} from "./operations/routes.js";
import {partnerFulfillmentDetails, partnerFulfillmentMessage, partnerFulfillmentProgress} from "./modules/fulfillment-public.js";
import {latestFulfillmentOf, orderSyncMark} from "./domain/order-sync-mark.js";
import {canResubmitFulfillment} from "./domain/recharge-policy.js";
import type {OrderVisibilityField} from "./operations/model.js";
import {registerPartnerRedemptionRoutes} from "./modules/partner-redemption-routes.js";
import {registerWorkspacePage} from "./operations/workspace-page.js";
import type {Repository} from "./infra/repository.js";
import {publicWorkerHealth, readWorkerHealth} from "./worker/worker-health.js";
import {paymentQrDataUrl} from "./modules/payment-qr.js";

const createOrderSchema = z.object({
  merchant_order_no: z.string().min(1).max(64),
  product_code: z.string().min(1).max(64),
  quantity: z.number().int().positive(),
  sale_amount: z.string(),
  collection_mode: z.enum(["platform_collect", "agent_collect"]).optional(),
  delivery_mode: z.enum(["auto_recharge", "cdk"]).optional(),
  payment_channel: z.literal("alipay").optional(),
  notify_url: z.string().url().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).strict();

const createPaymentTestSchema=z.object({
  merchant_order_no:z.string().min(1).max(64),
  notify_url:z.string().url().optional(),
}).strict();

const fulfillmentSchema = z.object({
  session_data: z.record(z.string(), z.unknown()),
  customer_confirmed_email: z.literal(true),
}).strict();

const refundSchema = z.object({
  merchant_refund_no: z.string().min(1).max(64),
  type: z.enum(["full", "partial", "price_adjustment"]),
  amount: z.string(),
  reason: z.string().min(1).max(500),
}).strict();

const listOrdersQuerySchema = z.object({
  payment_status: z.enum(["pending", "paid", "expired", "closed", "partially_refunded", "refunded"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const listLedgerQuerySchema = z.object({
  from: z.string().datetime({offset: true}).optional(),
  to: z.string().datetime({offset: true}).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {message: "时间范围无效"});

const listSettlementsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function buildApp(config: AppConfig, runtime: Runtime): Promise<FastifyInstance> {
  const repository:Repository=runtime.repository;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req: (request) => ({method: request.method, url: request.url.split("?")[0] ?? "", remoteAddress: request.ip}),
      },
      redact: {
        paths: [
          "req.headers.authorization", "req.headers.cookie", "req.headers.x-signature",
          "req.headers.x-key-id", "req.headers.x-platform-admin-token", "req.body.session_data", "req.body.credential",
          "req.body.api_key", "req.body.webhook_secret", "req.body.direct_payment_resource_id", "*.client_secret", "*.secret",
          "req.body.password", "req.body.currentPassword", "req.body.newPassword", "req.headers.x-csrf-token", "res.headers.set-cookie",
          "req.body.code", "req.body.token",
          "req.body.privateKey", "req.body.publicKey", "req.body.apiSecret", "req.body.webhookSecret",
          "req.headers.djp-webhook-signature",
        ],
        censor: "[REDACTED]",
      },
    },
    // Never trust arbitrary X-Forwarded-* headers. Forwarded client IPs are
    // honored only when the immediate peer matches the configured edge proxy.
    trustProxy: config.trustProxy ? config.trustedProxyCidrs : false,
    bodyLimit: 64 * 1024,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", {parseAs: "buffer"}, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    request.rawBody = buffer;
    try {
      done(null, buffer.length === 0 ? {} : JSON.parse(buffer.toString("utf8")));
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.apiRateLimit) {
      const resetSeconds = Math.ceil(request.apiRateLimit.resetAt / 1000);
      reply.header("x-ratelimit-limit", String(request.apiRateLimit.limit));
      reply.header("x-ratelimit-remaining", String(request.apiRateLimit.remaining));
      reply.header("x-ratelimit-reset", String(resetSeconds));
      if (reply.statusCode === 429) reply.header("retry-after", String(Math.max(1, resetSeconds - Math.floor(Date.now() / 1000))));
    }
    if (request.routeOptions.url?.startsWith("/workspace/api/")) {
      const elapsed = Math.max(0, reply.elapsedTime);
      reply.header("server-timing", `app;dur=${elapsed.toFixed(1)}`);
      reply.header("x-quefa-request-id", request.id);
      if (elapsed >= 500) request.log.warn({route: request.routeOptions.url, responseTime: elapsed, requestId: request.id}, "slow workspace request");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({error: {code: error.code, message: error.message, request_id: request.id, retryable: error.retryable}});
    }
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const field = issue?.path?.join(".") ?? "";
      const message = issue?.code === "too_small" && field === "newPassword" ? "新密码至少 8 位"
        : issue?.code === "too_small" && field === "password" ? "密码至少 8 位"
        : "请求字段无效";
      return reply.code(400).send({error: {code: "invalid_request", message, request_id: request.id, retryable: false}});
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    request.log.error({errorName, requestId: request.id}, "request failed");
    return reply.code(500).send({error: {code: "internal_error", message: "服务内部错误", request_id: request.id, retryable: true}});
  });

  // HMAC 覆盖原始请求体，因此必须在内容解析完成后认证。
  app.addHook("preValidation", async (request) => {
    if (request.routeOptions.url?.startsWith("/v1/")) request.tenant = await runtime.authenticator.authenticate(request);
  });

  app.get("/health/live", async () => ({status: "ok"}));
  app.get("/health/ready", async () => ({status: "ok", storage: config.storageDriver === "sqlite"
    ? config.nodeEnv === "production" ? "sqlite" : "sqlite-sandbox"
    : "memory-test", worker: readWorkerHealth(repository).status}));
  app.get("/health/worker", async (_request, reply) => {
    const view = readWorkerHealth(repository);
    if (view.status !== "healthy") reply.code(503);
    return publicWorkerHealth(view);
  });

  app.get("/v1/products", async (request) => ({data: runtime.catalog.list(requireTenant(request).merchantId).map(publicProduct)}));
  app.get("/v1/payment-methods", async () => ({data: runtime.paymentSettings.available()
    .filter(channel => channel === "alipay_page").map(() => ({code: "alipay", name: "支付宝"}))}));

  app.get<{Querystring: {payment_status?: string; cursor?: string; limit?: string}}>("/v1/orders", async (request) => {
    const tenant = requireTenant(request);
    const input = listOrdersQuerySchema.parse(request.query);
    if(repository.queryPartnerOrders){
      const query:{paymentStatus?:Order["paymentStatus"];cursor?:string;limit:number}={limit:input.limit};
      if(input.payment_status)query.paymentStatus=input.payment_status;
      if(input.cursor)query.cursor=input.cursor;
      const result=repository.queryPartnerOrders(tenant.merchantId,query);
      if(!result.cursorValid)throw new AppError(400,"invalid_cursor","订单游标无效");
      const tasks=new Map(result.fulfillments.map(task=>[task.orderId,task]));
      return {data:result.orders.map(order=>publicOrder(order,tasks.get(order.id)??null)),next_cursor:result.hasMore?result.orders.at(-1)?.id??null:null};
    }
    const filtered = runtime.repository.listOrders(tenant.merchantId).filter(order => !input.payment_status || order.paymentStatus === input.payment_status);
    const page=cursorPage(filtered,input.cursor,input.limit,"订单游标无效");
    return {data:page.data.map(order=>publicOrder(order,latestFulfillmentOf(runtime.repository.listFulfillments(tenant.merchantId,order.id)))),next_cursor:page.nextCursor};
  });

  app.post("/v1/orders", async (request, reply) => {
    const tenant = requireTenant(request);
    const input = createOrderSchema.parse(request.body);
    if (input.notify_url && !input.notify_url.startsWith("https://") && !config.enableSandboxRoutes) {
      throw new AppError(422, "https_webhook_required", "生产 Webhook 地址必须使用 HTTPS");
    }
    for (const key of Object.keys(input.metadata ?? {})) {
      if (/token|session|cookie|password|secret|authorization/i.test(key)) {
        throw new AppError(422, "sensitive_metadata_key", "metadata 不允许包含敏感字段");
      }
    }
    if (input.notify_url) input.notify_url = new URL(input.notify_url).toString().replace(/\/$/, "");
    runtime.webhooks.assertRegisteredEndpoint(tenant.merchantId, input.notify_url);
    return sendIdempotent(runtime, request, reply, "POST /v1/orders", 201, async () => {
      const order = await runtime.orders.create(tenant, {
        merchantOrderNo: input.merchant_order_no,
        productCode: input.product_code,
        quantity: input.quantity,
        saleAmount: input.sale_amount,
        collectionMode: input.collection_mode ?? "platform_collect",
        deliveryMode: input.delivery_mode,
        paymentChannel: input.payment_channel === "alipay" ? "alipay_page" : undefined,
        metadata: input.metadata ?? {},
        notifyUrl: input.notify_url,
      });
      runtime.audit.record({merchantId: tenant.merchantId, actorId: tenant.keyId, action: "order.create", targetType: "order", targetId: order.id, requestId: request.id});
      return {data: publicOrder(order, null), idempotent: false};
    });
  });

  app.post("/v1/payment-tests",async(request,reply)=>{
    const tenant=requireTenant(request),input=createPaymentTestSchema.parse(request.body);
    if(input.notify_url&&!input.notify_url.startsWith("https://")&&!config.enableSandboxRoutes)
      throw new AppError(422,"https_webhook_required","生产 Webhook 地址必须使用 HTTPS");
    if(input.notify_url)input.notify_url=new URL(input.notify_url).toString().replace(/\/$/,"");
    runtime.webhooks.assertRegisteredEndpoint(tenant.merchantId,input.notify_url);
    return sendIdempotent(runtime,request,reply,"POST /v1/payment-tests",201,async()=>{
      const order=await runtime.orders.createPaymentTest(tenant,{merchantOrderNo:input.merchant_order_no,
        ...(input.notify_url?{notifyUrl:input.notify_url}:{})});
      runtime.audit.record({merchantId:tenant.merchantId,actorId:tenant.keyId,action:"payment_test.create",targetType:"order",
        targetId:order.id,requestId:request.id});
      return {data:publicOrder(order,null),idempotent:false};
    });
  });

  app.get<{Params: {orderId: string}}>("/v1/orders/:orderId", async (request) => {
    const tenant = requireTenant(request);
    const order = runtime.orders.get(tenant.merchantId, request.params.orderId);
    const latest = latestFulfillmentOf(runtime.repository.listFulfillments(tenant.merchantId, order.id));
    return {data: publicOrder(order, latest, latest ? runtime.fulfillments.canResubmit(latest) : false)};
  });

  app.post<{Params: {orderId: string}}>("/v1/orders/:orderId/payment-code", async (request, reply) => {
    const tenant = requireTenant(request);
    // Response format is intentionally fixed. In particular, this endpoint
    // accepts no amount, payment-channel or payment-config override.
    z.object({}).strict().parse(request.body);
    const assertAvailable=()=>assertPartnerPaymentCodeAvailable(runtime,tenant,request.params.orderId);
    return sendIdempotent(runtime, request, reply, "POST /v1/orders/:orderId/payment-code", 200, async () => {
      const initial=assertAvailable();
      const paymentCode = await runtime.alipay!.precreate(initial.order.id);
      // Provider notifications and expiry can win while precreate is in flight.
      // Never return a now-invalid code merely because the provider call began first.
      const {order}=assertAvailable();
      const qrImageDataUrl = await paymentQrDataUrl(paymentCode);
      runtime.audit.record({merchantId: tenant.merchantId, actorId: tenant.keyId, action: "payment_code.fetch",
        targetType: "order", targetId: order.id, requestId: request.id});
      return {data: {
        order_id: order.id,
        merchant_order_no: order.merchantOrderNo,
        amount: minorToMoney(order.saleAmountMinor),
        currency: order.currency,
        payment_status: order.paymentStatus,
        payment_code_type: "alipay_precreate",
        payment_code: paymentCode,
        qr_image_data_url: qrImageDataUrl,
        expires_at: order.expiresAt.toISOString(),
      }};
    },()=>{assertAvailable();});
  });

  app.post<{Params: {orderId: string}}>("/v1/orders/:orderId/fulfillments", async (request, reply) => {
    const tenant = requireTenant(request);
    const input = fulfillmentSchema.parse(request.body);
    return sendIdempotent(runtime, request, reply, "POST /v1/orders/:orderId/fulfillments", 202, async () => {
      const value = runtime.fulfillments.create(tenant, request.params.orderId, input.session_data);
      runtime.audit.record({merchantId: tenant.merchantId, actorId: tenant.keyId, action: "fulfillment.create", targetType: "fulfillment", targetId: value.id, requestId: request.id});
      return {data: publicFulfillment(value, runtime.agents.profile(tenant.merchantId).orderVisibility)};
    });
  });

  app.get<{Params: {orderId: string}}>("/v1/orders/:orderId/fulfillments", async (request) => {
    const tenant = requireTenant(request);
    const visibility = runtime.agents.profile(tenant.merchantId).orderVisibility;
    return {data: runtime.fulfillments.list(tenant.merchantId, request.params.orderId).map(value => publicFulfillment(value, visibility, runtime.fulfillments.canResubmit(value)))};
  });

  app.post<{Params: {orderId: string}}>("/v1/orders/:orderId/refunds", async (request, reply) => {
    const tenant = requireTenant(request);
    const input = refundSchema.parse(request.body);
    return sendIdempotent(runtime, request, reply, "POST /v1/orders/:orderId/refunds", 202, async () => {
      const value = runtime.refunds.request(tenant, request.params.orderId, {
        merchantRefundNo: input.merchant_refund_no,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
      });
      runtime.audit.record({merchantId: tenant.merchantId, actorId: tenant.keyId, action: "refund.request", targetType: "refund", targetId: value.id, requestId: request.id});
      return {data: publicRefund(value)};
    });
  });

  app.get<{Params: {refundId: string}}>("/v1/refunds/:refundId", async (request) => {
    const tenant = requireTenant(request);
    return {data: publicRefund(runtime.refunds.get(tenant.merchantId, request.params.refundId))};
  });

  app.get<{Querystring:{from?:string;to?:string;cursor?:string;limit?:string}}>("/v1/ledger", async (request) => {
    const tenant = requireTenant(request);
    const input=listLedgerQuerySchema.parse(request.query),filtered=repository.queryPartnerLedger?null:repository.listLedger(tenant.merchantId)
      .filter(item=>(!input.from||item.occurredAt>=new Date(input.from))&&(!input.to||item.occurredAt<new Date(input.to)));
    const query:{from?:Date;to?:Date;cursor?:string;limit:number}={limit:input.limit};
    if(input.from)query.from=new Date(input.from);if(input.to)query.to=new Date(input.to);if(input.cursor)query.cursor=input.cursor;
    const result=repository.queryPartnerLedger?.(tenant.merchantId,query);
    if(result&&!result.cursorValid)throw new AppError(400,"invalid_cursor","台账游标无效");
    const page=result?{data:result.entries,nextCursor:result.hasMore?result.entries.at(-1)?.id??null:null}:cursorPage(filtered!,input.cursor,input.limit,"台账游标无效");
    return {
      data: page.data.map((item) => ({
        entry_id: item.id, occurred_at: item.occurredAt.toISOString(), order_id: item.orderId,
        type: item.type, amount: minorToMoney(item.amountMinor), direction: item.direction, currency: "CNY",
      })),
      next_cursor: page.nextCursor,
    };
  });

  app.get<{Querystring:{cursor?:string;limit?:string}}>("/v1/settlements", async (request) => {
    const tenant = requireTenant(request);
    const input=listSettlementsQuerySchema.parse(request.query),query:{cursor?:string;limit:number}={limit:input.limit};if(input.cursor)query.cursor=input.cursor;
    const result=repository.queryPartnerSettlements?.(tenant.merchantId,query);
    if(result&&!result.cursorValid)throw new AppError(400,"invalid_cursor","结算单游标无效");
    const page=result?{data:result.settlements,nextCursor:result.hasMore?result.settlements.at(-1)?.id??null:null}
      :cursorPage(runtime.repository.listSettlements(tenant.merchantId),input.cursor,input.limit,"结算单游标无效");
    return {data:page.data.map(publicSettlement),next_cursor:page.nextCursor};
  });

  app.get<{Params: {settlementId: string}}>("/v1/settlements/:settlementId", async (request) => {
    const tenant = requireTenant(request);
    const value = runtime.repository.findSettlement(tenant.merchantId, request.params.settlementId);
    if (!value) throw new AppError(404, "settlement_not_found", "结算单不存在");
    return {data: publicSettlement(value)};
  });

  app.post("/v1/webhooks/test", async (request, reply) => {
    const tenant = requireTenant(request);
    return sendIdempotent(runtime, request, reply, "POST /v1/webhooks/test", 202, async () => {
      const event = runtime.webhooks.emit(tenant.merchantId, `${tenant.merchantId}:${request.id}:webhook.test`, "webhook.test", tenant.merchantId, {event: "webhook.test", request_id: request.id});
      return {data: {event_id: event.id, status: "queued"}};
    });
  });

  registerPublicRechargeRoutes(app, runtime);
  registerWorkspacePage(app);
  registerPartnerRedemptionRoutes(app, runtime);
  registerAlipayRoutes(app, runtime, config.publicBaseUrl);
  registerLiveTestAdminPage(app);
  registerOperationsRoutes(app, config, runtime);
  registerSupplierAdminRoutes(app, config, runtime);
  if (config.enableSandboxRoutes) registerSandboxRoutes(app, config, runtime);
  return app;
}

function registerSandboxRoutes(app: FastifyInstance, config: AppConfig, runtime: Runtime): void {
  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/sandbox/")) return;
    if (request.url.startsWith("/sandbox/pay/")) return;
    const supplied = header(request, "x-sandbox-token");
    if (!secureTextEqual(config.sandboxAdminToken, supplied)) throw new AppError(401, "invalid_sandbox_token", "沙箱令牌无效");
  });

  app.get<{Params: {orderId: string}}>("/sandbox/pay/:orderId", async (request, reply) => {
    const order = runtime.repository.findOrderInternal(request.params.orderId);
    if (!order) throw new AppError(404, "order_not_found", "沙箱订单不存在");
    const isPending = order.paymentStatus === "pending" && order.expiresAt > new Date();
    const statusText = order.paymentStatus === "paid" ? "已支付" : isPending ? "等待付款" : "不可支付";
    reply
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
      .type("text/html; charset=utf-8");
    const rechargeLink = order.paymentStatus === "paid" ? `<a id="recharge" href="${escapeHtml(order.fulfillmentUrl)}">继续充值或兑换</a>` : `<a id="recharge" href="${escapeHtml(order.fulfillmentUrl)}" hidden>继续充值或兑换</a>`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quefa 沙箱付款</title><style>body{font-family:system-ui;margin:0;background:#f4f6fa;color:#172033}.card{max-width:420px;margin:8vh auto;background:white;padding:32px;border-radius:18px;box-shadow:0 12px 40px #17203320}h1{font-size:22px}.amount{font-size:36px;font-weight:700;margin:24px 0}.meta{color:#667085;word-break:break-all}button,a{display:block;box-sizing:border-box;width:100%;padding:14px;border:0;border-radius:10px;background:#1677ff;color:white;font-size:16px;text-align:center;text-decoration:none;margin-top:12px}button:disabled{background:#aab4c3}</style></head><body><main class="card"><h1>Quefa 模拟支付宝</h1><p class="meta">仅用于沙箱，不产生真实扣款</p><div class="amount">¥${minorToMoney(order.saleAmountMinor)}</div><p>状态：<strong id="status">${statusText}</strong></p><p class="meta">订单：${escapeHtml(order.merchantOrderNo)}</p><button id="pay" ${isPending ? "" : "disabled"}>确认模拟付款</button>${rechargeLink}</main><script>document.getElementById('pay').onclick=async()=>{const b=document.getElementById('pay');b.disabled=true;const r=await fetch(location.pathname+'/confirm',{method:'POST'});const j=await r.json();if(!r.ok){document.getElementById('status').textContent=j.error?.message||'付款失败';b.disabled=false;return}document.getElementById('status').textContent='已支付';document.getElementById('recharge').hidden=false;}</script></body></html>`;
  });

  app.post<{Params: {orderId: string}}>("/sandbox/pay/:orderId/confirm", async (request) => {
    const order = runtime.repository.findOrderInternal(request.params.orderId);
    if (!order) throw new AppError(404, "order_not_found", "沙箱订单不存在");
    if (order.paymentStatus === "paid") return {data: {order_id: order.id, payment_status: order.paymentStatus, fulfillment_url: order.fulfillmentUrl}};
    if (order.paymentStatus !== "pending" || order.expiresAt <= new Date()) {
      throw new AppError(409, "sandbox_payment_unavailable", "订单已过期或不可支付");
    }
    const paid = runtime.payment.markPaid(order.merchantId, order.id, {
      providerRef: `sandbox_${order.id}`,
      receivedMinor: order.saleAmountMinor,
      feeMinor: 0n,
    });
    return {data: {order_id: paid.id, payment_status: paid.paymentStatus, fulfillment_url: paid.fulfillmentUrl}};
  });

  app.post<{Params: {partnerId: string; orderId: string}}>("/sandbox/merchants/:partnerId/orders/:orderId/pay", async (request) => {
    const merchant = runtime.repository.findMerchantByPartner(request.params.partnerId);
    if (!merchant) throw new AppError(404, "merchant_not_found", "代理商不存在");
    const order = runtime.orders.get(merchant.id, request.params.orderId);
    const paid = runtime.payment.markPaid(merchant.id, order.id, {providerRef: `sandbox_${order.id}`, receivedMinor: order.saleAmountMinor, feeMinor: 0n});
    return {data: publicOrder(paid, null)};
  });

  app.post<{Params: {partnerId: string; refundId: string}}>("/sandbox/merchants/:partnerId/refunds/:refundId/succeed", async (request) => {
    const merchant = runtime.repository.findMerchantByPartner(request.params.partnerId);
    if (!merchant) throw new AppError(404, "merchant_not_found", "代理商不存在");
    return {data: publicRefund(runtime.refunds.completeForSandbox(merchant.id, request.params.refundId))};
  });

  app.post("/sandbox/worker/fulfillments/tick", async () => {
    const value = await runtime.fulfillments.processOne();
    return {data: value ? publicFulfillment(value) : null};
  });

  app.post("/sandbox/worker/cdks/tick", async () => {
    const value = await runtime.cdk.issueOne();
    return {data: value ? {order_id: value.orderId, voucher_code: value.publicCode, status: value.status} : null};
  });
}

async function sendIdempotent(
  runtime: Runtime,
  request: FastifyRequest,
  reply: FastifyReply,
  routeKey: string,
  successStatus: number,
  action: () => Promise<unknown>,
  beforeReplay?: () => void | Promise<void>,
): Promise<unknown> {
  const tenant = requireTenant(request);
  const key = header(request, "idempotency-key");
  const requestHash = createHash("sha256")
    .update(request.method)
    .update("\0")
    .update(request.url)
    .update("\0")
    .update(request.rawBody ?? Buffer.alloc(0))
    .digest("hex");
  const leaseToken = randomUUID(), now = new Date();
  const record = {merchantId: tenant.merchantId, appId: tenant.appId, routeKey, key, requestHash,
    responseStatus: 0, responseBody: null};
  const claim = runtime.repository.claimIdempotency(record, leaseToken, now, new Date(now.getTime() + 300_000));
  if (claim.state === "conflict") throw new AppError(409, "idempotency_conflict", "同一幂等键对应不同请求");
  if (claim.state === "processing") {
    reply.header("retry-after", String(Math.max(1, Math.ceil((claim.leaseUntil.getTime() - Date.now()) / 1000))));
    throw new AppError(409, "idempotency_in_progress", "相同请求正在处理中，请稍后查询或使用原幂等键重试", true);
  }
  if (claim.state === "replay") {
    await beforeReplay?.();
    reply.header("Idempotent-Replayed", "true").code(claim.record.responseStatus);
    const body = claim.record.responseBody as Record<string, unknown>;
    return {...body, idempotent: true};
  }
  try {
    const body = await action();
    const completed = runtime.repository.completeIdempotency({...record, responseStatus: successStatus, responseBody: body}, leaseToken);
    if (!completed) throw new AppError(409, "idempotency_lease_lost", "请求执行状态已变化，请查询原业务结果", true);
    reply.code(successStatus);
    return body;
  } catch (error) {
    runtime.repository.releaseIdempotency(tenant.merchantId, tenant.appId, routeKey, key, leaseToken);
    throw error;
  }
}

function assertPartnerPaymentCodeAvailable(runtime:Runtime,tenant:TenantContext,orderId:string) {
  const profile=runtime.agents.profile(tenant.merchantId);
  if(!profile.directPaymentCodeEnabled)throw new AppError(403,"direct_payment_code_disabled","当前代理尚未开通后端直出付款码");
  const order=runtime.orders.get(tenant.merchantId,orderId);
  const attempt=runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id);
  if(order.collectionMode==="agent_collect"||!attempt||attempt.provider!=="alipay_page")
    throw new AppError(409,"payment_code_not_supported","该订单不使用平台支付宝收款");
  if(order.paymentStatus!=="pending"||order.expiresAt<=new Date())
    throw new AppError(409,"payment_not_available","订单不可支付，请查询订单状态或重新下单");
  if(attempt.status!=="pending"||attempt.requestedMinor!==order.saleAmountMinor||attempt.expiresAt.getTime()!==order.expiresAt.getTime())
    throw new AppError(409,"payment_binding_mismatch","支付记录与订单金额或有效期不一致");
  if(!runtime.alipay)throw new AppError(503,"payment_provider_unavailable","支付宝付款码暂不可用",true);
  return {order,attempt};
}

function requireTenant(request: FastifyRequest): TenantContext {
  if (!request.tenant) throw new AppError(401, "unauthenticated", "请求未认证");
  return request.tenant;
}

function cursorPage<T extends {id:string}>(values:T[],cursor:string|undefined,limit:number,errorMessage:string):{data:T[];nextCursor:string|null} {
  const cursorIndex=cursor?values.findIndex(value=>value.id===cursor):-1;
  if(cursor&&cursorIndex<0)throw new AppError(400,"invalid_cursor",errorMessage);
  const start=cursorIndex<0?0:cursorIndex+1,data=values.slice(start,start+limit),hasMore=start+data.length<values.length;
  return {data,nextCursor:hasMore?data.at(-1)?.id??null:null};
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function secureTextEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicProduct(value: ProductGrant) {
  return {
    product_code: value.productCode, name: value.name,
    supply_price: minorToMoney(value.supplyPriceMinor), max_sale_price: minorToMoney(value.maxSalePriceMinor),
    currency: value.currency, max_quantity: value.maxQuantity, available: value.available,
    fulfillment_mode: value.fulfillmentMode,
    delivery_modes: value.fulfillmentMode === "cdk" ? ["auto_recharge", "cdk"] : ["auto_recharge"],
  };
}

function publicOrder(value: Order, fulfillment: Fulfillment | null = null, retryAllowed = fulfillment ? canResubmitFulfillment(fulfillment) : false) {
  const merchantMargin = value.collectionMode === "agent_collect" ? 0n : value.saleAmountMinor - value.supplyAmountMinor - value.ordinaryRefundedMinor;
  return {
    collection_mode: value.collectionMode ?? "platform_collect",
    purpose:value.paymentPurpose??"subscription",
    payment_scope: value.collectionMode === "agent_collect" ? "procurement" : "retail",
    order_id: value.id, merchant_order_no: value.merchantOrderNo, product_code: value.productCode,
    quantity: value.quantity, sale_amount: minorToMoney(value.saleAmountMinor), supply_amount: minorToMoney(value.supplyAmountMinor),
    refunded_amount: minorToMoney(value.ordinaryRefundedMinor), price_adjustment_amount: minorToMoney(value.priceAdjustmentRefundedMinor),
    merchant_margin: minorToMoney(merchantMargin), currency: value.currency, payment_status: value.paymentStatus,
    metadata: value.metadata,
    qr_payload: value.qrPayload, qr_image_url: value.qrImageUrl, paid_at: value.paidAt?.toISOString() ?? null,
    fulfillment_mode: value.paymentPurpose==="payment_test"?null:value.fulfillmentMode ?? "direct",
    fulfillment_url:value.paymentPurpose==="payment_test"?null:value.fulfillmentUrl,
    delivery_mode:value.paymentPurpose==="payment_test"?null:value.deliveryMode ?? (value.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge"),
    voucher_code: (value.deliveryMode ?? (value.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge")) === "cdk" ? value.voucherCode : null,
    fallback_recharge_available: Boolean(value.fallbackRechargeAvailable) && retryAllowed,
    fulfillment_status: fulfillment?.status ?? null,
    retry_allowed: retryAllowed,
    fulfillment_failure_code: fulfillment?.failureCode ?? null,
    sync_mark: orderSyncMark(value.paymentStatus, fulfillment),
    created_at: value.createdAt.toISOString(), expires_at: value.expiresAt.toISOString(),
  };
}

function publicFulfillment(value: Fulfillment, visibility?: OrderVisibilityField[], retryAllowed = canResubmitFulfillment(value)) {
  return {
    fulfillment_id: value.id, order_id: value.orderId, attempt_no: value.attemptNo, status: value.status,
    ...partnerFulfillmentProgress(value),
    retry_allowed: retryAllowed,
    next_action: value.status === "succeeded" ? "none" : retryAllowed ? "resubmit" : "wait",
    failure_code: value.failureCode, message: partnerFulfillmentMessage(value), account_email_masked: value.accountEmailMasked,
    ...partnerFulfillmentDetails(value, visibility),
    fulfillment_mode: value.mode ?? "direct",
    created_at: value.createdAt.toISOString(), finished_at: value.finishedAt?.toISOString() ?? null,
  };
}

function publicRefund(value: Refund) {
  return {
    refund_id: value.id, order_id: value.orderId, merchant_refund_no: value.merchantRefundNo,
    type: value.type, amount: minorToMoney(value.amountMinor), status: value.status,
    failure_code: value.failureCode, created_at: value.createdAt.toISOString(), refunded_at: value.refundedAt?.toISOString() ?? null,
  };
}

function publicSettlement(value: Settlement) {
  return {
    settlement_id: value.id, period_from: value.periodFrom.toISOString(), period_to: value.periodTo.toISOString(),
    status: value.status, gross_amount: minorToMoney(value.grossMinor), adjustment_amount: minorToMoney(value.adjustmentMinor),
    payable_amount: minorToMoney(value.payableMinor), currency: value.currency,
    sealed_at: value.sealedAt?.toISOString() ?? null, paid_at: value.paidAt?.toISOString() ?? null,
    created_at: value.createdAt.toISOString(),
    lines: value.lines.map((line) => ({line_id: line.id, order_id: line.orderId, type: line.sourceType, amount: minorToMoney(line.amountMinor), original_settlement_line_id: line.originalSettlementLineId})),
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
