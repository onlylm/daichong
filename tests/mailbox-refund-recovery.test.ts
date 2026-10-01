import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {partnerFulfillmentSnapshot} from "../src/modules/fulfillment-public.js";
import {UpstreamRequestError} from "../src/upstream/recharge-provider.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("backend mailbox validation and refunded queue recovery", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PUBLIC_BASE_URL: "https://tibo.ink"});
  let runtime: Runtime, tenant: TenantContext;
  beforeEach(() => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });
  afterEach(() => {vi.restoreAllMocks(); runtime.close();});
  async function paidOrder(): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    return runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "test:" + order.id, receivedMinor: order.saleAmountMinor});
  }
  async function queuedOrder() {
    const order = await paidOrder(), voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher),
      {mode: "mailbox", email: "buyer@example.com", password: "private-password"});
    return {order, voucher, task};
  }
  function markFullyRefunded(order: Order) {
    runtime.repository.updateOrder({...order, paymentStatus: "refunded", priceAdjustmentRefundedMinor: order.saleAmountMinor, fallbackRechargeAvailable: true});
  }

  it("runs real mailbox preflight from the agent backend and returns an actionable 422", async () => {
    const order = await paidOrder();
    await runtime.cdk.issueOne();
    const owner = await runtime.accounts.registerOwner({username: "mailbox-agent", displayName: "test agent", merchantId: tenant.merchantId,
      password: "test-only-agent-password"});
    runtime.repository.saveOperations("account", {...owner, mustChangePassword: false});
    const preflight = vi.spyOn(runtime.upstream, "preflightCdk").mockRejectedValue(new UpstreamRequestError("mailbox_login_failed", false));
    const submit = vi.spyOn(runtime.upstream, "submitCdk");
    const app = await buildApp(config, runtime);
    try {
      const logged = await app.inject({method: "POST", url: "/workspace/api/auth/login", headers: {origin: "https://tibo.ink"},
        payload: {username: "mailbox-agent", password: "test-only-agent-password"}});
      const response = await app.inject({method: "POST", url: `/workspace/api/orders/${order.id}/preflight`,
        headers: {origin: "https://tibo.ink", cookie: String(logged.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": logged.json().csrf},
        payload: {mode: "mailbox", email: "buyer@example.com", password: "private-password"}});
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatchObject({code: "mailbox_login_failed"});
      expect(response.body).toContain("邮箱登录失败");
      expect(response.body).not.toContain("private-password");
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(runtime.repository.listFulfillments(tenant.merchantId, order.id)).toHaveLength(0);
    } finally {await app.close();}
  });

  it("ends a legacy queued mailbox failure, clears its credentials and reopens the original order", async () => {
    const {order, task} = await queuedOrder();
    const submit = vi.spyOn(runtime.upstream, "submitCdk").mockRejectedValue(new UpstreamRequestError("mailbox_login_failed", false));
    const failed = (await runtime.fulfillments.processOne())!;
    expect(failed).toMatchObject({id: task.id, status: "failed", failureCode: "mailbox_login_failed", retryAllowed: true});
    expect(failed.sessionPayload.ciphertext).toBeNull();
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("unused");
    expect(runtime.fulfillments.canResubmit(failed)).toBe(true);
    expect(runtime.repository.findOrderInternal(order.id)?.fallbackRechargeAvailable).toBe(true);
    expect(await runtime.fulfillments.processOne()).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(runtime.repository.listOutbox(tenant.merchantId).find(event => event.eventType === "fulfillment.failed")?.payload)
      .toMatchObject({failure_code: "mailbox_login_failed", retry_allowed: true, next_action: "resubmit"});
  });

  it("closes an already-refunded undispatched queue and confirms upstream disable exactly once without another charge or refund", async () => {
    const {order, task} = await queuedOrder();
    markFullyRefunded(order);
    const submit = vi.spyOn(runtime.upstream, "submitCdk"), issue = vi.spyOn(runtime.upstream, "issueCdk"), disable = vi.spyOn(runtime.upstream, "disableCdk");
    const closed = (await runtime.fulfillments.processOne())!;
    expect(closed).toMatchObject({id: task.id, status: "cancelled", recoveryAction: "refund"});
    expect(closed.sessionPayload.ciphertext).toBeNull();
    expect(partnerFulfillmentSnapshot(closed, undefined, runtime.fulfillments.canResubmit(closed))).toMatchObject({retry_allowed: false, next_action: "none"});
    expect(runtime.repository.findOrderInternal(order.id)?.fallbackRechargeAvailable).toBe(false);
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("disabling");
    expect((await runtime.cdk.reconcileRefundedOne())?.status).toBe("disabled");
    expect(await runtime.cdk.reconcileRefundedOne()).toBeNull();
    expect(await runtime.fulfillments.processOne()).toBeNull();
    expect(disable).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(0);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(event => event.eventType === "fulfillment.cancelled")).toHaveLength(1);
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.upstreamCodePayload.ciphertext).toBeNull();
  });

  it("locks a refunded code and backs off if upstream disable is not confirmed", async () => {
    const {order} = await queuedOrder();
    markFullyRefunded(order);
    await runtime.fulfillments.processOne();
    const disable = vi.spyOn(runtime.upstream, "disableCdk").mockRejectedValue(new Error("uncertain disable"));
    await expect(runtime.cdk.reconcileRefundedOne()).rejects.toMatchObject({code: "voucher_disable_pending"});
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("disabling");
    expect(await runtime.cdk.reconcileRefundedOne()).toBeNull();
    expect(disable).toHaveBeenCalledTimes(1);
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.upstreamCodePayload.ciphertext).toBeTruthy();
  });

  it("keeps an earlier confirmed failure but closes its retry action after full refund", async () => {
    const {order} = await queuedOrder();
    vi.spyOn(runtime.upstream, "submitCdk").mockRejectedValue(new UpstreamRequestError("mailbox_login_failed", false));
    const failed = (await runtime.fulfillments.processOne())!;
    markFullyRefunded(runtime.repository.findOrderInternal(order.id)!);
    const closed = (await runtime.fulfillments.processOne())!;
    expect(closed).toMatchObject({id: failed.id, status: "failed", failureCode: "mailbox_login_failed", recoveryAction: "refund"});
    expect(partnerFulfillmentSnapshot(closed, undefined, runtime.fulfillments.canResubmit(closed))).toMatchObject({retry_allowed: false, next_action: "none"});
    expect(await runtime.fulfillments.processOne()).toBeNull();
    expect(runtime.repository.findOrderInternal(order.id)?.fallbackRechargeAvailable).toBe(false);
  });

  it("does not close a leased preflight until its worker releases the lease", async () => {
    const {order, task} = await queuedOrder();
    runtime.repository.updateFulfillment({...task, leaseToken: "worker-claim", leaseUntil: new Date(Date.now() + 60_000)});
    markFullyRefunded(order);
    expect(runtime.fulfillments.closeRefundedOrder(order.id)).toBeNull();
    expect(await runtime.cdk.reconcileRefundedOne()).toBeNull();
    runtime.repository.updateFulfillment({...task, leaseToken: "worker-claim", leaseUntil: new Date(0)});
    expect(runtime.fulfillments.closeRefundedOrder(order.id)?.status).toBe("cancelled");
  });

  it("does not pretend a dispatched refunded attempt was safely cancelled or disable its resource", async () => {
    const {order, task} = await queuedOrder();
    runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "accepted-task", lookupToken: "private-lookup", status: "review", stage: "payment_review",
      accountEmail: null, quotedAmountMinor: null, currency: null, message: null});
    markFullyRefunded(order);
    expect(runtime.fulfillments.closeRefundedOrder(order.id)).toBeNull();
    expect(await runtime.cdk.reconcileRefundedOne()).toBeNull();
    expect(runtime.repository.findFulfillment(tenant.merchantId, task.id)?.status).toBe("running");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("reserved");
  });

  it("does not close an active task for a partial price adjustment, but rejects a full price adjustment", async () => {
    const {order, task} = await queuedOrder();
    const admin = {id: "admin", role: "platform_admin" as const, merchantId: null};
    expect(() => runtime.refunds.requestPriceAdjustment(admin, order.id, {amount: "135.00", reason: "full refund", requestKey: randomUUID()}))
      .toThrow("全额退款不能使用差价退款");
    const partial = runtime.refunds.requestPriceAdjustment(admin, order.id, {amount: "10.00", reason: "price difference", requestKey: randomUUID()});
    await runtime.refunds.approve(admin, partial.id);
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("partially_refunded");
    expect(runtime.repository.findFulfillment(tenant.merchantId, task.id)?.status).toBe("queued");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("reserved");
  });

  it("blocks a refund arriving during preflight before any actual redemption checkpoint", async () => {
    const {order, task} = await queuedOrder();
    const redeemed = vi.fn();
    vi.spyOn(runtime.upstream, "submitCdk").mockImplementation(async input => {
      markFullyRefunded(order);
      input.onSubmitting?.("would-be-lookup");
      redeemed();
      throw new Error("must not redeem");
    });
    await runtime.fulfillments.processOne();
    expect(redeemed).not.toHaveBeenCalled();
    expect(runtime.repository.findFulfillment(tenant.merchantId, task.id)?.upstreamOrderId).toBeNull();
    expect((await runtime.fulfillments.processOne())?.status).toBe("cancelled");
  });
});
