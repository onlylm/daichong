import crypto from "node:crypto";
import http from "node:http";

const config = {
  port: Number(process.env.PARTNER_DEMO_PORT ?? 3300),
  quefaBaseUrl: process.env.QUEFA_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3200",
  partnerId: process.env.QUEFA_PARTNER_ID ?? process.env.DEMO_PARTNER_ID ?? "pt_demo_a",
  keyId: process.env.QUEFA_KEY_ID ?? process.env.DEMO_KEY_ID ?? "key_demo_a_01",
  clientSecret: process.env.QUEFA_CLIENT_SECRET ?? process.env.DEMO_CLIENT_SECRET ?? "replace-with-demo-secret-at-least-32-chars",
  webhookSecret: process.env.QUEFA_WEBHOOK_SECRET ?? process.env.DEMO_WEBHOOK_SECRET ?? "replace-demo-webhook-secret",
  registeredWebhookUrl: process.env.QUEFA_REGISTERED_WEBHOOK_URL ?? process.env.DEMO_WEBHOOK_URL ?? "http://host.docker.internal:3300/webhooks/quefa",
};

const recentEvents = [];

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/") return html(response, storefrontHtml());
    if (request.method === "GET" && url.pathname === "/api/events") return json(response, 200, {data: recentEvents});
    if (request.method === "POST" && url.pathname === "/webhooks/quefa") return receiveWebhook(request, response);
    if (url.pathname === "/api/products" && request.method === "GET") return proxyQuefa(response, "GET", "/v1/products");
    if (url.pathname === "/api/orders" && request.method === "GET") return proxyQuefa(response, "GET", `/v1/orders${url.search}`);
    if (url.pathname === "/api/orders" && request.method === "POST") {
      const input = JSON.parse((await readBody(request)).toString("utf8"));
      input.notify_url = config.registeredWebhookUrl;
      return proxyQuefa(response, "POST", "/v1/orders", input, `order:${input.merchant_order_no}`);
    }
    const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (orderMatch && request.method === "GET") return proxyQuefa(response, "GET", `/v1/orders/${encodeURIComponent(orderMatch[1])}`);
    const refundMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/refunds$/);
    if (refundMatch && request.method === "POST") {
      const input = JSON.parse((await readBody(request)).toString("utf8"));
      return proxyQuefa(response, "POST", `/v1/orders/${encodeURIComponent(refundMatch[1])}/refunds`, input, `refund:${input.merchant_refund_no}`);
    }
    json(response, 404, {error: {message: "not found"}});
  } catch (error) {
    json(response, 500, {error: {message: error instanceof Error ? error.message : "internal error"}});
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`代理商联调示例：http://127.0.0.1:${config.port}`);
  console.log(`Quefa API：${config.quefaBaseUrl}`);
});

async function proxyQuefa(response, method, path, payload, idempotencyKey = "") {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const target = new URL(path, config.quefaBaseUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const signature = sign({method, url: target, body, timestamp, nonce, idempotencyKey});
  const headers = {
    "x-partner-id": config.partnerId,
    "x-key-id": config.keyId,
    "x-timestamp": String(timestamp),
    "x-nonce": nonce,
    "x-signature": signature,
  };
  if (body) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = idempotencyKey;
  }
  const upstream = await fetch(target, {method, headers, body: body || undefined});
  const text = await upstream.text();
  response.writeHead(upstream.status, {"content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store"});
  response.end(text);
}

async function receiveWebhook(request, response) {
  const rawBody = await readBody(request);
  const timestamp = Number(request.headers["x-quefa-timestamp"] ?? 0);
  const supplied = String(request.headers["x-quefa-signature"] ?? "");
  if (!verifyWebhook(timestamp, rawBody, supplied)) return json(response, 401, {error: {message: "invalid webhook signature"}});
  const event = JSON.parse(rawBody.toString("utf8"));
  recentEvents.unshift(event);
  recentEvents.splice(20);
  console.log("收到 Quefa Webhook", event.event, event.event_id);
  response.writeHead(204);
  response.end();
}

function sign({method, url, body, timestamp, nonce, idempotencyKey}) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [
    method, url.pathname, canonicalQuery(url.search.slice(1)), String(timestamp), nonce,
    config.keyId, idempotencyKey, bodyHash,
  ].join("\n");
  return crypto.createHmac("sha256", config.clientSecret).update(canonical).digest("hex");
}

function canonicalQuery(rawQuery) {
  const pairs = [...new URLSearchParams(rawQuery).entries()].map(([key, value]) => [rfc3986(key), rfc3986(value)]);
  return pairs.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv)).map(([key, value]) => `${key}=${value}`).join("&");
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function verifyWebhook(timestamp, rawBody, supplied) {
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const digest = crypto.createHmac("sha256", config.webhookSecret).update(String(timestamp)).update(".").update(rawBody).digest("hex");
  const expected = Buffer.from(`t=${timestamp},v1=${digest}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 128 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  response.end(JSON.stringify(value));
}

function html(response, value) {
  response.writeHead(200, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"});
  response.end(value);
}

function storefrontHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>代理商联调商城</title><style>body{font-family:system-ui;margin:0;background:#f6f7fb;color:#172033}.wrap{max-width:880px;margin:40px auto;padding:0 20px}.card{background:#fff;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 8px 28px #17203312}button,input,select{padding:10px 12px;border-radius:8px;border:1px solid #ccd3df}button{background:#1769ff;color:#fff;border:0;cursor:pointer}.row{display:flex;gap:10px;flex-wrap:wrap}.muted{color:#667085}pre{white-space:pre-wrap;word-break:break-all;background:#101828;color:#d0d5dd;padding:16px;border-radius:10px}a{display:inline-block;color:#1769ff;margin-top:8px}</style></head><body><main class="wrap"><h1>代理商联调商城</h1><p class="muted">代理商服务端只负责签名开单；付款后客户进入 Quefa 页面提交充值凭据，代理商不会接触 Session。</p><section class="card"><h2>1. 商品与开单</h2><div class="row"><select id="product" aria-label="商品"></select><input id="price" value="135.00" aria-label="售价"><button id="create">创建订单</button><button id="list">刷新订单列表</button></div></section><section class="card"><h2>2. 支付与充值</h2><div id="order">尚未开单</div><div class="row"><button id="query" disabled>查询订单</button><button id="refund" disabled>申请补差 10 元</button></div></section><section class="card"><h2>3. Webhook</h2><button id="events">刷新事件</button><pre id="output">等待操作</pre></section></main><script>let current=null;const out=v=>document.getElementById('output').textContent=JSON.stringify(v,null,2);async function call(url,opt){const r=await fetch(url,opt);const j=await r.json();out(j);if(!r.ok)throw new Error(j.error?.message||'请求失败');return j}async function products(){const j=await call('/api/products'),select=document.getElementById('product');select.replaceChildren(...j.data.map(x=>{const option=document.createElement('option');option.value=x.product_code;option.textContent=x.name+'（'+x.fulfillment_mode+'）供货价 ¥'+x.supply_price;return option}))}document.getElementById('create').onclick=async()=>{const no='DEMO-'+Date.now();const j=await call('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchant_order_no:no,product_code:document.getElementById('product').value,quantity:1,sale_amount:document.getElementById('price').value})});current=j.data;render()};document.getElementById('query').onclick=async()=>{current=(await call('/api/orders/'+current.order_id)).data;render()};document.getElementById('list').onclick=()=>call('/api/orders');document.getElementById('refund').onclick=()=>call('/api/orders/'+current.order_id+'/refunds',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({merchant_refund_no:'RF-'+Date.now(),type:'price_adjustment',amount:'10.00',reason:'沙箱补差测试'})});document.getElementById('events').onclick=()=>call('/api/events');function link(text,href){const a=document.createElement('a');a.textContent=text;a.href=href;a.target='_blank';a.rel='noopener';return a}function render(){const box=document.getElementById('order');box.replaceChildren();const summary=document.createElement('div');summary.textContent='订单 '+current.order_id+'，模式：'+current.fulfillment_mode+'，状态：'+current.payment_status+(current.voucher_code?'，兑换码：'+current.voucher_code:'');box.append(summary,link('打开 Quefa 付款页',current.qr_payload));if(current.payment_status==='paid'||current.payment_status==='partially_refunded')box.append(document.createElement('br'),link('进入 Quefa 充值/兑换',current.fulfillment_url));document.getElementById('query').disabled=false;document.getElementById('refund').disabled=current.payment_status!=='paid'}products().catch(e=>out({error:e.message}));</script></body></html>`;
}
