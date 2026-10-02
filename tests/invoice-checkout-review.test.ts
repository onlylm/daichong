import {runInNewContext} from "node:vm";
import type {FastifyInstance} from "fastify";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {alipayCheckoutScript} from "../src/modules/alipay-page.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";
import * as paymentQr from "../src/modules/payment-qr.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const identity = {appId: "2026000000000000", sellerId: "2088000000000000"};
const imageData = "data:image/png;base64,c3ludGhldGlj";

describe("invoice checkout review safety", () => {
  let runtime: Runtime, app: FastifyInstance, orderId: string, paymentId: string, statusUrl: string;
  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    const owner = {id: "checkout-owner", role: "agent_owner" as const, merchantId: bundle.merchant.id};
    const order = await runtime.orders.create({merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId,
      appId: bundle.app.id, keyId: bundle.key.keyId}, {merchantOrderNo: "invoice-checkout-order",
      productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    orderId = order.id;
    runtime.payment.markPaid(order.merchantId, order.id, {providerRef: "invoice-checkout-paid", receivedMinor: 13_500n});
    const application = runtime.invoices.create(owner, order.id, {invoiceTitle: "测试开票有限公司", taxId: "91310000MA12345678",
      recipientEmail: "finance@example.com", contactName: "财务", requestKey: "invoice-checkout-review"});
    runtime.invoiceAlipay = new InvoiceAlipayService(runtime.repository, runtime.paymentSettings, runtime.invoices,
      config.publicBaseUrl, runtime.portalTokens, {identity, client: {pageExecute: () => "", checkNotifySignV2: () => true,
        exec: vi.fn(async () => ({code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/synthetic-invoice-checkout"}))}});
    const {payment} = runtime.invoiceAlipay.ensurePayment(owner, application.id);
    paymentId = payment.id;
    await runtime.invoiceAlipay.precreate(paymentId);
    statusUrl = `/invoice-payments/${paymentId}/status?token=${runtime.portalTokens.paymentToken(paymentId)}`;
    app = await buildApp(config, runtime);
  });
  afterEach(async () => {vi.restoreAllMocks(); await app.close(); runtime.close();});

  const refundOrder = () => {
    const order = runtime.repository.findOrderInternal(orderId)!;
    runtime.repository.updateOrder({...order, paymentStatus: "partially_refunded", ordinaryRefundedMinor: 1_000n});
  };
  const notify = () => runtime.invoiceAlipay!.handleNotification({out_trade_no: paymentId, total_amount: "6.75",
    trade_no: "2026100200008801", trade_status: "TRADE_SUCCESS", sign_type: "RSA2", sign: "synthetic",
    app_id: identity.appId, seller_id: identity.sellerId});

  it("returns a payable code only while the source order remains eligible", async () => {
    vi.spyOn(paymentQr, "paymentQrDataUrl").mockResolvedValue(imageData);
    const response = await app.inject({method: "GET", url: statusUrl});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({status: "pending", can_start: true, requires_review: false,
      review_reason: null, qr_code: "https://qr.alipay.com/synthetic-invoice-checkout", qr_image_data_url: imageData});
  });

  it("removes an existing code from the status endpoint once the order needs review", async () => {
    const render = vi.spyOn(paymentQr, "paymentQrDataUrl");
    refundOrder();
    const response = await app.inject({method: "GET", url: statusUrl});
    expect(response.json()).toMatchObject({status: "pending", can_start: false, requires_review: true,
      qr_code: null, qr_image_data_url: null, review_reason: expect.stringContaining("退款")});
    expect(render).not.toHaveBeenCalled();
    expect(runtime.invoiceAlipay!.payment(paymentId).qrPayload).toBeTruthy();
  });

  it("preserves late payment evidence but exposes paid plus review instead of unconditional submission", async () => {
    refundOrder();
    notify();
    const response = await app.inject({method: "GET", url: statusUrl});
    expect(response.json()).toMatchObject({status: "paid", can_start: false, requires_review: true,
      qr_code: null, qr_image_data_url: null});
    expect(runtime.invoiceAlipay!.payment(paymentId)).toMatchObject({status: "paid", amountMinor: 675n,
      providerRef: "2026100200008801"});
  });

  it.each(["refund", "paid", "expired"] as const)("rechecks %s arriving while the QR image is being generated", async change => {
    let release!: (value: string) => void, entered!: () => void;
    const reached = new Promise<void>(resolve => {entered = resolve;});
    vi.spyOn(paymentQr, "paymentQrDataUrl").mockImplementation(() => {
      entered();
      return new Promise<string>(resolve => {release = resolve;});
    });
    const responsePromise = app.inject({method: "GET", url: statusUrl}).then(response => response);
    await reached;
    if (change === "refund") refundOrder();
    else if (change === "paid") notify();
    else runtime.repository.saveOperations("invoice_fee_payment", {...runtime.invoiceAlipay!.payment(paymentId),
      expiresAt: new Date(Date.now() - 1_000)});
    release(imageData);
    const response = await responsePromise;
    expect(response.json()).toMatchObject({can_start: false, qr_code: null, qr_image_data_url: null,
      ...(change === "refund" ? {requires_review: true} : change === "paid" ? {status: "paid"} : {expired: true})});
  });
});

function checkoutHarness() {
  const nodes = new Map<string, {hidden: boolean; textContent: string; href?: string; disabled: boolean;
    children: unknown[]; classList: {add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>};
    replaceChildren: (...children: unknown[]) => void; removeAttribute: (key: string) => void}>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {hidden: true, textContent: "", disabled: false, children: [],
      classList: {add: vi.fn(), remove: vi.fn()}, replaceChildren(...children) {this.children = children;},
      removeAttribute(key) {if (key === "href") delete this.href;}});
    return nodes.get(id)!;
  };
  const intervals = new Map<number, () => void>(); let nextId = 0;
  const location = {search: "?token=synthetic", pathname: "/invoice-payments/synthetic", replace: vi.fn()};
  const context = {document: {getElementById: get}, location, navigator: {userAgent: "iPhone"}, URLSearchParams,
    Image: class {}, fetch: () => new Promise(() => {}),
    setInterval: (callback: () => void) => {const id = ++nextId; intervals.set(id, callback); return id;},
    clearInterval: (id: number) => intervals.delete(id)};
  runInNewContext(alipayCheckoutScript, context);
  return {get, location, intervals, draw: (data: unknown) => runInNewContext(`draw(${JSON.stringify(data)})`, context)};
}

describe("invoice checkout actual page state rendering", () => {
  const pending = {status: "pending", amount: "6.75", can_start: true, expired: false,
    expires_at: "2099-01-01T00:00:00Z", invoice_home: "/workspace/app?view=invoices",
    qr_code: "https://qr.alipay.com/synthetic", qr_image_data_url: imageData};

  it("clears the visible old QR and payment actions when review is required", () => {
    const ui = checkoutHarness();
    ui.draw(pending);
    expect(ui.get("qr").hidden).toBe(false);
    ui.draw({...pending, requires_review: true, review_reason: "关联订单已发生退款"});
    expect(ui.get("qr").hidden).toBe(true);
    expect(ui.get("qr").children).toHaveLength(0);
    expect(ui.get("open").href).toBeUndefined();
    for (const id of ["start", "open", "mobile-pay", "qr-skeleton"]) expect(ui.get(id).hidden).toBe(true);
    expect(ui.get("poll-text").textContent).toContain("已暂停收款");
    expect(ui.get("next").textContent).toBe("查看开票申请");
  });

  it("shows the paid fact with pending review and does not claim submitted or redirect", () => {
    const ui = checkoutHarness();
    ui.draw({...pending, status: "paid", requires_review: true, can_start: false});
    expect(ui.get("poll-text").textContent).toContain("补差价已支付，开票申请待核对");
    expect(ui.get("poll-text").textContent).not.toContain("已提交");
    expect(ui.get("success-overlay").hidden).toBe(true);
    for (const callback of ui.intervals.values()) callback();
    expect(ui.location.replace).not.toHaveBeenCalled();
  });

  it("cancels an existing success redirect when a later review result arrives", () => {
    const ui = checkoutHarness();
    ui.draw({...pending, status: "paid", can_start: false});
    expect(ui.get("poll-text").textContent).toContain("开票申请已提交");
    expect(ui.get("success-overlay").hidden).toBe(false);
    ui.draw({...pending, status: "paid", requires_review: true, can_start: false});
    for (let count = 0; count < 4; count++) for (const callback of ui.intervals.values()) callback();
    expect(ui.location.replace).not.toHaveBeenCalled();
    expect(ui.get("success-overlay").hidden).toBe(true);
  });
});
