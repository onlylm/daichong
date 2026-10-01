import {createHash, createHmac, timingSafeEqual} from "node:crypto";
import type {FastifyInstance, FastifyReply} from "fastify";
import {z} from "zod";
import type {Runtime} from "../bootstrap.js";
import type {Fulfillment, Order} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import type {RechargeCredential, UpstreamOrderState} from "../upstream/recharge-provider.js";
import {partnerFulfillmentMessage, publicFulfillmentResult, rechargeProgressView} from "./fulfillment-public.js";
import {resolveAutoRechargeUpstreamCode} from "../operations/workspace-recharge.js";
import {CDK_PUBLIC_CODE_PATTERN} from "./cdk-code.js";
import {minorToMoney} from "../domain/money.js";

const credentialSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("session"), session: z.string().min(1).max(32_000)}).strict(),
  z.object({mode: z.literal("access_token"), access_token: z.string().min(1).max(32_000)}).strict(),
  z.object({mode: z.literal("mailbox"), email: z.string().email().max(320), password: z.string().min(1).max(1_000)}).strict(),
]);

const directSchema = z.object({
  token: z.string().min(20),
  credential: credentialSchema,
  customer_confirmed_email: z.literal(true),
}).strict();

const preflightSchema = z.object({
  token: z.string().min(20),
  credential: credentialSchema,
}).strict();

const cdkSchema = z.object({
  code: z.string().regex(CDK_PUBLIC_CODE_PATTERN),
  credential: credentialSchema,
  customer_confirmed_email: z.literal(true),
}).strict();

const cdkPreflightSchema = z.object({
  code: z.string().regex(CDK_PUBLIC_CODE_PATTERN),
  credential: credentialSchema,
}).strict();

export function registerPublicRechargeRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get<{Params: {orderId: string}; Querystring: {token?: string}}>("/recharge/:orderId", async (request, reply) => {
    const order = requirePortalOrder(runtime, request.params.orderId, request.query.token ?? "");
    return html(reply, orderPage(order));
  });

  app.get("/redeem", async (_request, reply) => html(reply, genericCdkPage()));

  app.post<{Params: {orderId: string}}>("/public/orders/:orderId/preflight", async (request) => {
    const input = preflightSchema.parse(request.body);
    const order = requirePortalOrder(runtime, request.params.orderId, input.token);
    const upstreamCode = resolveAutoRechargeUpstreamCode(runtime, order);
    const result = await runtime.fulfillments.preflightPublic(order, normalizeCredential(input.credential), upstreamCode);
    return {data: {account_email: result.accountEmail}};
  });

  app.post<{Params: {orderId: string}}>("/public/orders/:orderId/direct", async (request, reply) => {
    const input = directSchema.parse(request.body);
    const order = requirePortalOrder(runtime, request.params.orderId, input.token);
    const fulfillment = runtime.fulfillments.createDirectPublic(order, normalizeCredential(input.credential));
    reply.code(202);
    return {data: publicStatus(order, fulfillment)};
  });

  app.post<{Params: {orderId: string}}>("/public/orders/:orderId/auto-recharge", async (request, reply) => {
    const input = directSchema.parse(request.body);
    const order = requirePortalOrder(runtime, request.params.orderId, input.token);
    if ((order.deliveryMode ?? "cdk") !== "auto_recharge" || order.fulfillmentMode !== "cdk") {
      throw new AppError(409, "auto_recharge_unavailable", "该订单未选择自动充值");
    }
    const voucher = runtime.repository.findCdkVoucherByOrder(order.id);
    if (!voucher || voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "充值资源尚未就绪或已使用");
    const fulfillment = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), normalizeCredential(input.credential));
    reply.code(202);
    return {data: publicStatus(order, fulfillment)};
  });

  app.post("/public/cdk/preflight", async (request) => {
    const input = cdkPreflightSchema.parse(request.body);
    const voucher = runtime.cdk.findPublic(input.code);
    if (!voucher) throw new AppError(404, "voucher_not_found", "兑换码无效或不可用");
    const order = runtime.repository.findOrderInternal(voucher.orderId);
    if (!order) throw new AppError(404, "order_not_found", "兑换订单不存在");
    const result = await runtime.fulfillments.preflightPublic(order, normalizeCredential(input.credential), runtime.cdk.readUpstreamCode(voucher));
    return {data: {account_email: result.accountEmail}};
  });

  app.post("/public/cdk/redeem", async (request, reply) => {
    const input = cdkSchema.parse(request.body);
    const voucher = runtime.cdk.findPublic(input.code);
    if (!voucher) throw new AppError(404, "voucher_not_found", "兑换码无效或不可用");
    if (voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "兑换码已使用或正在兑换");
    const order = runtime.repository.findOrderInternal(voucher.orderId);
    if (!order) throw new AppError(404, "order_not_found", "兑换订单不存在");
    const upstreamCode = runtime.cdk.readUpstreamCode(voucher);
    const fulfillment = runtime.fulfillments.createCdkPublic(order, voucher, upstreamCode, normalizeCredential(input.credential));
    reply.code(202);
    return {data: publicStatus(order, fulfillment)};
  });

  app.get<{Params: {orderId: string}; Querystring: {token?: string}}>("/public/orders/:orderId/status", async (request) => {
    const order = requirePortalOrder(runtime, request.params.orderId, request.query.token ?? "");
    const latest = runtime.repository.listFulfillments(order.merchantId, order.id).at(-1) ?? null;
    return {data: publicStatus(order, latest)};
  });

  app.post("/internal/webhooks/recharge", async (request, reply) => {
    const webhookSecret = runtime.supplierManagement.getWebhookSecret();
    if (!webhookSecret) throw new AppError(503, "recharge_webhook_not_configured", "充值回调尚未配置", true);
    const signature = header(request.headers["x-signature"]);
    const expected = createHmac("sha256", webhookSecret).update(request.rawBody ?? Buffer.alloc(0)).digest("hex");
    if (!secureEqual(expected, signature)) throw new AppError(401, "invalid_recharge_signature", "回调签名无效");
    const event = z.record(z.string(), z.unknown()).parse(request.body);
    const type = typeof event.type === "string" ? event.type : "";
    const eventId = typeof event.event_id === "string" ? event.event_id : "";
    const clientRequestId = typeof event.client_request_id === "string" ? event.client_request_id : "";
    if (!eventId || !type) throw new AppError(400, "invalid_recharge_event", "回调事件缺少必要字段");
    const payloadHash = createHash("sha256").update(request.rawBody ?? Buffer.alloc(0)).digest("hex");
    return runtime.repository.transaction(() => {
    const existing = runtime.repository.findSupplierWebhookEvent(eventId);
    if (existing && existing.payloadHash !== payloadHash) throw new AppError(409, "recharge_event_conflict", "回调事件内容冲突");
    if (existing?.status === "processed") {
      reply.code(204);
      return null;
    }
    const record = existing ?? {
      eventId, eventType: type, clientRequestId: clientRequestId || null, payloadHash,
      status: "received" as const, receivedAt: new Date(), processedAt: null,
    };
    if (!existing) runtime.repository.insertSupplierWebhookEvent(record);
    try {
      if (["gpt_direct.completed", "gpt_direct.failed", "gpt_direct.cancelled", "gpt_direct.progress"].includes(type) && clientRequestId) {
        if (typeof event.status !== "string") throw new AppError(400, "invalid_recharge_event", "充值状态事件缺少状态");
        runtime.fulfillments.applyUpstreamEvent(clientRequestId, webhookState(event));
      }
      runtime.repository.updateSupplierWebhookEvent({...record, status: "processed", processedAt: new Date()});
    } catch (error) {
      runtime.repository.updateSupplierWebhookEvent({...record, status: "failed", processedAt: null});
      throw error;
    }
    reply.code(204);
    return null;
    });
  });
}

function requirePortalOrder(runtime: Runtime, orderId: string, token: string): Order {
  if (!runtime.portalTokens.verify(orderId, token)) throw new AppError(404, "portal_not_found", "充值入口不存在");
  const order = runtime.repository.findOrderInternal(orderId);
  if (!order) throw new AppError(404, "order_not_found", "订单不存在");
  return order;
}

function normalizeCredential(value: z.infer<typeof credentialSchema>): RechargeCredential {
  if (value.mode === "access_token") return {mode: value.mode, accessToken: value.access_token};
  return value;
}

function publicStatus(order: Order, fulfillment: Fulfillment | null) {
  const token = portalTokenFromOrder(order);
  return {
    order_id: order.id,
    payment_status: order.paymentStatus,
    fulfillment_mode: order.fulfillmentMode ?? "direct",
    delivery_mode: order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge"),
    voucher_ready: order.fulfillmentMode === "cdk" ? Boolean(order.voucherCode) : null,
    fallback_recharge_available: Boolean(order.fallbackRechargeAvailable),
    status_url: token ? `/public/orders/${encodeURIComponent(order.id)}/status?token=${encodeURIComponent(token)}` : null,
    fulfillment: fulfillment ? {
      fulfillment_id: fulfillment.id,
      status: fulfillment.status,
      failure_code: fulfillment.failureCode,
      message: partnerFulfillmentMessage(fulfillment),
      ...publicFulfillmentResult(fulfillment),
      account_email_masked: fulfillment.accountEmailMasked,
      finished_at: fulfillment.finishedAt?.toISOString() ?? null,
      progress: rechargeProgressView({
        status: fulfillment.status,
        failure_code: fulfillment.failureCode,
        message: partnerFulfillmentMessage(fulfillment),
        ...publicFulfillmentResult(fulfillment),
      }),
    } : null,
  };
}

function webhookState(value: Record<string, unknown>): UpstreamOrderState {
  return {
    orderId: String(value.order_id ?? ""),
    lookupToken: null,
    status: String(value.status ?? "running"),
    stage: typeof value.stage === "string" ? value.stage : null,
    accountEmail: typeof value.account_email === "string" ? value.account_email : null,
    quotedAmountMinor: typeof value.quoted_amount_minor === "number" ? value.quoted_amount_minor : null,
    chargedAmountMinor: typeof value.final_amount_minor === "number" ? value.final_amount_minor : null,
    cardLastFour: cardLastFour(value.card_last_four ?? value.card_number_masked),
    currency: typeof value.currency === "string" ? value.currency : null,
    message: typeof value.message === "string" ? value.message : null,
  };
}

function cardLastFour(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function orderPage(order: Order): string {
  const paid = ["paid", "partially_refunded"].includes(order.paymentStatus);
  const isCdk = order.fulfillmentMode === "cdk";
  const delivery = order.deliveryMode ?? (isCdk ? "cdk" : "auto_recharge");
  const code = order.voucherCode ?? "";
  const productTag = productBadge(order.productCode);
  const title = delivery === "cdk" ? "兑换码交付" : "自动充值";
  const preparing = paid && isCdk && !code;
  const unavailable = !paid
    ? "订单尚未支付，请完成付款后刷新本页。"
    : preparing
      ? "正在准备充值，请稍后刷新本页。"
      : "";
  const waitScript = preparing ? "<script>setTimeout(()=>location.reload(),3000)</script>" : "";
  if (delivery === "cdk") {
    return pageShell(title, `<header class="page-head"><div class="brand-mark">Q</div><div><p class="eyebrow">Quefa 履约</p><h1>${escapeHtml(title)}</h1></div></header>
      <div class="stepper"><div class="step done"><span>1</span><small>订单确认</small></div><div class="step-line done"></div><div class="step current"><span>2</span><small>兑换码</small></div></div>
      ${orderSummary(order, productTag, paid)}
      ${unavailable ? `<div class="notice">${escapeHtml(unavailable)}</div>` : `<div class="code-box"><small>兑换码</small><code id="delivery-code">${escapeHtml(code)}</code><button id="copy-code" type="button" class="primary">复制兑换码</button></div>`}
      ${unavailable ? waitScript : `<script>document.getElementById('copy-code').onclick=async()=>{const b=document.getElementById('copy-code');try{await navigator.clipboard.writeText(document.getElementById('delivery-code').textContent);b.textContent='已复制'}catch{b.textContent='请长按复制上方兑换码'}}</script>`}`);
  }
  const action = isCdk ? `/public/orders/${encodeURIComponent(order.id)}/auto-recharge` : `/public/orders/${encodeURIComponent(order.id)}/direct`;
  const preflight = `/public/orders/${encodeURIComponent(order.id)}/preflight`;
  const hidden = `<input type="hidden" id="token" value="${escapeHtml(portalTokenFromOrder(order))}">`;
  return pageShell(title, `<header class="page-head"><div class="brand-mark">Q</div><div><p class="eyebrow">Quefa 履约</p><h1>${escapeHtml(title)}</h1></div></header>
    <div class="stepper" id="stepper"><div class="step done" data-step="1"><span>1</span><small>订单确认</small></div><div class="step-line done"></div><div class="step current" data-step="2"><span>2</span><small>账号检测</small></div><div class="step-line"></div><div class="step" data-step="3"><span>3</span><small>充值履约</small></div></div>
    ${orderSummary(order, productTag, paid)}
    ${unavailable ? `<div class="notice">${escapeHtml(unavailable)}</div>${waitScript}` : `<form id="form">${hidden}${rechargeFormFields()}<div id="result" class="notice" hidden></div></form>`}
    ${unavailable ? "" : `<dialog id="help-drawer" class="help-drawer"><div class="help-shell"><header><strong>如何获取 Session Token？</strong><button type="button" id="help-close">关闭</button></header><ol><li>登录 ChatGPT 网页版，打开浏览器开发者工具（F12）。</li><li>进入 Application / 存储 → Cookies → 选择 chatgpt.com。</li><li>找到名为 <code>__Secure-next-auth.session-token</code> 的 Cookie，复制其 Value。</li><li>粘贴到上方输入框，点击「检测账号」核对后再提交充值。</li></ol><p class="muted">请勿将 Session 发送给任何人；本页仅用于本次订单履约。</p></div></dialog><div id="success-panel" class="success-panel" hidden><div class="success-icon" aria-hidden="true">✓</div><strong>充值完成</strong><p class="muted">权益已注入，请返回 ChatGPT 查看订阅状态。</p></div><script>${formScript({action, preflight, isCdk: false})}${helpDrawerScript()}</script>`}`);
}

function productBadge(productCode: string): string {
  const map: Record<string, string> = {
    chatgpt_plus_cdk_1m: "ChatGPT Plus",
    chatgpt_pro_5x_cdk_1m: "ChatGPT Pro 5x",
    chatgpt_pro_20x_cdk_1m: "ChatGPT Pro 20x",
  };
  return map[productCode] ?? productCode;
}

function orderSummary(order: Order, productTag: string, paid: boolean): string {
  return `<section class="order-summary"><div class="summary-row"><span class="product-tag">${escapeHtml(productTag)}</span>${paid ? `<span class="status-badge paid">已付款</span>` : `<span class="status-badge pending">待支付</span>`}</div><p class="meta">订单号 <code>${escapeHtml(order.id)}</code></p><p class="meta">应付 ¥${escapeHtml(minorToMoney(order.saleAmountMinor))} · ${escapeHtml(order.productCode)}</p></section>`;
}

function helpDrawerScript(): string {
  return `const help=document.getElementById('help-drawer'),helpOpen=document.getElementById('help-open'),helpClose=document.getElementById('help-close');helpOpen?.addEventListener('click',()=>help.showModal());helpClose?.addEventListener('click',()=>help.close());help?.addEventListener('click',e=>{if(e.target===help)help.close();});const sessionInput=document.getElementById('credential'),toggleBtn=document.getElementById('toggle-session'),pasteBtn=document.getElementById('paste-session');toggleBtn?.addEventListener('click',()=>{const masked=sessionInput.classList.toggle('masked');toggleBtn.textContent=masked?'显示':'隐藏';});pasteBtn?.addEventListener('click',async()=>{try{sessionInput.value=await navigator.clipboard.readText();sessionInput.dispatchEvent(new Event('input'));}catch{const r=document.getElementById('result');if(r){r.hidden=false;r.textContent='无法读取剪贴板，请手动粘贴'}}});sessionInput?.addEventListener('input',()=>{const ok=sessionInput.value.trim().length>=20;sessionInput.classList.toggle('invalid',!ok&&sessionInput.value.length>0);});const setStep=n=>{document.querySelectorAll('#stepper .step').forEach((node,i)=>{const step=Math.floor(i/2)+1;node.classList.toggle('done',step<n);node.classList.toggle('current',step===n);});document.querySelectorAll('#stepper .step-line').forEach((node,i)=>node.classList.toggle('done',i+1<n));};window.__rechargeSetStep=setStep;`;
}

function genericCdkPage(): string {
  return pageShell("兑换码充值", `<header class="page-head"><div class="brand-mark">Q</div><div><p class="eyebrow">Quefa 履约</p><h1>兑换码充值</h1></div></header>
    <div class="stepper" id="stepper"><div class="step current" data-step="1"><span>1</span><small>输入兑换码</small></div><div class="step-line"></div><div class="step" data-step="2"><span>2</span><small>账号检测</small></div><div class="step-line"></div><div class="step" data-step="3"><span>3</span><small>充值履约</small></div></div>
    <p class="muted">输入兑换码与 Session，先核对账号后再提交充值。</p>
    <form id="form"><label>兑换码</label><input id="code" required autocomplete="off" spellcheck="false" placeholder="例如 QF-ABCDE-FGHIJ-KLMNO-PQRST">${rechargeFormFields()}<div id="result" class="notice" hidden></div></form>
    <dialog id="help-drawer" class="help-drawer"><div class="help-shell"><header><strong>如何获取 Session Token？</strong><button type="button" id="help-close">关闭</button></header><ol><li>登录 ChatGPT 网页版，打开浏览器开发者工具（F12）。</li><li>进入 Application / 存储 → Cookies → 选择 chatgpt.com。</li><li>找到名为 <code>__Secure-next-auth.session-token</code> 的 Cookie，复制其 Value。</li><li>粘贴到上方输入框，点击「检测账号」核对后再提交充值。</li></ol><p class="muted">请勿将 Session 发送给任何人；本页仅用于本次充值履约。</p></div></dialog>
    <div id="success-panel" class="success-panel" hidden><div class="success-icon" aria-hidden="true">✓</div><strong>充值完成</strong><p class="muted">权益已注入，请返回 ChatGPT 查看订阅状态。</p></div>
    <script>${formScript({action: "/public/cdk/redeem", preflight: "/public/cdk/preflight", isCdk: true})}${helpDrawerScript()}</script>`);
}

function pageShell(title: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{--bg:#0f172a;--card:#111827;--line:rgba(255,255,255,.10);--ink:#f8fafc;--muted:#94a3b8;--primary:#6366f1;--primary-deep:#4f46e5;--success:#10b981;--danger:#f87171;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:var(--ink)}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#1e293b 0%,var(--bg) 55%);padding:24px}.card{max-width:560px;margin:4vh auto;padding:28px;border-radius:18px;background:rgba(17,24,39,.82);backdrop-filter:blur(12px);border:1px solid var(--line);box-shadow:0 24px 60px rgba(0,0,0,.35)}.page-head{display:flex;align-items:center;gap:14px;margin-bottom:22px}.brand-mark{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--primary),#818cf8);font-weight:800}.eyebrow{margin:0 0 4px;color:var(--muted);font-size:11px;letter-spacing:.12em;text-transform:uppercase}h1{margin:0;font-size:24px;letter-spacing:-.5px}.stepper{display:flex;align-items:center;gap:0;margin:0 0 22px}.step{display:grid;justify-items:center;gap:6px;min-width:72px;color:var(--muted);font-size:11px}.step span{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);background:rgba(255,255,255,.04);font-weight:700}.step.done span,.step.current span{background:var(--primary);border-color:var(--primary);color:#fff}.step.current{color:var(--ink);font-weight:650}.step-line{flex:1;height:2px;background:var(--line);margin:0 4px 18px}.step-line.done{background:var(--primary)}.order-summary{padding:16px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line);margin-bottom:18px}.summary-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.product-tag{display:inline-flex;padding:5px 10px;border-radius:999px;background:rgba(99,102,241,.18);color:#c7d2fe;font-size:12px;font-weight:700}.status-badge{padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700}.status-badge.paid{background:rgba(16,185,129,.16);color:#6ee7b7}.status-badge.pending{background:rgba(251,191,36,.16);color:#fcd34d}label{display:block;margin:16px 0 8px;font-weight:600;font-size:13px}.session-row{display:flex;gap:8px;align-items:stretch;margin-bottom:8px}.session-row button{flex:none;width:auto;min-width:72px;margin-top:0;padding:0 12px;min-height:42px}textarea,input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:rgba(15,23,42,.65);color:var(--ink)}textarea.masked{-webkit-text-security:disc;text-security:disc}.check{font-weight:400;display:flex;gap:8px;align-items:flex-start}.check input{width:auto;margin-top:4px}button{width:100%;min-height:46px;margin-top:14px;padding:12px;border:0;border-radius:10px;background:var(--primary);color:white;font-size:15px;font-weight:650;cursor:pointer}button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}button.ghost{width:auto;background:transparent;border:1px solid var(--line);color:#c7d2fe;font-size:12px;padding:6px 10px;min-height:34px;margin-top:0}button:disabled{opacity:.55;cursor:wait}.muted,.meta,small{color:var(--muted)}.meta{margin:6px 0 0;font-size:13px;line-height:1.6}.meta code{font:600 12px ui-monospace,Consolas,monospace;color:#e2e8f0}.notice,.fallback{margin:16px 0;padding:14px;border-radius:10px;background:rgba(99,102,241,.12);color:#c7d2fe}.progress{margin:16px 0;padding:16px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line)}.progress-track{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:12px}.progress-step{text-align:center;font-size:10px;color:var(--muted);position:relative;padding-top:18px}.progress-step:before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:10px;height:10px;border-radius:50%;background:var(--line)}.progress-step.done:before,.progress-step.current:before{background:var(--primary)}.progress-step.failed:before{background:var(--danger)}.progress-step.done,.progress-step.current{color:var(--ink);font-weight:600}.progress-step.failed{color:var(--danger);font-weight:600}.progress-message{margin:0;font-size:14px;color:#c7d2fe}.account-box{margin:16px 0;padding:16px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid var(--line)}.account-box strong{display:block;margin-top:8px;font-size:22px;color:var(--ink);overflow-wrap:anywhere}.code-box,.fallback{display:grid;gap:12px}[hidden]{display:none!important}.code-box code,.fallback code{display:block;padding:14px;border-radius:10px;background:rgba(15,23,42,.65);color:#e2e8f0;font-size:15px;overflow-wrap:anywhere;user-select:all}.code-box button,.fallback button{margin-top:0}.help-drawer{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100%;height:100%}.help-drawer::backdrop{background:rgba(2,6,23,.72)}.help-shell{width:min(520px,calc(100vw - 32px));margin:8vh auto;padding:22px;border-radius:14px;background:#111827;border:1px solid var(--line);color:var(--ink)}.help-shell header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.help-shell header button{width:auto;min-height:34px;margin:0;padding:6px 12px}.help-shell ol{padding-left:20px;line-height:1.75;color:#cbd5e1}.help-shell li{margin-bottom:8px}.success-panel{display:grid;justify-items:center;gap:10px;margin-top:18px;padding:28px 20px;border-radius:14px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.28);text-align:center}.success-panel strong{font-size:20px;color:#6ee7b7}.success-icon{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:var(--success);color:#fff;font-size:28px;font-weight:800;animation:success-pop .45s cubic-bezier(.23,1,.32,1)}@keyframes success-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}@media(max-width:560px){body{padding:0}.card{min-height:100vh;margin:0;border-radius:0;padding:22px}.progress-step{font-size:9px}.step{min-width:58px;font-size:10px}}</style></head><body><main class="card">${content}</main></body></html>`;
}

function credentialFields(): string {
  return `<label>凭据类型</label><select id="mode"><option value="session">Session</option><option value="access_token">Access Token</option><option value="mailbox">邮箱账号</option></select><div id="token-fields"><label>Session / Access Token <button type="button" id="help-open" class="ghost">如何获取？</button></label><div class="session-row"><textarea id="credential" class="masked" rows="5" autocomplete="off" spellcheck="false"></textarea><button type="button" id="toggle-session" class="secondary">显示</button><button type="button" id="paste-session" class="secondary">粘贴</button></div></div><div id="mailbox-fields" hidden><label>邮箱</label><input id="email" type="email" autocomplete="off"><label>邮箱密码</label><input id="password" type="password" autocomplete="off"></div>`;
}

function rechargeFormFields(): string {
  return `<div id="step-verify">${credentialFields()}<button type="button" id="verify">检测账号</button></div><div id="step-submit" hidden><div class="account-box"><small>待充值账号</small><strong id="account-email"></strong><p class="muted">请确认上方账号无误后再开始充值。</p></div><label class="check"><input id="confirmed" type="checkbox" required> 我已确认充值账号正确，并授权本次充值</label><button type="submit" id="submit">立即充值</button><button type="button" id="back" class="secondary">更换凭据</button></div><div id="progress" class="progress" hidden><div class="progress-track" id="progress-track"></div><p class="progress-message" id="progress-message"></p></div>`;
}

function formScript(config: {action: string; preflight: string; isCdk: boolean}): string {
  const extraBody = config.isCdk ? "body.code=document.getElementById('code').value.toUpperCase();" : "body.token=document.getElementById('token').value;";
  return `const form=document.getElementById('form'),result=document.getElementById('result'),progress=document.getElementById('progress'),progressTrack=document.getElementById('progress-track'),progressMessage=document.getElementById('progress-message'),successPanel=document.getElementById('success-panel'),mode=document.getElementById('mode'),tokenFields=document.getElementById('token-fields'),mailboxFields=document.getElementById('mailbox-fields'),stepVerify=document.getElementById('step-verify'),stepSubmit=document.getElementById('step-submit'),verifyBtn=document.getElementById('verify'),backBtn=document.getElementById('back'),accountEmail=document.getElementById('account-email'),submitBtn=document.getElementById('submit');let verified=false;const setStep=window.__rechargeSetStep||(n=>{});const showSuccess=()=>{if(successPanel){form.hidden=true;progress.hidden=true;successPanel.hidden=false;setStep(3);}else{result.hidden=false;result.textContent='充值完成，请返回 ChatGPT 查看订阅状态。';}};const renderProgress=view=>{if(!view)return;setStep(3);progress.hidden=false;result.hidden=true;progressTrack.replaceChildren(...view.steps.map(step=>{const node=document.createElement('div');node.className='progress-step '+step.state;node.textContent=step.label;return node}));progressMessage.textContent=view.message};mode.onchange=()=>{verified=false;stepSubmit.hidden=true;stepVerify.hidden=false;progress.hidden=true;if(successPanel)successPanel.hidden=true;form.hidden=false;setStep(2);const mail=mode.value==='mailbox';tokenFields.hidden=mail;mailboxFields.hidden=!mail;};const credential=()=>mode.value==='mailbox'?{mode:'mailbox',email:document.getElementById('email').value.trim(),password:document.getElementById('password').value}:mode.value==='access_token'?{mode:'access_token',access_token:document.getElementById('credential').value.trim()}:{mode:'session',session:document.getElementById('credential').value.trim()};const poll=async url=>{const response=await fetch(url),json=await response.json(),item=json.data?.fulfillment;if(!response.ok){result.hidden=false;progress.hidden=true;result.textContent=json.error?.message||'状态查询失败';return}if(item?.progress)renderProgress(item.progress);if(!item||item.status==='queued'||item.status==='running'){setTimeout(()=>poll(url),3000);return}if(item.status==='succeeded'){if(item.progress)renderProgress(item.progress);showSuccess();return}result.hidden=false;progress.hidden=true;result.textContent=item.message||'自动充值未完成，请返回销售方提供的充值入口重试'};verifyBtn.onclick=async()=>{result.hidden=false;progress.hidden=true;result.textContent='正在检测账号有效性…';verifyBtn.disabled=true;const body={credential:credential()};${extraBody}const response=await fetch('${config.preflight}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const json=await response.json();verifyBtn.disabled=false;if(!response.ok){result.textContent=json.error?.message||'账号检测失败';return}accountEmail.textContent=json.data.account_email;verified=true;stepVerify.hidden=true;stepSubmit.hidden=false;result.hidden=true;document.getElementById('confirmed').checked=false;setStep(2);};backBtn.onclick=()=>{verified=false;stepSubmit.hidden=true;stepVerify.hidden=false;result.hidden=true;progress.hidden=true;setStep(2);};form.onsubmit=async e=>{e.preventDefault();if(!verified){result.hidden=false;result.textContent='请先检测账号';return}if(!document.getElementById('confirmed').checked){result.hidden=false;result.textContent='请勾选确认后再开始充值';return}submitBtn.disabled=true;result.hidden=false;progress.hidden=true;result.textContent='正在提交…';const body={credential:credential(),customer_confirmed_email:true};${extraBody}const response=await fetch('${config.action}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const json=await response.json();if(!response.ok){result.textContent=json.error?.message||'提交失败';submitBtn.disabled=false;return}stepSubmit.hidden=true;result.hidden=true;setStep(3);if(json.data?.status_url)poll(json.data.status_url);};`;
}

function portalTokenFromOrder(order: Order): string {
  try {
    return new URL(order.fulfillmentUrl).searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function html(reply: FastifyReply, body: string): string {
  reply.header("cache-control", "no-store").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'").type("text/html; charset=utf-8");
  return body;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function secureEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
