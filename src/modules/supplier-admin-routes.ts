import {timingSafeEqual} from "node:crypto";
import type {FastifyInstance, FastifyReply} from "fastify";
import {z} from "zod";
import type {AppConfig} from "../config.js";
import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";
import type {SupplierPlanSnapshot, SupplierProductMapping} from "../domain/model.js";

const connectionSchema = z.object({
  name: z.string().min(1).max(80),
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
  config_version: z.number().int().positive().optional(),
}).strict();

const mappingSchema = z.object({
  fulfillment_mode: z.enum(["direct", "cdk"]),
  supplier_product: z.literal("gpt"),
  supplier_plan: z.string().min(1).max(64),
  enabled: z.boolean(),
}).strict();

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function registerSupplierAdminRoutes(app: FastifyInstance, config: AppConfig, runtime: Runtime): void {
  app.get("/internal/admin/supply", async (_request, reply) => adminPage(reply));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/internal/admin/api/supply")) return;
    reply.header("cache-control", "no-store");
    if (config.platformAdminToken.startsWith("replace-")) throw new AppError(503, "platform_admin_not_configured", "请先配置独立的平台管理令牌");
    const supplied = header(request.headers["x-platform-admin-token"]);
    if (!secureEqual(config.platformAdminToken, supplied)) throw new AppError(401, "invalid_platform_admin_token", "平台管理令牌无效");
  });

  app.get("/internal/admin/api/supply/connection", async () => ({data: runtime.supplierManagement.getConnection()}));

  app.get("/internal/admin/api/supply/test-orders", async () => ({data: runtime.repository.listOrdersInternal()
    .filter(order => order.liveTest).map(order => ({
      order_id: order.id, payment_status: order.paymentStatus, fulfillment_mode: order.fulfillmentMode,
      voucher_status: runtime.repository.findCdkVoucherByOrder(order.id)?.status ?? null,
      fulfillments: runtime.repository.listFulfillments(order.merchantId, order.id).map(task => ({
        fulfillment_id: task.id, status: task.status, submission_approved: task.liveSubmissionApproved === true,
        submitted: task.status === "running" || !!task.upstreamOrderId, message: task.message,
      })),
    }))}));

  app.post<{Params: {orderId: string}}>("/internal/admin/api/supply/test-orders/:orderId/disable-cdk", async (request) => {
    z.object({confirm_disable: z.literal(true)}).strict().parse(request.body);
    const order = runtime.repository.findOrderInternal(request.params.orderId);
    if (!order?.liveTest) throw new AppError(404, "test_order_not_found", "联调订单不存在");
    runtime.audit.record({merchantId: order.merchantId, actorId: "platform-admin-token", actorType: "platform_user",
      action: "cdk.disable.request", targetType: "order", targetId: order.id, requestId: request.id});
    const voucher = await runtime.cdk.disable(order.id);
    return {data: {order_id: order.id, voucher_status: voucher.status, service_fee_refund_status: "not_requested"}};
  });

  app.post<{Params: {orderId: string; fulfillmentId: string}}>("/internal/admin/api/supply/test-orders/:orderId/fulfillments/:fulfillmentId/:action", async (request) => {
    const params = z.object({orderId: z.string(), fulfillmentId: z.string(), action: z.enum(["approve", "cancel"])}).parse(request.params);
    const order = runtime.repository.findOrderInternal(params.orderId);
    const task = order && runtime.repository.findFulfillment(order.merchantId, params.fulfillmentId);
    if (!order?.liveTest || !task || task.orderId !== order.id) throw new AppError(404, "test_task_not_found", "联调任务不存在");
    if (params.action === "approve") z.object({acknowledge_real_charge: z.literal(true)}).strict().parse(request.body);
    else z.object({confirm_cancel: z.literal(true)}).strict().parse(request.body);
    return runtime.repository.transaction(() => {
      const result = params.action === "approve" ? runtime.fulfillments.approveLiveSubmission(order.merchantId, task.id)
        : runtime.fulfillments.cancelQueued(order.merchantId, task.id);
      runtime.audit.record({merchantId: order.merchantId, actorId: "platform-admin-token", actorType: "platform_user",
        action: "recharge.test." + params.action, targetType: "fulfillment", targetId: task.id, requestId: request.id});
      return {data: {order_id: order.id, fulfillment_id: task.id, status: result.status, submission_approved: result.liveSubmissionApproved === true}};
    });
  });

  app.put("/internal/admin/api/supply/connection", async (request) => {
    const input = connectionSchema.parse(request.body);
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
      ...(input.config_version === undefined ? {} : {expectedVersion: input.config_version}),
    });
    runtime.audit.record({merchantId: null, actorId: "platform-admin-token", actorType: "platform_user", action: "supplier.connection.update", targetType: "supplier_connection", targetId: value.id, requestId: request.id});
    return {data: value};
  });

  app.post("/internal/admin/api/supply/test", async (request) => {
    const value = await runtime.supplierManagement.testConnection();
    runtime.audit.record({merchantId: null, actorId: "platform-admin-token", actorType: "platform_user", action: "supplier.connection.test", targetType: "supplier_connection", targetId: "supplier_primary", requestId: request.id});
    return {data: value};
  });

  app.get("/internal/admin/api/supply/balance", async () => ({data: await runtime.supplierManagement.getBalance()}));
  app.get("/internal/admin/api/supply/plans", async () => ({data: runtime.supplierManagement.listPlans().map(publicPlan)}));

  app.post("/internal/admin/api/supply/plans/sync", async (request) => {
    const values = await runtime.supplierManagement.syncPlans();
    runtime.audit.record({merchantId: null, actorId: "platform-admin-token", actorType: "platform_user", action: "supplier.plans.sync", targetType: "supplier_connection", targetId: "supplier_primary", requestId: request.id});
    return {data: values.map(publicPlan)};
  });

  app.get("/internal/admin/api/supply/mappings", async () => ({data: runtime.supplierManagement.listMappings().map(publicMapping)}));

  app.put<{Params: {productCode: string}}>("/internal/admin/api/supply/mappings/:productCode", async (request) => {
    const productCode = z.string().min(1).max(64).parse(request.params.productCode);
    const input = mappingSchema.parse(request.body);
    const value = runtime.supplierManagement.saveMapping({
      productCode,
      fulfillmentMode: input.fulfillment_mode,
      supplierProduct: input.supplier_product,
      supplierPlan: input.supplier_plan,
      enabled: input.enabled,
    });
    runtime.audit.record({merchantId: null, actorId: "platform-admin-token", actorType: "platform_user", action: "supplier.mapping.update", targetType: "product_mapping", targetId: productCode, requestId: request.id});
    return {data: publicMapping(value)};
  });

  app.get<{Querystring: {page?: string; page_size?: string}}>("/internal/admin/api/supply/reconciliation/direct-orders", async (request) => {
    const input = pageSchema.parse(request.query);
    return {data: await runtime.supplierManagement.listDirectOrders(input.page, input.page_size)};
  });
  app.get<{Querystring: {page?: string; page_size?: string}}>("/internal/admin/api/supply/reconciliation/cdks", async (request) => {
    const input = pageSchema.parse(request.query);
    return {data: await runtime.supplierManagement.listCdks(input.page, input.page_size)};
  });
  app.get<{Querystring: {page?: string; page_size?: string}}>("/internal/admin/api/supply/reconciliation/cdk-orders", async (request) => {
    const input = pageSchema.parse(request.query);
    return {data: await runtime.supplierManagement.listCdkOrders(input.page, input.page_size)};
  });
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

function adminPage(reply: FastifyReply): string {
  reply.header("cache-control", "no-store")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
    .type("text/html; charset=utf-8");
  // Keep the standalone emergency console GPT-only as well. The main
  // operations workspace is the preferred UI, but this route remains useful
  // when portal authentication is unavailable.
  return gptOnlyAdminPage();
  /* c8 ignore next 1 -- retained only as a rollback copy for this release */
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quefa 充值供应管理</title><style>body{margin:0;background:#f5f7fb;color:#172033;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:1100px;margin:32px auto;padding:0 20px}.card{background:#fff;border-radius:16px;padding:22px;margin:16px 0;box-shadow:0 8px 28px #17203312}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}label{display:block;font-size:13px;color:#475467}input,select{box-sizing:border-box;width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-top:5px}button{padding:10px 15px;border:0;border-radius:8px;background:#1769ff;color:#fff;cursor:pointer}.secondary{background:#344054}.danger{background:#b42318}.muted{color:#667085}.status{padding:12px;background:#f0f6ff;border-radius:10px;white-space:pre-wrap;word-break:break-all}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #eaecf0;padding:9px}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>Quefa 充值供应管理</h1><p class="muted">仅管理余额、套餐、直充、CDK、回调与对账；本后台不提供任何开卡、卡号、CVV、卡充值、卡退款或卡冻结功能。</p><section class="card"><div class="grid"><label>平台管理令牌<input id="token" type="password" autocomplete="off"></label><div class="row"><button id="load">读取配置</button><button id="test" class="secondary">测试连接</button><button id="balance" class="secondary">查询余额</button></div></div></section><section class="card"><h2>供应连接</h2><p id="execution" class="muted">请先读取配置，确认当前履约模式。</p><div class="grid"><label>内部名称<input id="name"></label><label>环境<select id="environment"><option value="sandbox">沙箱</option><option value="production">生产</option></select></label><label>OpenAPI 基础地址<input id="apiBase"></label><label>CDK 基础地址<input id="cdkBase"></label><label>新 API Key（留空不变）<input id="apiKey" type="password" autocomplete="new-password"></label><label>新 Webhook Secret（留空不变）<input id="webhookSecret" type="password" autocomplete="new-password"></label><label>直充支付资源编号（只写、内部使用）<input id="resourceId" type="number" min="1"></label><label><input id="enabled" type="checkbox" style="width:auto"> 启用该供应连接</label></div><p><button id="save">保存配置</button></p></section><section class="card"><h2>套餐同步与商品映射</h2><div class="row"><button id="sync">同步 GPT / Claude / Grok 套餐</button><button id="plans" class="secondary">查看套餐</button><button id="mappings" class="secondary">查看映射</button></div><div class="grid" style="margin-top:16px"><label>Quefa 商品编号<input id="productCode" value="chatgpt_plus_1m"></label><label>履约模式<select id="mode"><option value="direct">直接充值</option><option value="cdk">Quefa CDK</option></select></label><label>供应产品<select id="supplierProduct"><option>gpt</option><option>claude</option><option>grok</option></select></label><label>供应套餐<input id="supplierPlan" value="plus"></label><label><input id="mappingEnabled" type="checkbox" checked style="width:auto"> 启用商品映射</label></div><p><button id="saveMapping">保存商品映射</button></p></section><section class="card"><h2>只读对账</h2><div class="row"><button id="directOrders" class="secondary">直充订单</button><button id="cdks" class="secondary">CDK库存</button><button id="cdkOrders" class="secondary">CDK兑换订单</button></div></section><section class="card"><h2>结果</h2><pre id="output" class="status">等待操作</pre></section></main><script>let configVersion;const $=id=>document.getElementById(id),out=value=>$('output').textContent=JSON.stringify(value,null,2);const headers=()=>({'x-platform-admin-token':$('token').value,'content-type':'application/json'});async function call(path,opt={}){const response=await fetch(path,{...opt,headers:{...headers(),...(opt.headers||{})}}),json=await response.json().catch(()=>({}));out(json);if(!response.ok)throw new Error(json.error?.message||'请求失败');return json}function fill(x){configVersion=x.config_version;$('execution').textContent=x.execution_mode==='mock'?'当前为模拟履约，启用供应连接后仍不会自动切换真实充值。':'当前为供应接口履约，请确认沙箱或生产环境。';$('name').value=x.name;$('environment').value=x.environment;$('apiBase').value=x.open_api_base;$('cdkBase').value=x.cdk_base;$('enabled').checked=x.enabled}$('load').onclick=async()=>fill((await call('/internal/admin/api/supply/connection')).data);$('save').onclick=async()=>{if(configVersion===undefined){out({error:{message:'请先读取配置再保存'}});return}const body={config_version:configVersion,name:$('name').value,environment:$('environment').value,open_api_base:$('apiBase').value,cdk_base:$('cdkBase').value,enabled:$('enabled').checked};if($('apiKey').value)body.api_key=$('apiKey').value;if($('webhookSecret').value)body.webhook_secret=$('webhookSecret').value;if($('resourceId').value)body.direct_payment_resource_id=Number($('resourceId').value);fill((await call('/internal/admin/api/supply/connection',{method:'PUT',body:JSON.stringify(body)})).data);$('apiKey').value='';$('webhookSecret').value='';$('resourceId').value=''};$('test').onclick=()=>call('/internal/admin/api/supply/test',{method:'POST',body:'{}'});$('balance').onclick=()=>call('/internal/admin/api/supply/balance');$('sync').onclick=()=>call('/internal/admin/api/supply/plans/sync',{method:'POST',body:'{}'});$('plans').onclick=()=>call('/internal/admin/api/supply/plans');$('mappings').onclick=()=>call('/internal/admin/api/supply/mappings');$('saveMapping').onclick=()=>call('/internal/admin/api/supply/mappings/'+encodeURIComponent($('productCode').value),{method:'PUT',body:JSON.stringify({fulfillment_mode:$('mode').value,supplier_product:$('supplierProduct').value,supplier_plan:$('supplierPlan').value,enabled:$('mappingEnabled').checked})});$('directOrders').onclick=()=>call('/internal/admin/api/supply/reconciliation/direct-orders');$('cdks').onclick=()=>call('/internal/admin/api/supply/reconciliation/cdks');$('cdkOrders').onclick=()=>call('/internal/admin/api/supply/reconciliation/cdk-orders');window.addEventListener('unhandledrejection',e=>{e.preventDefault();out({error:{message:e.reason?.message||'网络请求失败，请重试'}})});</script></body></html>`;
}

function gptOnlyAdminPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quefa GPT 供应管理</title><style>body{margin:0;background:#f5f7fb;color:#172033;font-family:system-ui,-apple-system,sans-serif}.wrap{max-width:960px;margin:32px auto;padding:0 20px}.card{background:#fff;border-radius:16px;padding:22px;margin:16px 0;box-shadow:0 8px 28px #17203312}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}label{display:block;font-size:13px;color:#475467}input,select{box-sizing:border-box;width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-top:5px}button{padding:10px 15px;border:0;border-radius:8px;background:#1769ff;color:#fff;cursor:pointer}.secondary{background:#344054}.muted{color:#667085}.status{padding:12px;background:#f0f6ff;border-radius:10px;white-space:pre-wrap;word-break:break-all}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>Quefa GPT 供应管理</h1><p class="muted">仅管理 GPT 订阅直充、Plus CDK 与 Codex 点数 CDK。所有商品映射默认停用，同步后按需逐项启用。</p><section class="card"><div class="grid"><label>平台管理令牌<input id="token" type="password" autocomplete="off"></label><div class="row"><button id="load">读取配置</button><button id="test" class="secondary">测试连接</button><button id="balance" class="secondary">查询余额</button></div></div></section><section class="card"><h2>GPT 套餐与映射</h2><div class="row"><button id="sync">同步 GPT 套餐</button><button id="plans" class="secondary">查看套餐</button><button id="mappings" class="secondary">查看映射</button></div><div class="grid" style="margin-top:16px"><label>Quefa 商品编号<input id="productCode" value="chatgpt_plus_1m"></label><label>履约模式<select id="mode"><option value="direct">直接充值</option><option value="cdk">Quefa CDK</option></select></label><label>供应产品<input id="supplierProduct" value="gpt" readonly></label><label>上游 GPT 套餐<input id="supplierPlan" value="plus"></label><label><input id="mappingEnabled" type="checkbox" style="width:auto"> 启用商品映射</label></div><p><button id="saveMapping">保存商品映射</button></p></section><section class="card"><h2>结果</h2><pre id="output" class="status">等待操作</pre></section></main><script>const $=id=>document.getElementById(id),out=value=>$('output').textContent=JSON.stringify(value,null,2),headers=()=>({'x-platform-admin-token':$('token').value,'content-type':'application/json'});async function call(path,opt={}){const response=await fetch(path,{...opt,headers:{...headers(),...(opt.headers||{})}}),json=await response.json().catch(()=>({}));out(json);if(!response.ok)throw new Error(json.error?.message||'请求失败');return json}$('load').onclick=()=>call('/internal/admin/api/supply/connection');$('test').onclick=()=>call('/internal/admin/api/supply/test',{method:'POST',body:'{}'});$('balance').onclick=()=>call('/internal/admin/api/supply/balance');$('sync').onclick=()=>call('/internal/admin/api/supply/plans/sync',{method:'POST',body:'{}'});$('plans').onclick=()=>call('/internal/admin/api/supply/plans');$('mappings').onclick=()=>call('/internal/admin/api/supply/mappings');$('saveMapping').onclick=()=>call('/internal/admin/api/supply/mappings/'+encodeURIComponent($('productCode').value),{method:'PUT',body:JSON.stringify({fulfillment_mode:$('mode').value,supplier_product:'gpt',supplier_plan:$('supplierPlan').value,enabled:$('mappingEnabled').checked})});window.addEventListener('unhandledrejection',e=>{e.preventDefault();out({error:{message:e.reason?.message||'网络请求失败，请重试'}})});</script></body></html>`;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
