import crypto from "node:crypto";
import http from "node:http";
import {pathToFileURL} from "node:url";

const config = {
  port: Number(process.env.PARTNER_DEMO_PORT ?? 3300),
  bind: process.env.PARTNER_DEMO_BIND ?? "127.0.0.1",
  allowMockPay: process.env.PARTNER_DEMO_ALLOW_MOCK_PAY === "true",
  quefaBaseUrl: process.env.QUEFA_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3200",
  partnerId: process.env.QUEFA_PARTNER_ID ?? process.env.DEMO_PARTNER_ID ?? "pt_demo_a",
  keyId: process.env.QUEFA_KEY_ID ?? process.env.DEMO_KEY_ID ?? "key_demo_a_01",
  clientSecret: process.env.QUEFA_CLIENT_SECRET ?? process.env.DEMO_CLIENT_SECRET ?? "replace-with-demo-secret-at-least-32-chars",
  webhookSecret: process.env.QUEFA_WEBHOOK_SECRET ?? process.env.DEMO_WEBHOOK_SECRET ?? "replace-demo-webhook-secret",
  registeredWebhookUrl: process.env.QUEFA_REGISTERED_WEBHOOK_URL ?? process.env.DEMO_WEBHOOK_URL ?? "http://host.docker.internal:3300/webhooks/quefa",
};

const recentEvents = [], redemptionCapabilities = new Map(), redemptionIds = new Map();

export const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/") return html(response, storefrontHtml());
    if (request.method === "GET" && url.pathname === "/api/events") return json(response, 200, {data: recentEvents});
    if (request.method === "POST" && url.pathname === "/webhooks/quefa") return receiveWebhook(request, response);
    if (url.pathname === "/api/products" && request.method === "GET") {
      return proxyQuefa(response, "GET", "/v1/products", undefined, "", body => ({
        data: (body.data ?? []).filter(item => item.available).map(publicProduct),
      }));
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      return proxyQuefa(response, "GET", `/v1/orders${url.search}`, undefined, "", body => ({
        data: (body.data ?? []).map(publicOrder), next_cursor: body.next_cursor ?? null,
      }));
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      const input = await jsonBody(request);
      const payload = {merchant_order_no: input.merchant_order_no, product_code: input.product_code, quantity: 1,
        sale_amount: input.sale_amount, collection_mode: "platform_collect", delivery_mode: "auto_recharge",
        notify_url: config.registeredWebhookUrl};
      return proxyQuefa(response, "POST", "/v1/orders", payload, `order:${input.merchant_order_no}`,
        body => ({data: publicOrder(body.data)}));
    }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && request.method === "GET") {
      return proxyQuefa(response, "GET", `/v1/orders/${encodeURIComponent(orderMatch[1])}`, undefined, "",
        body => ({data: publicOrder(body.data)}));
    }
    const paymentCodeMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/payment-code$/);
    if (paymentCodeMatch && request.method === "POST") {
      const orderId = decodeURIComponent(paymentCodeMatch[1]);
      return proxyQuefa(response, "POST", `/v1/orders/${encodeURIComponent(orderId)}/payment-code`, {},
        `payment-code:${orderId}`, body => ({data: publicPaymentCode(body.data)}));
    }
    const mockPayMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/mock-pay$/);
    if (mockPayMatch && request.method === "POST") {
      if (!mockPaymentAllowed()) return json(response, 404, {error: {code: "not_found", message: "not found"}});
      const orderId = decodeURIComponent(mockPayMatch[1]);
      return proxySandboxPayment(response, orderId);
    }
    const redeemMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/redeem$/);
    if (redeemMatch && request.method === "POST") {
      const input = await jsonBody(request);
      if (!/^[A-Za-z0-9:_.-]{8,120}$/.test(input.request_key ?? "") || input.customer_confirmed_email !== true) {
        return json(response, 400, {error: {code: "invalid_input", message: "请核对充值资料与授权确认"}});
      }
      const payload = {mode: "auto_recharge", order_id: decodeURIComponent(redeemMatch[1]), credential: input.credential,
        customer_confirmed_email: true};
      return proxyQuefa(response, "POST", "/v1/redemptions", payload, input.request_key, body => {
        const redemptionId = body.data.redemption_id, capability = capabilityFor(redemptionId);
        return {data: publicRedemption(body.data), status_path: `/api/redemptions/${capability}`};
      });
    }
    const statusMatch = url.pathname.match(/^\/api\/redemptions\/([A-Za-z0-9_-]{32})$/);
    if (statusMatch && request.method === "GET") {
      const redemptionId = redemptionCapabilities.get(statusMatch[1]);
      if (!redemptionId) return json(response, 404, {error: {code: "status_not_found", message: "查询凭证不存在或已过期"}});
      return proxyQuefa(response, "GET", `/v1/redemptions/${encodeURIComponent(redemptionId)}`, undefined, "",
        body => ({data: publicRedemption(body.data)}));
    }
    json(response, 404, {error: {code: "not_found", message: "not found"}});
  } catch {
    json(response, 503, {error: {code: "request_unconfirmed", message: "请求结果暂未确认，请核对原订单"}});
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(config.port, config.bind, () => {
    console.log(`代理商联调示例：http://127.0.0.1:${config.port}`);
    console.log(`上游开放平台 API：${config.quefaBaseUrl}`);
  });
}

async function proxyQuefa(response, method, path, payload, idempotencyKey = "", project = value => value) {
  const body = payload === undefined ? "" : JSON.stringify(payload), target = new URL(path, config.quefaBaseUrl);
  const timestamp = Math.floor(Date.now() / 1000), nonce = crypto.randomUUID();
  const signature = sign({method, url: target, body, timestamp, nonce, idempotencyKey});
  const headers = {"x-partner-id": config.partnerId, "x-key-id": config.keyId, "x-timestamp": String(timestamp),
    "x-nonce": nonce, "x-signature": signature};
  if (payload !== undefined) { headers["content-type"] = "application/json"; headers["idempotency-key"] = idempotencyKey; }
  const upstream = await fetch(target, {method, headers, body: payload === undefined ? undefined : body, redirect: "error",
    signal: AbortSignal.timeout(15_000)});
  const text = await upstream.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { return json(response, 502, {error: {code: "invalid_upstream_response", message: "平台响应无法解析"}}); }
  if (!upstream.ok) return json(response, upstream.status, publicError(parsed));
  return json(response, upstream.status, project(parsed));
}

async function proxySandboxPayment(response, orderId) {
  const target = new URL(`/sandbox/pay/${encodeURIComponent(orderId)}/confirm`, config.quefaBaseUrl);
  const upstream = await fetch(target, {method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000)});
  const parsed = await upstream.json();
  if (!upstream.ok) return json(response, upstream.status, publicError(parsed));
  return proxyQuefa(response, "GET", `/v1/orders/${encodeURIComponent(orderId)}`, undefined, "",
    body => ({data: publicOrder(body.data)}));
}

function mockPaymentAllowed() {
  if (!config.allowMockPay) return false;
  const base = new URL(config.quefaBaseUrl);
  return base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
}

async function receiveWebhook(request, response) {
  const rawBody = await readBody(request);
  const timestamp = Number(request.headers["x-quefa-timestamp"] ?? 0), supplied = String(request.headers["x-quefa-signature"] ?? "");
  if (!verifyWebhook(timestamp, rawBody, supplied)) return json(response, 401, {error: {message: "invalid webhook signature"}});
  const event = JSON.parse(rawBody.toString("utf8"));
  recentEvents.unshift(publicEvent(event));
  recentEvents.splice(20);
  console.log("收到已验签 Webhook", event.event, event.event_id);
  response.writeHead(204);
  response.end();
}

function publicProduct(value) {
  return {product_code: value.product_code, name: value.name, currency: value.currency, max_quantity: value.max_quantity,
    delivery_modes: value.delivery_modes};
}

function publicOrder(value) {
  return {order_id: value.order_id, merchant_order_no: value.merchant_order_no, product_code: value.product_code,
    sale_amount: value.sale_amount, currency: value.currency, payment_status: value.payment_status,
    delivery_mode: value.delivery_mode, fulfillment_status: value.fulfillment_status ?? null,
    retry_allowed: value.retry_allowed ?? false, fallback_recharge_available: value.fallback_recharge_available ?? false,
    created_at: value.created_at, expires_at: value.expires_at};
}

function publicPaymentCode(value) {
  return {order_id: value.order_id, amount: value.amount, currency: value.currency, payment_status: value.payment_status,
    qr_image_data_url: value.qr_image_data_url, expires_at: value.expires_at};
}

function publicRedemption(value) {
  return {status: value.status, progress_stage: value.progress_stage ?? null, progress_version: value.progress_version ?? 0,
    progress_updated_at: value.progress_updated_at ?? null, failure_code: value.failure_code ?? null, message: value.message ?? null,
    retry_allowed: value.retry_allowed ?? false, next_action: value.next_action ?? "wait", finished_at: value.finished_at ?? null};
}

function publicEvent(value) {
  const data = value?.data ?? {};
  return {event_id: value?.event_id, event: value?.event, occurred_at: value?.occurred_at,
    data: {order_id: data.order_id, status: data.status, progress_stage: data.progress_stage,
      progress_version: data.progress_version, message: data.message, retry_allowed: data.retry_allowed, next_action: data.next_action}};
}

function publicError(value) {
  const code = value?.error?.code ?? "request_failed";
  const messages = {
    direct_payment_code_disabled: "当前付款方式暂不可用",
    order_not_paid: "订单尚未确认付款",
    order_expired: "订单已过期",
    order_closed: "订单已关闭",
    voucher_unavailable: "充值资源尚未就绪或已使用",
    idempotency_conflict: "同一申请编号对应的内容发生变化",
    rate_limited: "请求过于频繁，请稍后重试",
  };
  return {error: {code, message: messages[code] ?? "请求未完成，请根据错误码核对原订单"}};
}

function capabilityFor(redemptionId) {
  let capability = redemptionIds.get(redemptionId);
  if (capability) return capability;
  if (redemptionCapabilities.size >= 500) {
    const first = redemptionCapabilities.keys().next().value;
    redemptionIds.delete(redemptionCapabilities.get(first));
    redemptionCapabilities.delete(first);
  }
  capability = crypto.randomBytes(24).toString("base64url");
  redemptionCapabilities.set(capability, redemptionId);
  redemptionIds.set(redemptionId, capability);
  return capability;
}

function sign({method, url, body, timestamp, nonce, idempotencyKey}) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, url.pathname, canonicalQuery(url.search.slice(1)), String(timestamp), nonce,
    config.keyId, idempotencyKey, bodyHash].join("\n");
  return crypto.createHmac("sha256", config.clientSecret).update(canonical).digest("hex");
}

function canonicalQuery(rawQuery) {
  const pairs = [...new URLSearchParams(rawQuery).entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)]);
  return pairs.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => `${key}=${value}`).join("&");
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function verifyWebhook(timestamp, rawBody, supplied) {
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const digest = crypto.createHmac("sha256", config.webhookSecret).update(String(timestamp)).update(".").update(rawBody).digest("hex");
  const expected = Buffer.from(`t=${timestamp},v1=${digest}`), actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function jsonBody(request) {
  if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) throw new Error("需要 JSON 请求体");
  return JSON.parse((await readBody(request)).toString("utf8"));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", chunk => {
      length += chunk.length;
      if (length > 128 * 1024) { reject(new Error("request body too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff"});
  response.end(JSON.stringify(value));
}

function html(response, value) {
  response.writeHead(200, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
  response.end(value);
}

export function storefrontHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>示例商城</title><style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f4f6fa;color:#172033}.wrap{max-width:880px;margin:40px auto;padding:0 20px}.card{background:#fff;border:1px solid #e1e6ef;border-radius:14px;padding:24px;margin:16px 0}button,input,select,textarea{font:inherit;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #bcc6d6}button{background:#1769ff;color:#fff;border:0;cursor:pointer}button:disabled{opacity:.5}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.muted{color:#667085}img{display:block;width:min(280px,100%);aspect-ratio:1;margin:18px auto;border:1px solid #e1e6ef}textarea{width:100%;min-height:110px}pre{white-space:pre-wrap;word-break:break-word;background:#101828;color:#d0d5dd;padding:16px;border-radius:10px}label{display:block;margin:12px 0}input[type=checkbox]{width:auto}*:focus-visible{outline:3px solid #82aaff;outline-offset:3px}</style></head><body><main class="wrap"><h1>示例商城</h1><p class="muted">付款和充值始终留在代理商自己的页面；浏览器不接触平台密钥、供货价或供应关系。</p><section class="card"><h2>1. 创建订单</h2><div class="row"><select id="product" aria-label="商品"></select><input id="price" value="135.00" aria-label="客户售价"><button id="create">创建订单</button></div></section><section class="card"><h2>2. 扫码付款</h2><p id="order">尚未开单</p><img id="qr" alt="付款二维码" hidden><div class="row"><button id="paycode" disabled>获取付款码</button><button id="mockpay" disabled hidden>沙箱模拟付款</button><button id="query" disabled>刷新支付状态</button></div></section><section class="card" id="recharge" hidden><h2>3. 提交自动直充</h2><form id="form"><label>凭据类型<select name="mode"><option value="session">Session</option><option value="access_token">Access Token</option></select></label><label>充值凭据<textarea name="credential" required autocomplete="off"></textarea></label><label><input type="checkbox" name="confirmed" required> 我已核对充值账号并授权本次充值</label><button>开始充值</button></form><button id="progress" hidden>查询充值进度</button></section><section class="card"><h2>4. 已验签通知</h2><button id="events">刷新通知</button><pre id="output">等待操作</pre></section></main><script>const allowMock=${mockPaymentAllowed()};let current=null,statusPath=null;const $=id=>document.getElementById(id),out=v=>$('output').textContent=JSON.stringify(v,null,2);$('paycode').hidden=allowMock;$('mockpay').hidden=!allowMock;async function call(url,opt){const r=await fetch(url,opt),j=await r.json();out(j);if(!r.ok)throw Error(j.error?.message||'请求失败');return j}async function products(){const j=await call('/api/products');$('product').replaceChildren(...j.data.filter(x=>x.delivery_modes?.includes('auto_recharge')).map(x=>{const o=document.createElement('option');o.value=x.product_code;o.textContent=x.name;return o}))}function render(){if(!current)return;$('order').textContent='订单 '+current.merchant_order_no+' · ¥'+current.sale_amount+' · '+current.payment_status;$('paycode').disabled=current.payment_status!=='pending';$('mockpay').disabled=current.payment_status!=='pending';$('query').disabled=false;$('recharge').hidden=!['paid','partially_refunded'].includes(current.payment_status)}$('create').onclick=async()=>{const no='DEMO-'+Date.now();current=(await call('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchant_order_no:no,product_code:$('product').value,sale_amount:$('price').value})})).data;render();if(!allowMock)$('paycode').click()};$('paycode').onclick=async()=>{const d=(await call('/api/orders/'+encodeURIComponent(current.order_id)+'/payment-code',{method:'POST'})).data;if(!d.qr_image_data_url.startsWith('data:image/png;base64,'))throw Error('付款码格式错误');$('qr').src=d.qr_image_data_url;$('qr').hidden=false};$('mockpay').onclick=async()=>{current=(await call('/api/orders/'+encodeURIComponent(current.order_id)+'/mock-pay',{method:'POST'})).data;render()};$('query').onclick=async()=>{current=(await call('/api/orders/'+encodeURIComponent(current.order_id))).data;render()};$('form').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.currentTarget)),credential=d.mode==='session'?{mode:'session',session:d.credential}:{mode:'access_token',access_token:d.credential},request_key='recharge:'+current.order_id+':'+crypto.randomUUID();const j=await call('/api/orders/'+encodeURIComponent(current.order_id)+'/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_key,credential,customer_confirmed_email:d.confirmed==='on'})});statusPath=j.status_path;e.currentTarget.reset();$('progress').hidden=false};$('progress').onclick=()=>statusPath&&call(statusPath);$('events').onclick=()=>call('/api/events');products().catch(e=>out({error:e.message}));</script></body></html>`;
}
