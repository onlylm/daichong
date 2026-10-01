import {randomBytes} from "node:crypto";
import type {FastifyInstance} from "fastify";
import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";
import type {Order} from "../domain/model.js";
import {minorToMoney} from "../domain/money.js";
import {postPaymentRechargeUrl} from "../operations/workspace-recharge.js";
import {alipayCheckoutPage} from "./alipay-page.js";

function isAlipayPrecreateQr(value: string): boolean {
  try { return new URL(value).hostname === "qr.alipay.com"; } catch { return false; }
}

function orderDeliveryMode(order: Order): "auto_recharge" | "cdk" {
  return order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
}

export function registerAlipayRoutes(app: FastifyInstance, runtime: Runtime, workspaceBaseUrl: string): void {
  const alipay = runtime.alipay;
  const walletAlipay = runtime.walletAlipay;
  const invoiceAlipay = runtime.invoiceAlipay;
  if (!alipay && !walletAlipay && !invoiceAlipay) return;
  // Both Alipay notifications and legacy browser payment forms use this media
  // type. Register it on the parent instance so every Alipay route inherits it.
  app.addContentTypeParser("application/x-www-form-urlencoded", {parseAs: "string"}, (_request, body, done) => {
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of new URLSearchParams(String(body))) {
      if (Object.hasOwn(fields, key)) return done(new AppError(400, "duplicate_payment_field", "重复支付通知字段"));
      fields[key] = value;
    }
    done(null, fields);
  });
  app.register(async scoped => {
    scoped.post("/internal/webhooks/alipay", async (request, reply) => {
      if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return reply.code(400).type("text/plain").send("failure");
      try {
        const fields = request.body as Record<string, string>;
        if (fields.out_trade_no?.startsWith("invpay_")) {
          if (!invoiceAlipay) throw new Error("invoice_alipay_disabled");
          invoiceAlipay.handleNotification(fields);
        } else if (fields.out_trade_no?.startsWith("wdep_")) {
          if (!walletAlipay) throw new Error("wallet_alipay_disabled");
          walletAlipay.handleNotification(fields);
        } else {
          if (!alipay) throw new Error("order_alipay_disabled");
          alipay.handleNotification(fields);
        }
        return reply.type("text/plain").send("success");
      } catch {
        return reply.code(400).type("text/plain").send("failure");
      }
    });
  });

  type Params = {Params: {orderId: string}; Querystring: {token?: string}};
  const orderFor = (id: string, token?: string) => {
    if (!runtime.portalTokens.verifyPayment(id, token ?? "")) throw new AppError(404, "payment_not_found", "支付入口不存在");
    const order = runtime.repository.findOrderInternal(id);
    if (!order || runtime.repository.findPaymentAttemptByOrder(order.merchantId, id)?.provider !== "alipay_page") throw new AppError(404, "payment_not_found", "支付入口不存在");
    return order;
  };
  const checkoutHeaders = (reply: import("fastify").FastifyReply, nonce: string) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src https://api.qrserver.com; frame-ancestors 'none'; base-uri 'none'")
      .header("x-content-type-options", "nosniff");
  };
  const orderCheckoutStatus = (order: Order) => {
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id);
    const qr = attempt?.qrPayload && isAlipayPrecreateQr(attempt.qrPayload) ? attempt.qrPayload : null;
    return {status: order.paymentStatus, expired: order.expiresAt <= new Date(), amount: minorToMoney(order.saleAmountMinor),
      expires_at: order.expiresAt.toISOString(), can_start: order.paymentStatus === "pending" && order.expiresAt > new Date()
        && runtime.paymentSettings.available().includes("alipay_page"), qr_code: qr,
      channel_enabled: runtime.paymentSettings.available().includes("alipay_page"),
      delivery_mode: orderDeliveryMode(order),
      recharge_url: ["paid", "partially_refunded"].includes(order.paymentStatus) ? postPaymentRechargeUrl(runtime.repository, order, workspaceBaseUrl) : null};
  };
  if (alipay) app.get<Params>("/payments/:orderId", async (request, reply) => {
    orderFor(request.params.orderId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    checkoutHeaders(reply, nonce);
    return reply.type("text/html; charset=utf-8").send(alipayCheckoutPage(nonce));
  });
  if (alipay) app.get<Params>("/payments/:orderId/result", async (request, reply) => {
    const order = orderFor(request.params.orderId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
      .header("x-content-type-options", "nosniff");
    const path = "/payments/" + encodeURIComponent(order.id);
    const token = encodeURIComponent(request.query.token!);
    return reply.type("text/html; charset=utf-8").send(resultPage({
      amount: minorToMoney(order.saleAmountMinor), id: order.id, nonce,
      status: path + "/status?token=" + token, refresh: path + "/refresh?token=" + token,
    }));
  });
  if (alipay) app.post<Params>("/payments/:orderId/start", async (request, reply) => {
    const order = orderFor(request.params.orderId, request.query.token);
    reply.header("cache-control", "no-store");
    await alipay.precreate(order.id);
    return orderCheckoutStatus(runtime.repository.findOrderInternal(order.id)!);
  });
  if (alipay) app.get<Params>("/payments/:orderId/status", async (request, reply) => {
    const order = orderFor(request.params.orderId, request.query.token);
    reply.header("cache-control", "no-store");
    return orderCheckoutStatus(order);
  });
  if (alipay) app.post<Params>("/payments/:orderId/refresh", async (request, reply) => {
    orderFor(request.params.orderId, request.query.token);
    await alipay.reconcile(request.params.orderId);
    return reply.code(204).send();
  });

  type WalletParams = {Params: {depositId: string}; Querystring: {token?: string}};
  const depositFor = (id: string, token?: string) => {
    if (!runtime.portalTokens.verifyPayment(id, token ?? "")) throw new AppError(404, "payment_not_found", "支付入口不存在");
    const deposit = runtime.repository.getOperations("wallet_deposit", id);
    if (!deposit || deposit.paymentProvider !== "alipay_page") throw new AppError(404, "payment_not_found", "支付入口不存在");
    return deposit;
  };
  const walletCheckoutStatus = (deposit: import("../operations/model.js").WalletDeposit) => ({
    status: deposit.status, expired: Boolean(deposit.expiresAt && deposit.expiresAt <= new Date()),
    amount: minorToMoney(deposit.amountMinor), expires_at: deposit.expiresAt?.toISOString() ?? null,
    can_start: deposit.status === "requested" && Boolean(deposit.expiresAt && deposit.expiresAt > new Date()),
    qr_code: deposit.providerRef && isAlipayPrecreateQr(deposit.providerRef) ? deposit.providerRef : null,
    wallet_home: "/workspace/app?view=wallet",
  });
  if (walletAlipay) app.get<WalletParams>("/wallet-payments/:depositId", async (request, reply) => {
    depositFor(request.params.depositId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    checkoutHeaders(reply, nonce);
    return reply.type("text/html; charset=utf-8").send(alipayCheckoutPage(nonce, "采购余额充值 · 支付宝"));
  });
  if (walletAlipay) app.post<WalletParams>("/wallet-payments/:depositId/start", async (request, reply) => {
    const deposit = depositFor(request.params.depositId, request.query.token);
    reply.header("cache-control", "no-store");
    await walletAlipay.precreate(deposit.id);
    const current = runtime.repository.getOperations("wallet_deposit", deposit.id)!;
    return walletCheckoutStatus(current);
  });
  if (walletAlipay) app.get<WalletParams>("/wallet-payments/:depositId/result", async (request, reply) => {
    const deposit = depositFor(request.params.depositId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
      .header("x-content-type-options", "nosniff");
    const path = "/wallet-payments/" + encodeURIComponent(deposit.id), token = encodeURIComponent(request.query.token!);
    // Partner agents log in on PUBLIC_BASE_URL; never send them to the admin host after payment.
    const walletHome = "/workspace/app?view=wallet";
    return reply.type("text/html; charset=utf-8").send(walletResultPage({amount: minorToMoney(deposit.amountMinor), id: deposit.id, nonce,
      status: path + "/status?token=" + token, refresh: path + "/refresh?token=" + token, walletHome}));
  });
  if (walletAlipay) app.get<WalletParams>("/wallet-payments/:depositId/status", async (request, reply) => {
    const deposit = depositFor(request.params.depositId, request.query.token);
    reply.header("cache-control", "no-store");
    return walletCheckoutStatus(deposit);
  });
  if (walletAlipay) app.post<WalletParams>("/wallet-payments/:depositId/refresh", async (request, reply) => {
    depositFor(request.params.depositId, request.query.token);
    await walletAlipay.reconcile(request.params.depositId);
    return reply.code(204).send();
  });

  type InvoiceParams = {Params: {paymentId: string}; Querystring: {token?: string}};
  const invoicePaymentFor = (id: string, token?: string) => {
    if (!invoiceAlipay || !runtime.portalTokens.verifyPayment(id, token ?? "")) throw new AppError(404, "payment_not_found", "支付入口不存在");
    return invoiceAlipay.payment(id);
  };
  const invoiceCheckoutStatus = (payment: import("../operations/model.js").InvoiceFeePayment) => ({
    status: payment.status, expired: payment.status === "expired" || payment.expiresAt <= new Date(),
    amount: minorToMoney(payment.amountMinor), expires_at: payment.expiresAt.toISOString(),
    can_start: payment.status === "pending" && payment.expiresAt > new Date()
      && (!payment.paymentConfigId || runtime.paymentSettings.available().includes("alipay_page")),
    qr_code: payment.qrPayload && isAlipayPrecreateQr(payment.qrPayload) ? payment.qrPayload : null,
    invoice_home: "/workspace/app?view=invoices",
    channel_enabled: !payment.paymentConfigId || runtime.paymentSettings.available().includes("alipay_page"),
  });
  if (invoiceAlipay) app.get<InvoiceParams>("/invoice-payments/:paymentId", async (request, reply) => {
    invoicePaymentFor(request.params.paymentId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    checkoutHeaders(reply, nonce);
    return reply.type("text/html; charset=utf-8").send(alipayCheckoutPage(nonce, "订单补差价 · 支付宝"));
  });
  if (invoiceAlipay) app.post<InvoiceParams>("/invoice-payments/:paymentId/start", async (request, reply) => {
    const payment = invoicePaymentFor(request.params.paymentId, request.query.token);
    reply.header("cache-control", "no-store");
    await invoiceAlipay.precreate(payment.id);
    return invoiceCheckoutStatus(invoiceAlipay.payment(payment.id));
  });
  if (invoiceAlipay) app.get<InvoiceParams>("/invoice-payments/:paymentId/status", async (request, reply) => {
    const payment = invoicePaymentFor(request.params.paymentId, request.query.token);
    reply.header("cache-control", "no-store");
    return invoiceCheckoutStatus(payment);
  });
  if (invoiceAlipay) app.post<InvoiceParams>("/invoice-payments/:paymentId/refresh", async (request, reply) => {
    invoicePaymentFor(request.params.paymentId, request.query.token);
    await invoiceAlipay.reconcile(request.params.paymentId);
    return reply.code(204).send();
  });
}

// Alipay owns the payment UI. This page only reports the verified order result
// after Alipay returns the browser to the merchant site.
function resultPage(x: {amount: string; id: string; nonce: string; status: string; refresh: string}): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>支付结果 · Quefa</title>
<style nonce="${x.nonce}">:root{color-scheme:light;font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#182e49;background:#f2f6fb}*{box-sizing:border-box}body{margin:0;padding:48px 20px}main{max-width:540px;margin:auto;background:#fff;padding:36px;border-top:4px solid #1764c0}h1{font-size:24px;margin:0 0 32px}p{line-height:1.8}small,.muted{color:#52677d}strong{display:block;font-size:38px;margin:8px 0 24px;font-variant-numeric:tabular-nums}dl{border-block:1px solid #d8e3ef;padding:20px 0;font-size:14px}dt{color:#52677d}dd{margin:8px 0 0;overflow-wrap:anywhere}button,a{font:inherit}button,.next{display:block;width:100%;border:0;border-radius:5px;background:#1764c0;color:#fff;padding:14px;text-align:center;text-decoration:none;cursor:pointer}.secondary{background:#fff;color:#1764c0;border:1px solid #1764c0;margin:12px 0}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:3px solid #182e49;outline-offset:4px}[hidden]{display:none!important}#status{min-height:26px}@media(max-width:480px){body{padding:20px 12px}main{padding:24px}}</style>
<main><h1>支付结果</h1><small>订单金额</small><strong>¥ ${x.amount}</strong><dl><dt>平台订单号</dt><dd>${x.id}</dd></dl>
<p id="status" role="status" aria-live="polite">正在向服务端核对支付宝订单…</p>
<button class="secondary" id="refresh">重新核对</button><a id="next" class="next" hidden>进入充值 / 查看兑换码</a>
<p class="muted" id="manual" hidden>若支付宝页面未自动跳转，请<a id="manual-link" href="#">点此进入结果页</a>。</p>
<p class="muted">本站不会根据浏览器跳转直接判定到账。最终结果以支付宝异步通知验签或官方订单查询为准；尚未确认时请勿重复付款。</p></main>
<script nonce="${x.nonce}">const statusUrl=${JSON.stringify(x.status)},refreshUrl=${JSON.stringify(x.refresh)},resultHref=location.href;const statusEl=document.getElementById('status'),next=document.getElementById('next'),refresh=document.getElementById('refresh'),manual=document.getElementById('manual'),manualLink=document.getElementById('manual-link');manualLink.href=resultHref;let timer;function goNext(d){if(!d.recharge_url)return false;if(d.delivery_mode==='auto_recharge'){statusEl.textContent='支付宝付款已确认，正在进入提交页面…';clearInterval(timer);location.replace(d.recharge_url);return true}next.href=d.recharge_url;next.textContent=d.delivery_mode==='cdk'?'查看兑换码':'进入充值';next.hidden=false;clearInterval(timer);setTimeout(()=>location.replace(d.recharge_url),1200);return true}async function check(){try{const r=await fetch(statusUrl);if(!r.ok)throw Error();const d=await r.json(),paid=['paid','partially_refunded'].includes(d.status);if(paid){if(!goNext(d))statusEl.textContent='支付宝付款已确认。';return}statusEl.textContent=d.status==='refunded'?'订单已退款。':d.expired?'订单已过期；如已经付款，请重新核对结果。':d.channel_enabled===false?'支付通道已关闭，正在核对已有订单。':'支付宝正在处理或付款尚未完成。'}catch{statusEl.textContent='暂时无法获取结果，请稍后重试。'}}refresh.onclick=async()=>{refresh.disabled=true;try{const r=await fetch(refreshUrl,{method:'POST'});if(!r.ok)throw Error();await check()}catch{statusEl.textContent='支付结果尚未确认，请稍后核对，不要重复付款。'}finally{refresh.disabled=false}};timer=setInterval(check,3000);check();if(document.referrer&&/alipay\\.com/i.test(document.referrer))manual.hidden=false;</script></html>`;
}

function walletResultPage(x: {amount: string; id: string; nonce: string; status: string; refresh: string; walletHome: string}): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>余额充值结果</title>
<style nonce="${x.nonce}">:root{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#2d261a;background:#f5f0e4}*{box-sizing:border-box}body{margin:0;padding:48px 20px}main{max-width:540px;margin:auto;background:#fffdf8;padding:36px;border:1px solid #dfd5c2;border-radius:16px}h1{font-size:24px;margin:0 0 32px}p{line-height:1.8}small,.muted{color:#706754}strong{display:block;font-size:38px;margin:8px 0 24px}dl{border-block:1px solid #e4dccd;padding:20px 0;font-size:14px}dt{color:#706754}dd{margin:8px 0 0;overflow-wrap:anywhere}button,a{font:inherit}button,.next{display:block;width:100%;border:0;border-radius:8px;background:#aa7d2a;color:#fff;padding:14px;text-align:center;text-decoration:none;cursor:pointer}.secondary{background:#fff;color:#795617;border:1px solid #c9ad76;margin:12px 0}button:disabled{opacity:.5}:focus-visible{outline:3px solid #2d261a;outline-offset:4px}[hidden]{display:none!important}</style>
<main><h1>采购余额充值</h1><small>充值金额</small><strong>¥ ${x.amount}</strong><dl><dt>充值单号</dt><dd>${x.id}</dd></dl><p id="status" role="status" aria-live="polite">正在核对支付宝结果…</p><button class="secondary" id="refresh">重新核对</button><a id="next" class="next" href="${x.walletHome}" hidden>返回资金钱包</a><p class="muted">只有支付宝验签通知或官方订单查询确认成功后，采购余额才会自动入账；未确认时请勿重复付款。</p></main>
<script nonce="${x.nonce}">const statusUrl=${JSON.stringify(x.status)},refreshUrl=${JSON.stringify(x.refresh)},walletHome=${JSON.stringify(x.walletHome)},statusEl=document.getElementById('status'),next=document.getElementById('next'),refresh=document.getElementById('refresh');let timer;async function check(){try{const r=await fetch(statusUrl);if(!r.ok)throw Error();const d=await r.json();statusEl.textContent=d.status==='credited'?'支付宝付款已确认，采购余额已入账。':d.status==='rejected'?'该充值单未入账。':d.expired?'充值单已过期；如已付款，请重新核对。':'支付宝正在处理或尚未完成付款。';if(d.status==='credited'){next.hidden=false;clearInterval(timer);setTimeout(()=>location.replace(walletHome),1200)}}catch{statusEl.textContent='暂时无法获取结果，请稍后重试。'}}refresh.onclick=async()=>{refresh.disabled=true;try{const r=await fetch(refreshUrl,{method:'POST'});if(!r.ok)throw Error();await check()}catch{statusEl.textContent='支付结果尚未确认，请稍后核对，不要重复付款。'}finally{refresh.disabled=false}};timer=setInterval(check,5000);check();</script></html>`;
}
