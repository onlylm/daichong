import type {FastifyInstance, FastifyRequest, FastifyReply} from "fastify";
import {z} from "zod";
import {createHash} from "node:crypto";
import type {AppConfig} from "../config.js";
import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";
import {merchantMargin, minorToMoney, moneyToMinor, UNBOUNDED_MAX_SALE_PRICE_MINOR} from "../domain/money.js";
import type {Merchant, Order, Refund} from "../domain/model.js";
import {accountRoles, orderVisibilityFields, type Account, type Actor} from "./model.js";
import {isPlatform, permissionList, publicAccount, requirePermission, requireTenantScope} from "./accounts.js";
import {registerPaymentSettingsRoutes} from "./payment-routes.js";
import {registerSupplierWorkspaceRoutes} from "./supplier-routes.js";
import {managedGptProduct, managedGptProducts} from "../modules/gpt-products.js";
import {partnerFulfillmentDetails, partnerFulfillmentMessage} from "../modules/fulfillment-public.js";
import {listWorkspaceOrders, platformOrderTrace, workspaceOrderDetail, workspacePayUrl} from "./order-view.js";
import {requireWorkspaceRechargeOrder, resolveAutoRechargeUpstreamCode, workspaceSubmitRecharge} from "./workspace-recharge.js";

import {assertAdminWorkspaceHost, assertPartnerWorkspaceHost, assertWorkspaceRoleHost, resolveWorkspaceHost} from "./workspace-host.js";
import {effectiveCollectionModes} from "./agents.js";
import {financeDrilldown, financeMetrics} from "./finance-drilldown.js";
import {listGlobalWorkspaceProducts, saveGlobalWorkspaceProduct, seedGlobalProductCatalog} from "./global-product-catalog.js";
import {queryRecords} from "../infra/record-query.js";

const text = z.string().trim().min(1).max(5000);
const identifier = z.string().min(1).max(160);
// Browser number inputs naturally submit `1000` or `1000.5`. Accept those
// exact decimal forms and canonicalise them before they reach moneyToMinor.
// This remains string based so floating point rounding never enters a wallet
// or order amount.
const money = z.string()
  .regex(/^(0|[1-9]\d{0,6})(?:\.\d{1,2})?$/, "金额最多保留两位小数")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });
const requestKey = z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/);
const invoiceDetailsInput = z.object({
  invoiceTitle: z.string().trim().min(2).max(120),
  taxId: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15,20}$/),
  recipientEmail: z.string().trim().email().max(254),
  contactName: z.string().trim().min(2).max(80),
  contactPhone: z.string().trim().regex(/^[0-9+() -]{6,30}$/).nullable().optional(),
  remark: z.string().trim().max(500).nullable().optional(),
});
const receipt = z.string().trim().regex(/^[a-zA-Z0-9:_.-]{6,120}$/).transform(s => s.toLowerCase());
const ticketInput = z.object({merchantId: identifier.optional(), orderId: identifier.nullable().default(null), title: z.string().trim().min(1).max(120),
  category: z.enum(["payment", "cdk", "recharge", "refund", "wallet", "other"]), body: text}).strict();
const announcementInput = z.object({
  id: identifier.optional(), version: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).max(120), body: text,
  status: z.enum(["draft", "published", "withdrawn"]), audience: z.enum(["all", "merchants", "tiers"]),
  merchantIds: z.array(identifier).max(500).default([]), tierCodes: z.array(z.string().max(32)).max(20).default([]),
  pinned: z.boolean().default(false), startsAt: z.coerce.date(), endsAt: z.coerce.date().nullable().default(null),
}).strict();
type UserRequest = FastifyRequest & {account?: Account; sessionToken?: string};
function account(request: FastifyRequest): Account {
  const found = (request as UserRequest).account;
  if (!found) throw new AppError(401, "login_required", "请先登录");
  return found;
}
function scope(actor: Actor, requested?: string): string {
  const id = requested || actor.merchantId;
  if (!id) throw new AppError(422, "merchant_required", "请选择代理商");
  requireTenantScope(actor, id); return id;
}
function orderMerchantIds(actor: Actor, repository: Runtime["repository"], requested?: string): string[] {
  if (isPlatform(actor) && (!requested || requested === "all")) {
    return repository.listMerchants().map(merchant => merchant.id);
  }
  return [scope(actor, requested)];
}
export function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

function workspaceRefund(runtime: Runtime, refund: Refund) {
  const order = runtime.repository.findOrder(refund.merchantId, refund.orderId);
  const merchant = runtime.repository.findMerchantById(refund.merchantId);
  return {
    id: refund.id, orderId: refund.orderId, merchantId: refund.merchantId, merchantName: merchant?.name ?? "",
    partnerId: merchant?.partnerId ?? "", type: refund.type, amount: minorToMoney(refund.amountMinor), status: refund.status,
    reason: refund.reason, failureCode: refund.failureCode, createdAt: refund.createdAt.toISOString(),
    refundedAt: refund.refundedAt?.toISOString() ?? null,
    marginRemaining: order ? minorToMoney(merchantMargin(order)) : null,
  };
}

function workspaceRefunds(runtime:Runtime,refunds:Refund[]) {
  const orders=runtime.repository.findOrdersInternal(refunds.map(item=>item.orderId));
  const orderMap=new Map<string,Order>(orders.map(item=>[item.id,item]));
  const merchantMap=new Map<string,Merchant>(runtime.repository.listMerchants().map(item=>[item.id,item]));
  return refunds.map(refund=>{
    const order=orderMap.get(refund.orderId)??null;
    const merchant=merchantMap.get(refund.merchantId);
    return {id:refund.id,orderId:refund.orderId,merchantId:refund.merchantId,merchantName:merchant?.name??"",
      partnerId:merchant?.partnerId??"",type:refund.type,amount:minorToMoney(refund.amountMinor),status:refund.status,
      reason:refund.reason,failureCode:refund.failureCode,createdAt:refund.createdAt.toISOString(),
      refundedAt:refund.refundedAt?.toISOString()??null,marginRemaining:order?minorToMoney(merchantMargin(order)):null};
  });
}

export function registerOperationsRoutes(app: FastifyInstance, config: AppConfig, runtime: Runtime): void {
  const adminBaseUrl = config.adminBaseUrl ?? config.publicBaseUrl;
  const origins = new Set([new URL(config.publicBaseUrl).origin, new URL(adminBaseUrl).origin]);
  const secure = new URL(adminBaseUrl).protocol === "https:";
  const cookieName = secure ? "__Host-quefa_account" : "quefa_account";
  const cookie = (reply: FastifyReply, token: string, clear = false) => reply.header("set-cookie",
    cookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + (clear ? "0" : "28800") + (secure ? "; Secure" : ""));

  app.addHook("preValidation", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    if (!route.startsWith("/workspace/api/")) return;
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (!["GET", "HEAD"].includes(request.method) && !origins.has(String(request.headers.origin ?? ""))) throw new AppError(403, "origin_denied", "请求来源无效");
    if (["/workspace/api/auth/login", "/workspace/api/auth/mfa/verify", "/workspace/api/auth/register", "/workspace/api/auth/config"].includes(route)) return;
    const cookies = (request.headers.cookie ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(cookieName + "="));
    if (cookies.length !== 1) throw new AppError(401, "login_required", "请先登录");
    const token = cookies[0]!.slice(cookieName.length + 1);
    const actor = runtime.accounts.authenticate(token);
    if (!["GET", "HEAD"].includes(request.method) && !runtime.accounts.verifyCsrf(token, String(request.headers["x-csrf-token"] ?? ""))) throw new AppError(403, "csrf_denied", "会话校验失败，请刷新页面");
    if (actor.mustChangePassword && !["/workspace/api/auth/me", "/workspace/api/auth/password", "/workspace/api/auth/logout"].includes(route)) throw new AppError(403, "password_change_required", "首次登录请先修改初始密码");
    assertWorkspaceRoleHost(actor, resolveWorkspaceHost(request, config), config);
    (request as UserRequest).account = actor; (request as UserRequest).sessionToken = token;
  });

  app.get("/workspace/api/notifications/tasks", async request => {
    const q=z.object({page:z.coerce.number().int().positive().default(1),limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);
    return wire(runtime.notifications.tasksPage(account(request),q.page,q.limit));
  });
  app.get("/workspace/api/action-center", async request => {
    const actor = account(request);
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台后台可查看运营待办");
    const permissions = new Set(permissionList(actor));
    const canReviewWallet = permissions.has("*") || permissions.has("wallet.review");
    const canReadWallet = permissions.has("*") || permissions.has("wallet.read");
    const taskPage = runtime.notifications.tasksPage(actor, 1, 8);
    const refundPage = canReviewWallet ? runtime.refunds.pendingPage(actor, 8) : {data: [], meta: {total: 0}};
    const settlementPage = canReadWallet ? runtime.dailySettlements.pendingPage(actor, 8) : {data: [], meta: {total: 0}};
    const ticketPage = runtime.support.pendingAgentPage(actor, 8);
    const invoicePage = permissions.has("*") || permissions.has("invoices.manage")
      ? runtime.invoices.pendingPage(actor, 8) : {data: [], meta: {total: 0}};
    return wire({data: {
      counts: {tasks: taskPage.meta.total, refunds: refundPage.meta.total,
        settlements: settlementPage.meta.total, tickets: ticketPage.meta.total, invoices: invoicePage.meta.total},
      tasks: taskPage.data,
      refunds: workspaceRefunds(runtime, refundPage.data),
      settlements: settlementPage.data,
      tickets: ticketPage.data,
      invoices: invoicePage.data,
    }});
  });
  app.get("/workspace/api/finance/costs", async request => {
    const query=z.object({page:z.coerce.number().int().positive().default(1),limit:z.coerce.number().int().min(1).max(100).default(20),
      status:z.enum(["all","pending_review","confirmed","disputed"]).default("all"),search:z.string().trim().max(160).default("")}).parse(request.query);
    return wire(runtime.costs.page(account(request),query));
  });
  app.get("/workspace/api/finance/details", async request => {
    const q=z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),metric:z.enum(financeMetrics),
      page:z.coerce.number().int().positive().default(1),limit:z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    return wire(financeDrilldown(runtime.repository,account(request),q));
  });
  app.get<{Params:{id:string}}>("/workspace/api/orders/:id/cost", async request => wire({data:runtime.costs.view(account(request),request.params.id)}));
  app.post<{Params:{id:string}}>("/workspace/api/orders/:id/cost/sync", async request => wire({data:await runtime.costs.sync(account(request),request.params.id)}));
  app.put<{Params:{id:string}}>("/workspace/api/orders/:id/cost", async request => {
    const input=z.object({version:z.number().int().nonnegative(),standardUsd:money.nullable().optional(),standardCny:money.nullable().optional(),actualUsd:money,feesUsd:money,retainedUsd:money,
      fxRate:z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).nullable().optional(),sourceReference:z.string().trim().min(6).max(160),evidence:z.string().trim().min(6).max(1000),
      confirmEvidence:z.literal(true),confirmHistoricalTerms:z.boolean().optional(),confirmZeroCost:z.boolean().optional(),destination:z.enum(["customer_direct","platform_pass_through"]).nullable()}).strict().parse(request.body);
    return wire({data:runtime.costs.verify(account(request),request.params.id,input)});
  });
  app.post<{Params:{id:string}}>("/workspace/api/orders/:id/cost/payments", async request => {
    const input=z.object({version:z.number().int().nonnegative(),usd:money,currency:z.enum(["USD","CNY"]),amount:money,fxRate:z.string().regex(/^\d{1,3}(\.\d{1,6})?$/).optional(),
      method:z.string().trim().min(2).max(50),reference:z.string().trim().min(6).max(160),evidence:z.string().trim().min(6).max(1000),requestKey:z.string().min(8).max(80),confirmActualPayout:z.literal(true)}).strict().parse(request.body);
    return wire({data:runtime.costs.recordPayment(account(request),request.params.id,input)});
  });
  app.get("/workspace/api/notifications/settings", async request => wire({data:runtime.notifications.settings(account(request))}));
  app.post<{Params:{id:string}}>("/workspace/api/orders/:id/cost/customer-receipt", async request => {
    const input=z.object({version:z.number().int().nonnegative(),evidence:z.string().trim().min(6).max(1000),confirmCustomerReceived:z.literal(true)}).strict().parse(request.body);
    return wire({data:runtime.costs.confirmReceipt(account(request),request.params.id,input)});
  });
  app.put("/workspace/api/notifications/settings", async request => {
    const input=z.object({enabled:z.boolean(),host:z.enum(["smtp.qiye.aliyun.com","smtphk.qiye.aliyun.com"]),username:z.string().email().max(254),
      adminEmail:z.string().email().max(254),password:z.string().min(1).max(1024).optional(),version:z.number().int().nonnegative()}).strict().parse(request.body);
    return wire({data:runtime.notifications.saveSettings(account(request),input)});
  });
  app.post("/workspace/api/notifications/verify", async request => wire({data:await runtime.notifications.verify(account(request))}));
  app.get("/workspace/api/notifications/preferences", async request => wire({data:runtime.notifications.preference(account(request))}));
  app.put("/workspace/api/notifications/preferences", async request => {
    const input=z.object({email:z.string().email().max(254),enabled:z.boolean(),version:z.number().int().nonnegative()}).strict().parse(request.body);
    return wire({data:runtime.notifications.savePreference(account(request),input)});
  });
  app.get("/workspace/api/notifications/jobs", async request => wire({data:runtime.notifications.jobs(account(request))}));
  app.post<{Params:{id:string}}>("/workspace/api/notifications/jobs/:id/retry", async request => {
    runtime.notifications.retry(account(request),request.params.id);return {ok:true};
  });

  app.post("/workspace/api/auth/login", async (request, reply) => {
    const host = resolveWorkspaceHost(request, config);
    const input = z.object({username: z.string().min(1).max(80), password: z.string().min(1).max(1024)}).strict().parse(request.body);
    const result = await runtime.accounts.login(input.username, input.password, request.ip);
    if ("mfa" in result) {
      assertAdminWorkspaceHost(host, config);
      return {mfa: {required: true, challenge_token: result.mfa.challengeToken,
        enrollment: result.mfa.enrollment, secret: result.mfa.secret, otpauth_uri: result.mfa.otpauthUri}};
    }
    assertWorkspaceRoleHost(result.account, host, config);
    cookie(reply, result.token);
    return {data: publicAccount(result.account), csrf: result.csrf, permissions: permissionList(result.account)};
  });
  app.get("/workspace/api/auth/config", async () => ({registrationEnabled: config.registrationEnabled}));
  app.post("/workspace/api/auth/register", async (request, reply) => {
    assertPartnerWorkspaceHost(resolveWorkspaceHost(request, config), config);
    const input = z.object({email: z.string().trim().email().max(80), password: z.string().min(8).max(1024)}).strict().parse(request.body);
    const result = await runtime.agents.register(runtime.accounts, input, request.ip);
    cookie(reply, result.token);
    return {data: publicAccount(result.account), csrf: result.csrf, permissions: permissionList(result.account),
      merchantId: result.account.merchantId};
  });
  app.post("/workspace/api/auth/mfa/verify", async (request, reply) => {
    assertAdminWorkspaceHost(resolveWorkspaceHost(request, config), config);
    const input = z.object({challenge_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().trim().min(6).max(32)}).strict().parse(request.body);
    const result = runtime.accounts.verifyMfa(input.challenge_token, input.code);
    cookie(reply, result.token);
    return {data: publicAccount(result.account), csrf: result.csrf, permissions: permissionList(result.account),
      ...(result.recoveryCodes ? {recovery_codes: result.recoveryCodes} : {})};
  });
  app.get("/workspace/api/auth/me", async request => ({data: publicAccount(account(request)), csrf: runtime.accounts.csrf((request as UserRequest).sessionToken!), permissions: permissionList(account(request))}));
  app.post("/workspace/api/auth/logout", async (request, reply) => {runtime.accounts.logout((request as UserRequest).sessionToken!); cookie(reply, "", true); return {ok: true};});
  app.post("/workspace/api/auth/password", async (request, reply) => {
    const input = z.object({currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(8).max(1024)}).strict().parse(request.body);
    await runtime.accounts.changePassword(account(request), input.currentPassword, input.newPassword); cookie(reply, "", true); return {ok: true};
  });
  app.get("/workspace/api/accounts", async request => ({data: runtime.accounts.list(account(request))}));
  app.get<{Querystring: {merchantId?: string}}>("/workspace/api/products", async request => {
    const actor = account(request); requirePermission(actor, "orders.read");
    const merchantId = scope(actor, request.query.merchantId);
    const configuredAll = runtime.repository.listProductGrants(merchantId)
      .filter(grant => grant.upstreamProduct === "gpt" && managedGptProduct(grant.productCode))
      .map(grant => runtime.catalog.configuredGrant(grant));
    const effective = new Map(runtime.catalog.listConfigured(merchantId).map(product => [product.productCode, product]));
    const configured = isPlatform(actor) ? configuredAll : configuredAll.filter(grant => grant.available);
    return {data: configured.map(grant => {
      const p = effective.get(grant.productCode) ?? grant;
      const discountBps = p.supplyPriceMinor < grant.supplyPriceMinor && grant.supplyPriceMinor > 0n
        ? Number((grant.supplyPriceMinor - p.supplyPriceMinor) * 10_000n / grant.supplyPriceMinor) : 0;
      return {code: p.productCode, name: p.name, mode: p.fulfillmentMode,
        deliveryModes: p.fulfillmentMode === "cdk" ? ["auto_recharge", "cdk"] : ["auto_recharge"],
        supplyPrice: minorToMoney(p.supplyPriceMinor), listSupplyPrice: minorToMoney(grant.supplyPriceMinor),
        tierDiscountBps: discountBps, maxSalePrice: minorToMoney(p.maxSalePriceMinor),
        ...(() => {const state = runtime.catalog.availability(grant); return isPlatform(actor) ? state : {
          available: state.available, configuredAvailable: state.configuredAvailable,
          unavailableReason: state.available ? null : "当前套餐暂不可售，请稍后再试",
        };})(),
        priceVersion: p.priceVersion};
    }),
      collectionModes: effectiveCollectionModes(runtime.repository, merchantId),
      paymentMethods: runtime.paymentSettings.available().map(c => ({code: c === "alipay_page" ? "alipay" : "usdt", name: c === "alipay_page" ? "支付宝" : "USDT"}))};
  });
  app.put<{Params: {productCode: string}}>("/workspace/api/products/:productCode", async request => {
    const actor = account(request); requirePermission(actor, "agents.manage");
    throw new AppError(410, "global_catalog_required", "商品已改为全局统一管理，请在商品管理中修改");
  });
  app.get<{Querystring: {merchantId?: string; productCode?: string; search?: string; status?: string; page?: string; limit?: string}}>("/workspace/api/orders", async request => {
    const actor = account(request); requirePermission(actor, "orders.read");
    const query = z.object({
      merchantId: z.string().optional(),
      productCode: z.string().min(1).max(64).optional(),
      search: z.string().min(1).max(120).optional(),
      status: z.enum(["all", "pending", "paid", "running", "succeeded", "failed", "refunded"]).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(15),
    }).parse(request.query);
    const merchantIds = orderMerchantIds(actor, runtime.repository, query.merchantId);
    const merchantNames = new Map(runtime.repository.listMerchants().map(merchant => [merchant.id, merchant.name]));
    const listed = listWorkspaceOrders(runtime.repository, actor, merchantIds, merchantNames,
      merchantId => runtime.agents.profile(merchantId).orderVisibility ?? [], {
        page: query.page,
        limit: query.limit,
        status: query.status,
        ...(query.productCode ? {productCode: query.productCode} : {}),
        ...(query.search ? {search: query.search} : {}),
      });
    return wire(listed);
  });
  app.get<{Params: {id: string}}>("/workspace/api/orders/:id/platform-trace", async (request, reply) => {
    const actor = account(request);
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    requirePermission(actor, "orders.read");
    const order = runtime.repository.findOrderInternal(request.params.id);
    if (!order) throw new AppError(404, "order_not_found", "订单不存在");
    if (actor.role !== "platform_admin") throw new AppError(403, "permission_denied", "仅管理员可查看供应 CDK");
    reply.header("Cache-Control", "no-store");
    runtime.audit.record({merchantId: order.merchantId, actorId: actor.id, actorType: "platform_user",
      action: "order.upstream_cdk.view", targetType: "order", targetId: order.id, requestId: request.id});
    return wire({data: platformOrderTrace(runtime.repository, runtime.cdk, order.id)});
  });
  app.get<{Params: {id: string}}>("/workspace/api/orders/:id", async request => {
    const actor = account(request);
    requirePermission(actor, "orders.read");
    const order = runtime.repository.findOrderInternal(request.params.id);
    if (!order) throw new AppError(404, "order_not_found", "订单不存在");
    requireTenantScope(actor, order.merchantId);
    const merchant = runtime.repository.findMerchantById(order.merchantId);
    const permissions = new Set(permissionList(actor));
    return wire({
      data: {...workspaceOrderDetail(
        runtime.repository,
        actor,
        order.id,
        runtime.agents.profile(order.merchantId).orderVisibility ?? [],
        merchant?.name ?? null,
      ), costAccounting: runtime.costs.view(actor, order.id),
        invoiceApplication: permissions.has("*") || permissions.has("invoices.read") ? runtime.invoices.forOrder(actor, order.id) : null,
        canApplyInvoice: !isPlatform(actor) && (permissions.has("*") || permissions.has("invoices.write"))
          && ["paid", "partially_refunded"].includes(order.paymentStatus)},
    });
  });
  app.get<{Querystring: {merchantId?: string; status?: string; page?: string; limit?: string}}>("/workspace/api/invoices", async request => {
    const actor = account(request); requirePermission(actor, "invoices.read");
    const query = z.object({merchantId: z.string().optional(), status: z.enum(["all", "awaiting_payment", "submitted", "processing", "needs_correction", "issued"]).default("all"),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    const {merchantId: requestedMerchantId, ...pageQuery} = query;
    const merchantId = requestedMerchantId && requestedMerchantId !== "all" ? requestedMerchantId : undefined;
    return wire(runtime.invoices.page(actor, {...pageQuery, ...(merchantId ? {merchantId} : {})}));
  });
  app.get<{Params: {id: string}}>("/workspace/api/invoices/:id", async request => wire({data: runtime.invoices.get(account(request), request.params.id)}));
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/invoices", async request => {
    const actor = account(request);
    const input = invoiceDetailsInput.extend({invoiceAmount: money, requestKey}).strict().parse(request.body);
    const application = runtime.invoices.create(actor, request.params.id, input);
    if (application.status !== "awaiting_payment") return wire({data: runtime.invoices.get(actor, application.id), payUrl: null});
    if (!runtime.invoiceAlipay) throw new AppError(503, "invoice_payment_unavailable", "支付宝补差价收款尚未启用");
    const payment = runtime.invoiceAlipay.ensurePayment(actor, application.id);
    return wire({data: runtime.invoices.get(actor, application.id), payUrl: payment.payUrl});
  });
  app.post<{Params: {id: string}}>("/workspace/api/invoices/:id/payments", async request => {
    const actor = account(request); requirePermission(actor, "invoices.write");
    if (!runtime.invoiceAlipay) throw new AppError(503, "invoice_payment_unavailable", "支付宝补差价收款尚未启用");
    const payment = runtime.invoiceAlipay.ensurePayment(actor, request.params.id);
    return wire({data: runtime.invoices.get(actor, request.params.id), payUrl: payment.payUrl});
  });
  app.patch<{Params: {id: string}}>("/workspace/api/invoices/:id", async request => {
    const input = invoiceDetailsInput.extend({version: z.number().int().nonnegative()}).strict().parse(request.body);
    return wire({data: runtime.invoices.revise(account(request), request.params.id, input)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/invoices/:id/review", async request => {
    const input = z.object({action: z.enum(["processing", "needs_correction", "issued"]), version: z.number().int().nonnegative(),
      note: z.string().trim().max(500).optional(), invoiceNo: z.string().trim().max(120).optional()}).strict().parse(request.body);
    return wire({data: runtime.invoices.review(account(request), request.params.id, input)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/customer-refunds", async request => {
    const actor = account(request);
    const input = z.object({
      amount: money.optional(),
      reason: text,
      requestKey,
      approveNow: z.boolean().default(true),
    }).strict().parse(request.body);
    const refund = runtime.refunds.requestCustomerRefund(actor, request.params.id, {
      reason: input.reason,
      requestKey: input.requestKey,
      ...(input.amount ? {amount: input.amount} : {}),
    });
    const completed = input.approveNow ? await runtime.refunds.approve(actor, refund.id) : refund;
    runtime.wallets.reconcileMerchantEarnings(completed.merchantId);
    return wire({data: workspaceRefund(runtime, completed)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/external-customer-refunds", async request => {
    const actor = account(request);
    const input = z.object({
      amount: money.optional(),
      reason: text,
      requestKey,
      providerRefundNo: z.string().trim().min(6).max(128),
      confirmAlreadyRefundedAtChannel: z.literal(true),
    }).strict().parse(request.body);
    const refund = runtime.refunds.recordExternalCustomerRefund(actor, request.params.id, {
      reason: input.reason,
      requestKey: input.requestKey,
      providerRefundNo: input.providerRefundNo,
      confirmAlreadyRefundedAtChannel: true,
      ...(input.amount ? {amount: input.amount} : {}),
    });
    runtime.wallets.reconcileMerchantEarnings(refund.merchantId);
    return wire({data: workspaceRefund(runtime, refund)});
  });
  app.get("/workspace/api/products/catalog", async request => {
    const actor = account(request);
    requirePermission(actor, "orders.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    seedGlobalProductCatalog(runtime.repository);
    return {data: listGlobalWorkspaceProducts(runtime.repository, runtime.catalog).map(product => ({
      code: product.code, name: product.name,
    }))};
  });
  app.get("/workspace/api/products/global", async request => {
    const actor = account(request);
    requirePermission(actor, "orders.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    seedGlobalProductCatalog(runtime.repository);
    return {data: listGlobalWorkspaceProducts(runtime.repository, runtime.catalog)};
  });
  app.put<{Params: {productCode: string}}>("/workspace/api/products/global/:productCode", async request => {
    const actor = account(request);
    requirePermission(actor, "agents.manage");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    const input = z.object({
      name: z.string().trim().min(1).max(100),
      supplyPrice: money,
      available: z.boolean(),
      priceVersion: z.number().int().positive(),
      standardCostUsd: money.nullable().optional(),
      refundBenchmarkUsd: money.nullable().optional(),
      standardCostCny: money.nullable().optional(),
      platformCostCny: money.nullable().optional(),
      retainedFeeUsd: money.optional(),
    }).strict().parse(request.body);
    if(input.refundBenchmarkUsd!==undefined&&input.standardCostUsd!==undefined&&input.refundBenchmarkUsd!==input.standardCostUsd)
      throw new AppError(422,"refund_benchmark_conflict","退差基准与兼容字段不一致，请只提交 refundBenchmarkUsd");
    if(input.platformCostCny!==undefined&&input.standardCostCny!==undefined&&input.platformCostCny!==input.standardCostCny)
      throw new AppError(422,"platform_cost_conflict","我方核算成本字段不一致，请只提交 platformCostCny");
    const benchmark=input.refundBenchmarkUsd!==undefined?input.refundBenchmarkUsd:input.standardCostUsd;
    const platformCost=input.platformCostCny!==undefined?input.platformCostCny:input.standardCostCny;
    const updated = saveGlobalWorkspaceProduct(runtime.repository, request.params.productCode, {
      name: input.name,
      supplyPriceMinor: moneyToMinor(input.supplyPrice),
      available: input.available,
      priceVersion: input.priceVersion,
      ...(benchmark!==undefined ? {refundBenchmarkUsdMinor: benchmark===null ? null : moneyToMinor(benchmark)} : {}),
      ...(platformCost !== undefined ? {standardCostCnyMinor: platformCost === null ? null : moneyToMinor(platformCost)} : {}),
      ...(input.retainedFeeUsd !== undefined ? {retainedFeeUsdMinor: moneyToMinor(input.retainedFeeUsd)} : {}),
    }, runtime.catalog);
    runtime.audit.record({
      merchantId: null,
      actorId: actor.id,
      actorType: "platform_user",
      action: "product.global.update",
      targetType: "product_grant",
      targetId: updated.productCode,
      requestId: request.id,
    });
    return {data: {
      code: updated.productCode,
      name: updated.name,
      supplyPrice: minorToMoney(updated.supplyPriceMinor),
      available: updated.available,
      priceVersion: updated.priceVersion,
      platformCostCny: minorToMoney(updated.standardCostCnyMinor ?? managedGptProduct(updated.productCode)?.costPriceMinor ?? 0n),
      platformProfitCny: minorToMoney(updated.supplyPriceMinor - (updated.standardCostCnyMinor ?? managedGptProduct(updated.productCode)?.costPriceMinor ?? 0n)),
    }};
  });
  app.post("/workspace/api/orders", async request => {
    const actor = account(request); requirePermission(actor, "orders.write");
    const input = z.object({merchantId: identifier.optional(), merchantOrderNo: requestKey, productCode: z.string().min(1).max(64),
      collectionMode: z.enum(["platform_collect", "agent_collect"]), deliveryMode: z.enum(["auto_recharge", "cdk"]).optional(),
      paymentMethod: z.enum(["alipay", "usdt"]).optional(), saleAmount: money}).strict().parse(request.body);
    const merchantId = scope(actor, input.merchantId);
    const merchant = runtime.repository.findMerchantById(merchantId);
    if (!merchant || merchant.status !== "active") throw new AppError(403, "merchant_inactive", "代理商不可下单");
    const portalApp = runtime.repository.transaction(() => runtime.repository.listApps(merchantId).find(a => a.appId === "quefa_web_portal")
      ?? runtime.merchantService.createApp(merchantId, {appId: "quefa_web_portal", name: "Quefa 网页采购入口"}));
    if (portalApp.status !== "active") throw new AppError(403, "app_disabled", "网页采购入口已停用");
    const order = await runtime.orders.create({merchantId, partnerId: merchant.partnerId, appId: portalApp.id, keyId: "account:" + actor.id},
      {...input, quantity: 1, paymentChannel: input.paymentMethod === "usdt" ? "dujiaopay" : input.paymentMethod === "alipay" ? "alipay_page" : undefined});
    runtime.audit.record({merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user",
      action: "order.web.create", targetType: "order", targetId: order.id, requestId: request.id});
    return {data: {id: order.id, collectionMode: order.collectionMode, paymentStatus: order.paymentStatus,
      deliveryMode: order.deliveryMode, payUrl: workspacePayUrl(order), fulfillmentUrl: order.fulfillmentUrl}};
  });
  app.post("/workspace/api/cdks", async (request, reply) => {
    const actor = account(request); requirePermission(actor, "orders.write");
    const input = z.object({merchantId: identifier.optional(), productCode: z.string().min(1).max(64), merchantOrderNo: requestKey}).strict().parse(request.body);
    const merchantId = scope(actor, input.merchantId);
    const merchant = runtime.repository.findMerchantById(merchantId);
    if (!merchant || merchant.status !== "active") throw new AppError(403, "merchant_inactive", "代理商不可生成兑换码");
    const existingOrder = runtime.repository.findOrderByMerchantNo(merchantId, input.merchantOrderNo);
    if (existingOrder) {
      if (existingOrder.productCode !== input.productCode || existingOrder.collectionMode !== "agent_collect" || existingOrder.deliveryMode !== "cdk") {
        throw new AppError(409, "merchant_order_conflict", "该采购请求号已用于其他订单");
      }
      return {data: {orderId: existingOrder.id, voucherCode: existingOrder.voucherCode,
        issuanceStatus: existingOrder.voucherCode ? "issued" : "issuing",
        supplyPrice: minorToMoney(existingOrder.supplyAmountMinor), redeemUrl: existingOrder.fulfillmentUrl}};
    }
    const profile = runtime.agents.profile(merchantId);
    const modes = effectiveCollectionModes(runtime.repository, merchantId, profile);
    if (!modes.includes("agent_collect")) {
      const message = profile.collectionModes.includes("agent_collect")
        ? "采购余额不足，请先充值后再生成兑换码"
        : "当前账号未开通余额采购，无法生成 CDK";
      throw new AppError(403, "collection_mode_denied", message);
    }
    const grant = runtime.catalog.requireGrant(merchantId, input.productCode);
    if (grant.fulfillmentMode !== "cdk") throw new AppError(422, "product_not_cdk", "该商品不支持兑换码交付");
    const portalApp = runtime.repository.transaction(() => runtime.repository.listApps(merchantId).find(a => a.appId === "quefa_web_portal")
      ?? runtime.merchantService.createApp(merchantId, {appId: "quefa_web_portal", name: "Quefa 网页采购入口"}));
    if (portalApp.status !== "active") throw new AppError(403, "app_disabled", "网页采购入口已停用");
    const order = await runtime.orders.create({merchantId, partnerId: merchant.partnerId, appId: portalApp.id, keyId: "account:" + actor.id},
      {merchantOrderNo: input.merchantOrderNo,
        productCode: input.productCode, quantity: 1, saleAmount: minorToMoney(grant.supplyPriceMinor),
        collectionMode: "agent_collect", deliveryMode: "cdk"});
    runtime.audit.record({merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user",
      action: "cdk.generate", targetType: "order", targetId: order.id, requestId: request.id});
    reply.code(202);
    const voucherCode = order.voucherCode;
    const latest = runtime.repository.findOrderInternal(order.id)!;
    return {data: {orderId: latest.id, voucherCode: voucherCode ?? latest.voucherCode,
      issuanceStatus: (voucherCode ?? latest.voucherCode) ? "issued" : "issuing",
      supplyPrice: minorToMoney(grant.supplyPriceMinor), cdkCodePrefix: runtime.cdk.cdkPrefix(merchantId),
      redeemUrl: latest.fulfillmentUrl}};
  });
  const rechargeCredentialSchema = z.discriminatedUnion("mode", [
    z.object({mode: z.literal("session"), session: z.string().min(1).max(32_000)}).strict(),
    z.object({mode: z.literal("access_token"), access_token: z.string().min(1).max(32_000)}).strict(),
    z.object({mode: z.literal("mailbox"), email: z.string().email().max(320), password: z.string().min(1).max(1_000)}).strict(),
  ]);
  const normalizeRechargeCredential = (value: z.infer<typeof rechargeCredentialSchema>) => value.mode === "access_token"
    ? {mode: "access_token" as const, accessToken: value.access_token}
    : value;
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/preflight", async request => {
    const actor = account(request); requirePermission(actor, "orders.write");
    const order = requireWorkspaceRechargeOrder(actor, runtime, request.params.id);
    const credential = normalizeRechargeCredential(rechargeCredentialSchema.parse(request.body));
    const result = await runtime.fulfillments.preflightPublic(order, credential, resolveAutoRechargeUpstreamCode(runtime, order));
    return {data: {account_email: result.accountEmail}};
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/recharge", async request => {
    const actor = account(request); requirePermission(actor, "orders.write");
    const order = requireWorkspaceRechargeOrder(actor, runtime, request.params.id);
    const credential = normalizeRechargeCredential(rechargeCredentialSchema.parse(request.body));
    const fulfillment = workspaceSubmitRecharge(runtime, order, credential);
    runtime.audit.record({merchantId: order.merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user",
      action: "order.recharge.submit", targetType: "fulfillment", targetId: fulfillment.id, requestId: request.id});
    const visibility = runtime.agents.profile(order.merchantId).orderVisibility;
    return {data: {fulfillment_id: fulfillment.id, status: fulfillment.status, message: partnerFulfillmentMessage(fulfillment),
      ...partnerFulfillmentDetails(fulfillment, visibility)}};
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/recharge/cancel", async request => {
    const actor = account(request); requirePermission(actor, "orders.write");
    requireWorkspaceRechargeOrder(actor, runtime, request.params.id);
    throw new AppError(403, "recharge_cancel_forbidden", isPlatform(actor)
      ? "请使用订单详情的取消 / 处理充值入口，明确选择退款或开放重提"
      : "代理商不能主动取消充值；仅在明确失败或平台确认取消后可重新提交原订单");
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/recharge/resolve", async request => {
    const actor = account(request);
    requirePermission(actor, "orders.write");
    if (!isPlatform(actor)) throw new AppError(403, "platform_only", "仅平台管理员可处理取消后的退款或重提");
    const input = z.object({fulfillmentId: identifier, action: z.enum(["retry", "refund"]), reason: z.string().trim().min(1).max(500),
      requestKey, confirmCancel: z.literal(true)}).strict().parse(request.body);
    if (input.action === "refund") requirePermission(actor, "wallet.review");
    const order = runtime.repository.findOrderInternal(request.params.id);
    if (!order) throw new AppError(404, "order_not_found", "订单不存在");
    const routeKey = "workspace:recharge:resolve:" + order.id;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return runtime.repository.transaction(() => {
      const existing = runtime.repository.getIdempotency(order.merchantId, actor.id, routeKey, input.requestKey);
      if (existing) {
        if (existing.requestHash !== hash) throw new AppError(409, "idempotency_conflict", "该处理号已用于不同的充值处理请求");
        return existing.responseBody;
      }
      const task = runtime.repository.findFulfillment(order.merchantId, input.fulfillmentId);
      if (!task || task.orderId !== order.id) throw new AppError(404, "fulfillment_not_found", "充值任务不属于该订单");
      const resolved = runtime.fulfillments.prepareRecovery(order.merchantId, task.id, input.action, input.reason);
      let refund: Refund | null = null;
      let procurementRefunded = false;
      if (input.action === "refund") {
        if (order.collectionMode === "agent_collect") {
          const voucher = runtime.repository.findCdkVoucherByOrder(order.id);
          if (voucher && voucher.status !== "consumed") runtime.repository.updateCdkVoucher({...voucher, status: "disabled", failureCode: "refund_requested"});
          runtime.wallets.refundPurchase(actor, order.id);
          procurementRefunded = true;
        } else {
          refund = runtime.refunds.requestCustomerRefund(actor, order.id, {reason: input.reason, requestKey: input.requestKey});
        }
      }
      const refreshed = runtime.repository.findOrderInternal(order.id)!;
      const body = {data: {order_id: order.id, fulfillment_id: resolved.id, status: resolved.status,
        recovery_action: input.action, retry_allowed: runtime.fulfillments.canResubmit(resolved),
        fallback_recharge_available: Boolean(refreshed.fallbackRechargeAvailable),
        refund_id: refund?.id ?? null, refund_status: refund?.status ?? null, procurement_refunded: procurementRefunded}};
      runtime.audit.record({merchantId: order.merchantId, actorId: actor.id, actorType: "platform_user",
        action: "order.recharge.resolve." + input.action, targetType: "fulfillment", targetId: task.id, requestId: request.id});
      runtime.repository.saveIdempotency({merchantId: order.merchantId, appId: actor.id, routeKey, key: input.requestKey,
        requestHash: hash, responseStatus: 200, responseBody: body});
      return body;
    });
  });
  app.post("/workspace/api/accounts", async request => {
    const actor = account(request);
    const input = z.object({username: z.string().min(3).max(80), displayName: z.string().trim().min(1).max(80), role: z.enum(accountRoles), merchantId: identifier.nullable().optional(), password: z.string().min(8).max(1024)}).strict().parse(request.body);
    const value = await runtime.accounts.create(actor, {...input, merchantId: isPlatform(actor) ? input.merchantId ?? null : scope(actor, input.merchantId ?? undefined)});
    return {data: publicAccount(value)};
  });
  app.patch<{Params: {id: string}}>("/workspace/api/accounts/:id", async request => {
    const input = z.object({role: z.enum(accountRoles), status: z.enum(["active", "disabled"])}).strict().parse(request.body);
    return {data: publicAccount(runtime.accounts.update(account(request), request.params.id, input.role, input.status))};
  });
  app.get("/workspace/api/agents", async request => {
    const actor = account(request); requirePermission(actor, "agents.read");
    return {data: runtime.repository.listMerchants().filter(m => m.status === "active").map(m => ({...m, profile: runtime.agents.profile(m.id)}))};
  });
  app.post("/workspace/api/agents", async request => {
    const input = z.object({partnerId: z.string().trim().min(3).max(64), name: z.string().trim().min(1).max(80)}).strict().parse(request.body);
    return {data: runtime.agents.create(account(request), input)};
  });
  app.get<{Params: {id: string}}>("/workspace/api/agents/:id", async request => {
    const actor = account(request); requirePermission(actor, isPlatform(actor) ? "agents.read" : "tiers.read");
    return wire({data: runtime.agents.summary(actor, request.params.id), rules: runtime.agents.rules()});
  });
  app.get<{Params: {id: string}}>("/workspace/api/agents/:id/accounts", async request => ({
    data: runtime.accounts.listForAgent(account(request), request.params.id),
  }));
  app.get<{Params: {id: string}}>("/workspace/api/agents/:id/activity", async request => {
    const actor = account(request); requirePermission(actor, "agents.read");
    const merchantId = scope(actor, request.params.id);
    if (!runtime.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
    const query = z.object({page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    return wire(queryRecords(runtime.repository, "audit", {merchantId, page: query.page, limit: query.limit,
      orderBy: "createdAt", direction: "desc"}));
  });
  app.put<{Params: {id: string}}>("/workspace/api/agents/:id", async request => {
    const input = z.object({tier: z.string().min(1).max(32), collectionModes: z.array(z.enum(["platform_collect", "agent_collect"])).min(1).max(2),
      customRedemptionEnabled: z.boolean().optional(), cdkCodePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/).optional(),
      cdkCodeTemplate: z.string().trim().min(1).max(120).optional(),
      orderVisibility: z.array(z.enum(orderVisibilityFields)).max(orderVisibilityFields.length).optional(),
      version: z.number().int().nonnegative()}).strict().parse(request.body);
    return {data: runtime.agents.saveProfile(account(request), request.params.id, input)};
  });
  app.patch<{Params: {id: string}}>("/workspace/api/agents/:id/name", async request => {
    const input = z.object({name: z.string().trim().min(1).max(80)}).strict().parse(request.body);
    return {data: runtime.agents.rename(account(request), request.params.id, input)};
  });
  app.patch<{Params: {id: string}}>("/workspace/api/agents/:id/cdk-settings", async request => {
    const input = z.object({cdkCodePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/),
      cdkCodeTemplate: z.string().trim().min(1).max(120).optional(), version: z.number().int().nonnegative()}).strict().parse(request.body);
    return {data: runtime.agents.saveCdkSettings(account(request), request.params.id, input)};
  });
  app.get("/workspace/api/tier-rules", async request => {
    requirePermission(account(request), isPlatform(account(request)) ? "agents.read" : "tiers.read");
    return wire({data: runtime.agents.rules()});
  });
  app.put("/workspace/api/tier-rules", async request => {
    const levelSchema = z.object({code: z.string().min(2).max(32), name: z.string().min(1).max(40), threshold: z.string().regex(/^\d{1,16}$/).transform(BigInt),
      supplyDiscountBps: z.number().int().min(0).max(5000).optional(), maxStaffAccounts: z.number().int().min(1).max(200).optional(),
      apiIncluded: z.boolean().optional(), collectionModes: z.array(z.enum(["platform_collect", "agent_collect"])).max(2).optional(),
      benefits: z.array(z.string().min(1).max(80)).max(20).optional(),
      minDepositMinor: z.string().regex(/^\d{1,16}$/).optional(),
      minAgentCollectShareBps: z.number().int().min(0).max(10_000).optional(),
      productSupplyPrices: z.record(z.string().min(1).max(64), z.string().regex(/^\d{1,16}$/)).optional()}).strict();
    const input = z.object({version: z.number().int().nonnegative(), metric: z.enum(["supply_amount", "completed_orders"]), enabled: z.boolean(),
      levels: z.array(levelSchema).min(1).max(10)}).strict().parse(request.body);
    return wire({data: runtime.agents.saveRules(account(request), {...input, levels: input.levels.map(level => ({
      code: level.code, name: level.name, threshold: level.threshold,
      ...(level.supplyDiscountBps !== undefined ? {supplyDiscountBps: level.supplyDiscountBps} : {}),
      ...(level.maxStaffAccounts !== undefined ? {maxStaffAccounts: level.maxStaffAccounts} : {}),
      ...(level.apiIncluded !== undefined ? {apiIncluded: level.apiIncluded} : {}),
      ...(level.collectionModes !== undefined ? {collectionModes: level.collectionModes} : {}),
      ...(level.benefits !== undefined ? {benefits: level.benefits} : {}),
      ...(level.minDepositMinor !== undefined ? {minDepositMinor: level.minDepositMinor} : {}),
      ...(level.minAgentCollectShareBps !== undefined ? {minAgentCollectShareBps: level.minAgentCollectShareBps} : {}),
      ...(level.productSupplyPrices !== undefined ? {productSupplyPrices: level.productSupplyPrices} : {}),
    }))})});
  });
  app.get("/workspace/api/tickets", async request => {
    const actor = account(request);
    const query = z.object({merchantId: z.string().optional(), status: z.enum(["all", "open", "in_progress", "waiting_agent", "resolved", "closed"]).default("all"),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    const {merchantId: requestedMerchantId, ...pageQuery} = query;
    const merchantId = requestedMerchantId && requestedMerchantId !== "all" ? requestedMerchantId : undefined;
    return wire(runtime.support.page(actor, {...pageQuery, ...(merchantId ? {merchantId} : {})}));
  });
  app.get("/workspace/api/api-access/overview", async request => ({data: runtime.apiAccess.adminOverview(account(request))}));
  app.get<{Querystring: {merchantId?: string}}>("/workspace/api/api-access", async request => {
    const actor = account(request); return wire({data: runtime.apiAccess.summary(actor, scope(actor, request.query.merchantId))});
  });
  app.post("/workspace/api/api-applications", async request => {
    const actor = account(request), input = z.object({merchantId: identifier.optional(), reason: text, requestKey}).strict().parse(request.body);
    const item = runtime.apiAccess.apply(actor, scope(actor, input.merchantId), input.reason, input.requestKey);
    return {data: runtime.support.get(actor, item.id)};
  });
  app.post<{Params: {id: string}}>("/workspace/api/api-applications/:id/review", async request => {
    const actor = account(request), input = z.object({approve: z.boolean(), reason: text, version: z.number().int().positive()}).strict().parse(request.body);
    const item = runtime.apiAccess.review(actor, request.params.id, input.approve, input.reason, input.version);
    return {data: runtime.support.get(actor, item.id)};
  });
  app.post("/workspace/api/api-access/disable", async request => {
    const input = z.object({merchantId: identifier, version: z.number().int().positive(), reason: text}).strict().parse(request.body);
    runtime.apiAccess.disable(account(request), input.merchantId, input.version, input.reason); return {ok: true};
  });
  app.post("/workspace/api/api-access/grant", async request => {
    const input = z.object({merchantId: identifier, reason: text}).strict().parse(request.body);
    runtime.apiAccess.grant(account(request), input.merchantId, input.reason); return {ok: true};
  });
  app.post("/workspace/api/api-access/keys", async (request, reply) => {
    const actor = account(request), input = z.object({merchantId: identifier.optional(), requestKey, name: z.string().trim().min(1).max(80)}).strict().parse(request.body);
    reply.header("cache-control", "no-store");
    return {data: runtime.apiAccess.issueKey(actor, scope(actor, input.merchantId), input.requestKey, input.name)};
  });
  app.post("/workspace/api/api-access/disable-app", async request => {
    const actor = account(request), input = z.object({merchantId: identifier.optional(), appId: identifier}).strict().parse(request.body);
    runtime.apiAccess.disableApp(actor, scope(actor, input.merchantId), input.appId); return {ok: true};
  });
  app.post("/workspace/api/api-access/webhooks", async (request, reply) => {
    const actor = account(request), input = z.object({merchantId: identifier.optional(), url: z.string().url().max(500), requestKey}).strict().parse(request.body);
    reply.header("cache-control", "no-store");
    return {data: runtime.apiAccess.registerWebhook(actor, scope(actor, input.merchantId), input.url, input.requestKey)};
  });
  app.post<{Params: {id: string}}>("/workspace/api/api-access/webhooks/:id/rotate", async (request, reply) => {
    const actor = account(request), input = z.object({merchantId: identifier.optional()}).strict().parse(request.body ?? {});
    reply.header("cache-control", "no-store");
    return {data: runtime.apiAccess.rotateWebhook(actor, scope(actor, input.merchantId), request.params.id)};
  });
  app.post<{Params: {id: string}}>("/workspace/api/api-access/webhooks/:id/disable", async request => {
    const actor = account(request), input = z.object({merchantId: identifier.optional()}).strict().parse(request.body ?? {});
    runtime.apiAccess.disableWebhook(actor, scope(actor, input.merchantId), request.params.id); return {ok: true};
  });
  app.post("/workspace/api/tier-applications", async request => {
    const actor = account(request), input = z.object({merchantId: identifier.optional(), targetTier: identifier, reason: text, requestKey}).strict().parse(request.body);
    const ticket = runtime.agents.applyTier(actor, scope(actor, input.merchantId), input.targetTier, input.reason, input.requestKey);
    return {data: runtime.support.get(actor, ticket.id)};
  });
  app.post<{Params: {id: string}}>("/workspace/api/tier-applications/:id/review", async request => {
    const actor = account(request), input = z.object({approve: z.boolean(), reason: text, version: z.number().int().positive()}).strict().parse(request.body);
    runtime.agents.reviewTier(actor, request.params.id, input.approve, input.reason, input.version);
    return {data: runtime.support.get(actor, request.params.id)};
  });
  app.post("/workspace/api/tickets", async request => {
    const input = ticketInput.parse(request.body); const actor = account(request);
    const value = runtime.support.create(actor, scope(actor, input.merchantId), input);
    return {data: runtime.support.get(actor, value.id)};
  });
  app.get<{Params: {id: string}}>("/workspace/api/tickets/:id", async request => ({data: runtime.support.get(account(request), request.params.id)}));
  app.post<{Params: {id: string}}>("/workspace/api/tickets/:id/messages", async request => {
    const input = z.object({body: text, internal: z.boolean().default(false), version: z.number().int().positive()}).strict().parse(request.body);
    runtime.support.reply(account(request), request.params.id, input.body, input.internal, input.version); return {data: runtime.support.get(account(request), request.params.id)};
  });
  app.patch<{Params: {id: string}}>("/workspace/api/tickets/:id", async request => {
    const input = z.object({status: z.enum(["open", "in_progress", "waiting_agent", "resolved", "closed"]), version: z.number().int().positive(), assigneeId: identifier.nullable().optional()}).strict().parse(request.body);
    runtime.support.transition(account(request), request.params.id, input.status, input.version, input.assigneeId); return {data: runtime.support.get(account(request), request.params.id)};
  });
  app.get("/workspace/api/announcements", async request => ({data: runtime.announcements.list(account(request))}));
  app.post("/workspace/api/announcements", async request => ({data: runtime.announcements.save(account(request), announcementInput.parse(request.body))}));
  app.post<{Params: {id: string}}>("/workspace/api/announcements/:id/read", async request => {runtime.announcements.read(account(request), request.params.id); return {ok: true};});

  app.post<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/adjustments", async request => {
    const input = z.object({account: z.enum(["procurement", "earnings"]), direction: z.enum(["credit", "debit"]), amount: money,
      reason: z.string().trim().min(4).max(500), requestKey, expectedBalance: z.string().regex(/^-?\d+(\.\d{1,2})?$/), confirm: z.literal(true)}).strict().parse(request.body);
    return wire({data: runtime.wallets.adjustBalance(account(request), request.params.merchantId, input)});
  });
  app.get("/workspace/api/wallets/overview", async request => wire({data: runtime.wallets.adminOverview(account(request))}));
  app.get("/workspace/api/finance/summary", async request => {
    const query = z.object({days: z.coerce.number().int().min(1).max(31).default(7)}).parse(request.query);
    return wire({data: runtime.wallets.platformFinanceSummary(account(request), query.days)});
  });
  app.get("/workspace/api/daily-settlements", async request => {
    const actor = account(request);
    const query = z.object({merchantId: z.string().optional(), status: z.enum(["all", "pending_payment", "paid", "reconciled", "no_payable", "disputed", "voided"]).default("all"),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    const {merchantId: requestedMerchantId, ...pageQuery} = query;
    const merchantId = requestedMerchantId && requestedMerchantId !== "all" ? requestedMerchantId : undefined;
    return wire(runtime.dailySettlements.page(actor, {...pageQuery, ...(merchantId ? {merchantId} : {})}));
  });
  app.post<{Params: {id: string}}>("/workspace/api/daily-settlements/:id/pay", async request => {
    const input = z.object({method: z.enum(["alipay", "bank", "other"]), reference: z.string().trim().min(6).max(120),
      evidence: z.string().trim().min(4).max(500), note: z.string().trim().max(500).optional(),
      confirmedActualPayout: z.literal(true)}).strict().parse(request.body);
    return wire({data: runtime.dailySettlements.confirmPaid(account(request), request.params.id, input)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/daily-settlements/:id/cancel", async request => {
    const input = z.object({reason: z.string().trim().min(4).max(500), confirm: z.literal(true)}).strict().parse(request.body);
    return wire({data: runtime.dailySettlements.cancel(account(request), request.params.id, input.reason)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/daily-settlements/:id/reconcile", async request => {
    const input = z.object({note: z.string().trim().min(4).max(500), confirm: z.literal(true)}).strict().parse(request.body);
    return wire({data: runtime.dailySettlements.reconcile(account(request), request.params.id, input.note)});
  });
  app.get("/workspace/api/wallets/entries", async request => {
    const query = z.object({merchantId: z.string().optional(), page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      scope: z.enum(["all", "commission"]).default("all")}).parse(request.query);
    return wire(runtime.wallets.adminEntries(account(request), query));
  });
  app.get<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId", async request => {
    const actor = account(request), merchantId = scope(actor, request.params.merchantId);
    return wire({data: runtime.wallets.summary(actor, merchantId)});
  });
  app.get<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/history", async request => {
    const actor = account(request), merchantId = scope(actor, request.params.merchantId);
    const query = z.object({kind: z.enum(["deposits", "withdrawals", "ledger"]),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20)}).parse(request.query);
    return wire(runtime.wallets.historyPage(actor, merchantId, query.kind, query.page, query.limit));
  });
  app.post<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/deposits", async request => {
    const input = z.object({amount: money, requestKey, payerReference: z.string().trim().min(1).max(120).optional()}).strict().parse(request.body);
    const actor = account(request);
    const merchantId = scope(actor, request.params.merchantId);
    if (runtime.walletAlipay) {
      const value = runtime.walletAlipay.start(actor, merchantId, input.amount, input.requestKey);
      return wire({data: value.deposit, payUrl: value.payUrl});
    }
    if (!input.payerReference) throw new AppError(503, "online_wallet_payment_unavailable", "支付宝余额充值暂不可用");
    return wire({data: runtime.wallets.requestDeposit(actor, merchantId, input.amount, input.requestKey, input.payerReference)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/deposits/:id/review", async request => {
    const input = z.object({approve: z.boolean(), verifiedReference: receipt.optional(), confirmedActualReceipt: z.literal(true)}).strict().parse(request.body);
    return wire({data: runtime.wallets.reviewDeposit(account(request), request.params.id, input.approve, input.verifiedReference ?? "")});
  });
  app.post<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/transfer", async request => {
    const input = z.object({amount: money, requestKey}).strict().parse(request.body), actor = account(request);
    runtime.wallets.transfer(actor, scope(actor, request.params.merchantId), input.amount, input.requestKey); return {ok: true};
  });
  app.post<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/withdrawals", async request => {
    const input = z.object({amount: money, requestKey, payoutMethod: z.enum(["alipay", "bank"]), payoutAccount: z.string().trim().min(4).max(120), payoutName: z.string().trim().min(2).max(80)}).strict().parse(request.body), actor = account(request);
    const withdrawal = runtime.wallets.requestWithdrawal(actor, scope(actor, request.params.merchantId), input.amount, input.requestKey,
      {method: input.payoutMethod, account: input.payoutAccount, name: input.payoutName});
    const ticket = runtime.support.createWithdrawalTicket(actor, withdrawal);
    return wire({data: withdrawal, ticketId: ticket.id});
  });
  app.post<{Params: {id: string}}>("/workspace/api/withdrawals/:id/review", async request => {
    const input = z.object({action: z.enum(["approve", "reject", "paid"]), reference: z.string().trim().max(120).default(""), confirmedActualPayout: z.boolean().optional()}).strict().parse(request.body);
    if (input.action === "paid" && input.confirmedActualPayout !== true) throw new AppError(422, "payout_confirmation_required", "必须核实已实际打款");
    const withdrawal = runtime.wallets.reviewWithdrawal(account(request), request.params.id, input.action, input.reference);
    runtime.support.syncWithdrawalTicket(withdrawal, input.action === "reject" ? input.reference : null);
    return wire({data: withdrawal});
  });
  app.get<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/pending-earnings", async request => {
    const actor = account(request);
    const merchantId = scope(actor, request.params.merchantId);
    return wire({data: runtime.wallets.listPendingEarnings(actor, merchantId)});
  });
  app.post<{Params: {merchantId: string}}>("/workspace/api/wallets/:merchantId/release-earnings", async request => {
    const actor = account(request);
    const merchantId = scope(actor, request.params.merchantId);
    const input = z.object({
      orderIds: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
      confirmReconciled: z.literal(true),
    }).strict().parse(request.body);
    // Ensure all ids belong to this merchant before batch release.
    for (const orderId of input.orderIds) {
      const order = runtime.repository.findOrder(merchantId, orderId);
      if (!order) throw new AppError(404, "order_not_found", "订单不存在或不属于该代理商: " + orderId);
    }
    return wire({data: runtime.wallets.releaseEarningsBatch(actor, input.orderIds)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/release-earning", async request => {
    z.object({confirmReconciled: z.literal(true)}).strict().parse(request.body);
    runtime.wallets.releaseEarning(account(request), request.params.id); return {ok: true};
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/refund-procurement", async request => {
    z.object({confirmRefund: z.literal(true)}).strict().parse(request.body);
    const order = runtime.wallets.refundPurchase(account(request), request.params.id);
    return {data: {order_id: order.id, payment_status: order.paymentStatus, collection_mode: order.collectionMode}};
  });
  app.get("/workspace/api/refunds/price-adjustments/pending", async request => {
    const actor = account(request);
    const refunds = runtime.refunds.listPendingPriceAdjustments(actor);
    return wire({data: workspaceRefunds(runtime, refunds)});
  });
  app.get("/workspace/api/refunds/customer/pending", async request => {
    const actor = account(request);
    const refunds = runtime.refunds.listPendingCustomerRefunds(actor);
    return wire({data: workspaceRefunds(runtime, refunds)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/orders/:id/price-adjustment-refunds", async request => {
    const actor = account(request);
    const input = z.object({amount: money, reason: text, requestKey}).strict().parse(request.body);
    const refund = runtime.refunds.requestPriceAdjustment(actor, request.params.id, input);
    runtime.wallets.reconcileMerchantEarnings(refund.merchantId);
    return wire({data: workspaceRefund(runtime, refund)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/refunds/:id/approve", async request => {
    const actor = account(request);
    z.object({confirmRefund: z.literal(true)}).strict().parse(request.body);
    const refund = await runtime.refunds.approve(actor, request.params.id);
    runtime.wallets.reconcileMerchantEarnings(refund.merchantId);
    return wire({data: workspaceRefund(runtime, refund)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/refunds/:id/complete", async request => {
    const actor = account(request);
    const input = z.object({payoutReference: receipt, confirmedActualPayout: z.literal(true)}).strict().parse(request.body);
    const refund = runtime.refunds.completeReviewed(actor, request.params.id, input.payoutReference);
    runtime.wallets.reconcileMerchantEarnings(refund.merchantId);
    return wire({data: workspaceRefund(runtime, refund)});
  });
  app.post<{Params: {id: string}}>("/workspace/api/refunds/:id/reject", async request => {
    const actor = account(request);
    const input = z.object({reason: text}).strict().parse(request.body);
    return wire({data: workspaceRefund(runtime, runtime.refunds.reject(actor, request.params.id, input.reason))});
  });

  // Existing HMAC identity is reused. Partner API cannot approve funds, publish, assign roles or withdraw.
  registerPaymentSettingsRoutes(app, runtime, account);
  registerSupplierWorkspaceRoutes(app, runtime, account);
  const partner = (request: FastifyRequest): Actor => {
    const tenant = request.tenant; if (!tenant) throw new AppError(401, "auth_required", "签名认证失败");
    return {id: "api:" + tenant.keyId, merchantId: tenant.merchantId, role: "agent_api"};
  };
  const once = (request: FastifyRequest, action: () => unknown): unknown => runtime.repository.transaction(() => {
    const tenant = request.tenant!, key = String(request.headers["idempotency-key"] ?? "");
    if (key.length < 8 || key.length > 128) throw new AppError(400, "idempotency_key_required", "幂等键须为 8–128 位");
    const routeKey = request.method + " " + request.url.split("?")[0];
    const requestHash = createHash("sha256").update(request.rawBody ?? Buffer.alloc(0)).digest("hex");
    const previous = runtime.repository.getIdempotency(tenant.merchantId, tenant.appId, routeKey, key);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new AppError(409, "idempotency_conflict", "同一幂等键对应不同内容");
      return previous.responseBody;
    }
    const body = wire(action());
    runtime.repository.saveIdempotency({merchantId: tenant.merchantId, appId: tenant.appId, routeKey, key, requestHash, responseStatus: 200, responseBody: body});
    return body;
  });
  app.get<{Querystring:{status?:string;page?:string;limit?:string}}>("/v1/tickets", async request => {
    const input=z.object({status:z.enum(["all","open","in_progress","waiting_agent","resolved","closed"]).default("all"),
      page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);
    return wire(runtime.support.page(partner(request),input));
  });
  app.post("/v1/tier-applications", async request => {
    return once(request, () => {
    const actor = partner(request), input = z.object({targetTier: identifier, reason: text, requestKey}).strict().parse(request.body);
    const ticket = runtime.agents.applyTier(actor, actor.merchantId!, input.targetTier, input.reason, input.requestKey);
    return {data: runtime.support.get(actor, ticket.id)};
    });
  });
  app.post("/v1/tickets", async request => {
    return once(request, () => {
    const actor = partner(request), input = ticketInput.omit({merchantId: true}).parse(request.body);
    const item = runtime.support.create(actor, actor.merchantId!, input); return {data: runtime.support.get(actor, item.id)};
    });
  });
  app.get<{Params: {id: string}}>("/v1/tickets/:id", async request => ({data: runtime.support.get(partner(request), request.params.id)}));
  app.post<{Params: {id: string}}>("/v1/tickets/:id/messages", async request => {
    return once(request, () => {
    const input = z.object({body: text, version: z.number().int().positive()}).strict().parse(request.body), actor = partner(request);
    runtime.support.reply(actor, request.params.id, input.body, false, input.version); return {data: runtime.support.get(actor, request.params.id)};
    });
  });
  app.get("/v1/announcements", async request => ({data: runtime.announcements.list(partner(request))}));
  app.post<{Params: {id: string}}>("/v1/announcements/:id/read", async request => {runtime.announcements.read(partner(request), request.params.id); return {ok: true};});
  app.get<{Querystring:{page?:string;limit?:string}}>("/v1/wallet", async request => {
    const actor=partner(request),input=z.object({page:z.coerce.number().int().min(1).default(1),
      limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query);
    const entries=runtime.wallets.historyPage(actor,actor.merchantId!,"ledger",input.page,input.limit);
    return {data:runtime.wallets.summary(actor,actor.merchantId!),entries:wire(entries.data),entries_meta:entries.meta};
  });
  app.get("/v1/agent-profile", async request => {const actor = partner(request); return wire({data: runtime.agents.summary(actor, actor.merchantId!), rules: runtime.agents.rules()});});
}
