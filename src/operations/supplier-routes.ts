import type {FastifyInstance, FastifyRequest} from "fastify";
import {z} from "zod";
import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";
import type {SupplierPlanSnapshot, SupplierProductMapping} from "../domain/model.js";
import type {Actor} from "./model.js";

const connectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  environment: z.enum(["sandbox", "production"]),
  open_api_base: z.string().url(),
  cdk_base: z.string().url(),
  enabled: z.boolean(),
  api_key: z.string().min(16).max(500).optional(),
  webhook_secret: z.string().min(16).max(500).optional(),
  direct_payment_resource_id: z.number().int().positive().optional(),
  clear_api_key: z.boolean().optional(),
  clear_webhook_secret: z.boolean().optional(),
  clear_direct_payment_resource: z.boolean().optional(),
  config_version: z.number().int().positive(),
}).strict();

const mappingSchema = z.object({
  expected_version: z.number().int().nonnegative(),
  fulfillment_mode: z.literal("cdk"),
  supplier_product: z.literal("gpt"),
  supplier_plan: z.string().min(1).max(64),
  enabled: z.boolean(),
}).strict();

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function registerSupplierWorkspaceRoutes(
  app: FastifyInstance,
  runtime: Runtime,
  actor: (request: FastifyRequest) => Actor,
): void {
  const admin = (request: FastifyRequest): Actor => {
    const value = actor(request);
    if (value.role !== "platform_admin" || value.merchantId !== null) {
      throw new AppError(403, "permission_denied", "仅平台管理员可管理上游接口");
    }
    return value;
  };

  app.get("/workspace/api/supplier/overview", async request => {
    admin(request);
    return {data: {
      connection: runtime.supplierManagement.getConnection(),
      plans: runtime.supplierManagement.listPlans().map(publicPlan),
      mappings: runtime.supplierManagement.listMappings().map(publicMapping),
      testOrders: testOrders(runtime),
    }};
  });

  app.put("/workspace/api/supplier/connection", async request => {
    const user = admin(request), input = connectionSchema.parse(request.body);
    const value = runtime.supplierManagement.saveConnection({
      name: input.name,
      environment: input.environment,
      openApiBase: input.open_api_base,
      cdkBase: input.cdk_base,
      enabled: input.enabled,
      ...(input.api_key ? {apiKey: input.api_key} : {}),
      ...(input.webhook_secret ? {webhookSecret: input.webhook_secret} : {}),
      ...(input.direct_payment_resource_id ? {directPaymentResourceId: input.direct_payment_resource_id} : {}),
      clearApiKey: input.clear_api_key ?? false,
      clearWebhookSecret: input.clear_webhook_secret ?? false,
      clearDirectPaymentResource: input.clear_direct_payment_resource ?? false,
      expectedVersion: input.config_version,
    });
    audit(runtime, user, request.id, "supplier.connection.update", "supplier_connection", value.id);
    return {data: value};
  });

  app.post("/workspace/api/supplier/test", async request => {
    const user = admin(request), value = await runtime.supplierManagement.testConnection();
    audit(runtime, user, request.id, "supplier.connection.test", "supplier_connection", "supplier_primary");
    return {data: value};
  });

  app.get("/workspace/api/supplier/balance", async request => {
    admin(request); return {data: await runtime.supplierManagement.getBalance()};
  });

  app.post("/workspace/api/supplier/plans/sync", async request => {
    const user = admin(request), values = await runtime.supplierManagement.syncPlans();
    audit(runtime, user, request.id, "supplier.plans.sync", "supplier_connection", "supplier_primary");
    return {data: values.map(publicPlan)};
  });

  app.put<{Params: {productCode: string}}>("/workspace/api/supplier/mappings/:productCode", async request => {
    const user = admin(request), productCode = z.string().min(1).max(64).parse(request.params.productCode);
    const input = mappingSchema.parse(request.body);
    const value = runtime.supplierManagement.saveMapping({
      productCode,
      fulfillmentMode: input.fulfillment_mode,
      supplierProduct: input.supplier_product,
      supplierPlan: input.supplier_plan,
      enabled: input.enabled,
      expectedVersion: input.expected_version,
    });
    audit(runtime, user, request.id, "supplier.mapping.update", "product_mapping", productCode);
    return {data: publicMapping(value)};
  });

  app.get<{Params: {kind: string}; Querystring: {page?: string; page_size?: string}}>("/workspace/api/supplier/reconciliation/:kind", async request => {
    admin(request);
    const kind = z.enum(["direct-orders", "cdks", "cdk-orders"]).parse(request.params.kind);
    const input = pageSchema.parse(request.query);
    const data = kind === "direct-orders"
      ? await runtime.supplierManagement.listDirectOrders(input.page, input.page_size)
      : kind === "cdks"
        ? await runtime.supplierManagement.listCdks(input.page, input.page_size)
        : await runtime.supplierManagement.listCdkOrders(input.page, input.page_size);
    return {data};
  });

  app.post<{Params: {orderId: string}}>("/workspace/api/supplier/test-orders/:orderId/disable-cdk", async request => {
    const user = admin(request);
    z.object({confirm_disable: z.literal(true)}).strict().parse(request.body);
    const order = runtime.repository.findOrderInternal(request.params.orderId);
    if (!order?.liveTest) throw new AppError(404, "test_order_not_found", "联调订单不存在");
    audit(runtime, user, request.id, "cdk.disable.request", "order", order.id, order.merchantId);
    const voucher = await runtime.cdk.disable(order.id);
    return {data: {order_id: order.id, voucher_status: voucher.status, service_fee_refund_status: "not_requested"}};
  });

  app.post<{Params: {orderId: string; fulfillmentId: string; action: string}}>("/workspace/api/supplier/test-orders/:orderId/fulfillments/:fulfillmentId/:action", async request => {
    const user = admin(request);
    const params = z.object({orderId: z.string(), fulfillmentId: z.string(), action: z.enum(["approve", "cancel"])}).parse(request.params);
    const order = runtime.repository.findOrderInternal(params.orderId);
    const task = order && runtime.repository.findFulfillment(order.merchantId, params.fulfillmentId);
    if (!order?.liveTest || !task || task.orderId !== order.id) throw new AppError(404, "test_task_not_found", "联调任务不存在");
    if (params.action === "approve") z.object({acknowledge_real_charge: z.literal(true)}).strict().parse(request.body);
    else z.object({confirm_cancel: z.literal(true)}).strict().parse(request.body);
    return runtime.repository.transaction(() => {
      const result = params.action === "approve"
        ? runtime.fulfillments.approveLiveSubmission(order.merchantId, task.id)
        : runtime.fulfillments.cancelQueued(order.merchantId, task.id);
      audit(runtime, user, request.id, "recharge.test." + params.action, "fulfillment", task.id, order.merchantId);
      return {data: {order_id: order.id, fulfillment_id: task.id, status: result.status, submission_approved: result.liveSubmissionApproved === true}};
    });
  });
}

function testOrders(runtime: Runtime) {
  return runtime.repository.listOrdersInternal().filter(order => order.liveTest).map(order => ({
    order_id: order.id,
    payment_status: order.paymentStatus,
    fulfillment_mode: order.fulfillmentMode,
    voucher_status: runtime.repository.findCdkVoucherByOrder(order.id)?.status ?? null,
    fulfillments: runtime.repository.listFulfillments(order.merchantId, order.id).map(task => ({
      fulfillment_id: task.id,
      status: task.status,
      submission_approved: task.liveSubmissionApproved === true,
      submitted: task.status === "running" || !!task.upstreamOrderId,
      message: task.message,
    })),
  }));
}

function publicPlan(value: SupplierPlanSnapshot) {
  return {
    product: value.product,
    plan: value.plan,
    name: value.name,
    enabled: value.enabled,
    purchasable: value.purchasable,
    service_fee_usd_minor: value.serviceFeeUsdMinor,
    pricing_version: value.pricingVersion,
    synced_at: value.syncedAt.toISOString(),
  };
}

function publicMapping(value: SupplierProductMapping) {
  return {
    product_code: value.productCode,
    fulfillment_mode: value.fulfillmentMode,
    supplier_product: value.supplierProduct,
    supplier_plan: value.supplierPlan,
    enabled: value.enabled,
    version: value.version,
    updated_at: value.updatedAt.toISOString(),
  };
}

function audit(runtime: Runtime, actor: Actor, requestId: string, action: string, targetType: string, targetId: string, merchantId: string | null = null) {
  runtime.audit.record({merchantId, actorId: actor.id, actorType: "platform_user", action, targetType, targetId, requestId});
}
