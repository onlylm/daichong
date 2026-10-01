import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {historicalDirectOrder, publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("public recharge link lifecycle", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tenant: TenantContext;

  beforeEach(async () => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    await app.close();
    runtime.close();
  });

  async function paidDirectOrder(): Promise<Order> {
    const created = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {providerRef: `test:${created.id}`, receivedMinor: created.saleAmountMinor});
    return historicalDirectOrder(runtime, paid);
  }

  function token(order: Order): string {
    return new URL(order.fulfillmentUrl).searchParams.get("token")!;
  }

  function portal(order: Order): string {
    return `/recharge/${order.id}?token=${encodeURIComponent(token(order))}`;
  }

  function preflight(order: Order) {
    return app.inject({method: "POST", url: `/public/orders/${order.id}/preflight`, payload: {
      token: token(order), credential: {mode: "session", session: "test-session-for-portal-lifecycle"},
    }});
  }

  it("closes the public page and every credential endpoint after a customer refund", async () => {
    const order = await paidDirectOrder();
    runtime.repository.updateOrder({...order, paymentStatus: "refunded", ordinaryRefundedMinor: order.saleAmountMinor, updatedAt: new Date()});

    const page = await app.inject({method: "GET", url: portal(order)});
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain("充值入口已关闭");
    expect(page.body).not.toContain('<form id="form">');

    const check = await preflight(order);
    expect(check.statusCode).toBe(410);
    expect(check.json().error.code).toBe("recharge_portal_closed");

    const status = await app.inject({method: "GET", url: `/public/orders/${order.id}/status?token=${encodeURIComponent(token(order))}`});
    expect(status.statusCode).toBe(410);
    expect(status.json().error.code).toBe("recharge_portal_closed");
  });

  it("treats an ordinary partial refund as closed but keeps a pure price-adjustment order usable", async () => {
    const ordinary = await paidDirectOrder();
    runtime.repository.updateOrder({...ordinary, paymentStatus: "partially_refunded", ordinaryRefundedMinor: 100n, updatedAt: new Date()});
    expect((await app.inject({method: "GET", url: portal(ordinary)})).statusCode).toBe(410);

    const adjustment = await paidDirectOrder();
    runtime.repository.updateOrder({...adjustment, paymentStatus: "partially_refunded", priceAdjustmentRefundedMinor: 100n, updatedAt: new Date()});
    const page = await app.inject({method: "GET", url: portal(adjustment)});
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form id="form">');
  });

  it("never reopens the credential form while a task is active or after it succeeds", async () => {
    const order = await paidDirectOrder();
    const task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "test-active-task"});

    const active = await app.inject({method: "GET", url: portal(order)});
    expect(active.statusCode).toBe(200);
    expect(active.body).toContain("充值任务已进入队列");
    expect(active.body).not.toContain('<form id="form">');
    expect((await preflight(order)).json().error.code).toBe("fulfillment_already_exists");

    runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "supplier-completed", lookupToken: null, status: "completed",
      stage: "completed", accountEmail: null, quotedAmountMinor: null, currency: "USD", message: "completed"});
    const completed = await app.inject({method: "GET", url: portal(order)});
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toContain("充值已经完成");
    expect(completed.body).not.toContain('<form id="form">');
    const blocked = await preflight(order);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("recharge_already_completed");
  });

  it("reopens the original link only after an upstream-confirmed retryable failure", async () => {
    const order = await paidDirectOrder();
    const task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "test-failed-task"});
    runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "supplier-failed", lookupToken: null, status: "failed_precharge",
      stage: "failed", accountEmail: null, quotedAmountMinor: null, currency: "USD", message: "precharge failed"});

    const page = await app.inject({method: "GET", url: portal(order)});
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form id="form">');
    expect((await preflight(order)).statusCode).toBe(200);
  });

  it("applies the same refund lock before a public CDK preflight", async () => {
    const created = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "cdk"});
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {providerRef: `test:${created.id}`, receivedMinor: created.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    runtime.repository.updateOrder({...paid, paymentStatus: "refunded", ordinaryRefundedMinor: paid.saleAmountMinor, updatedAt: new Date()});

    const response = await app.inject({method: "POST", url: "/public/cdk/preflight", payload: {
      code: voucher.publicCode, credential: {mode: "session", session: "must-not-reach-upstream"},
    }});
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("recharge_portal_closed");
  });

  it("previews the local CDK package before credentials and returns the current and target plans after preflight", async () => {
    const created = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "cdk"});
    runtime.payment.markPaid(created.merchantId, created.id,
      {providerRef: `test:${created.id}`, receivedMinor: created.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const upstreamPreflight = vi.spyOn(runtime.upstream, "preflightCdk");

    const redeemPage = await app.inject({method: "GET", url: "/redeem"});
    expect(redeemPage.body).toContain("兑换码对应套餐");
    expect(redeemPage.body).toContain("当前套餐");
    expect(redeemPage.body).toContain("本次兑换");
    expect(redeemPage.body).toContain("addEventListener('paste'");

    const preview = await app.inject({method: "POST", url: "/public/cdk/preview", payload: {code: voucher.publicCode}});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({product_code: "chatgpt_plus_cdk_1m", product_name: "ChatGPT Plus", target_plan: "plus"});
    expect(upstreamPreflight).not.toHaveBeenCalled();

    const preflight = await app.inject({method: "POST", url: "/public/cdk/preflight", payload: {
      code: voucher.publicCode, credential: {mode: "session", session: "valid-session-for-plan-preview"},
    }});
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json().data).toMatchObject({account_email: "preview@example.com", current_plan: "free",
      target_plan: "plus", product_name: "ChatGPT Plus"});
    expect(upstreamPreflight).toHaveBeenCalledTimes(1);
  });
});
