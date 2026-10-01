import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {TenantContext} from "../src/domain/model.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";

describe("admin-only recharge cancellation and recovery choice", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>, tenant: TenantContext;
  let adminHeaders: Record<string, string>, agentHeaders: Record<string, string>;
  beforeEach(async () => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    await runtime.accounts.bootstrap("recovery-admin", "test-recovery-admin-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    const agent = await runtime.accounts.registerOwner({username: "recovery-agent", displayName: "test agent",
      merchantId: tenant.merchantId, password: "test-recovery-agent-password"});
    runtime.repository.saveOperations("account", {...agent, mustChangePassword: false});
    app = await buildApp(config, runtime);
    const loggedAdmin = await loginPlatform(app, "recovery-admin", "test-recovery-admin-password", "https://admin.tibo.ink");
    adminHeaders = {origin: "https://admin.tibo.ink", cookie: String(loggedAdmin.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": loggedAdmin.json().csrf};
    const loggedAgent = await app.inject({method: "POST", url: "/workspace/api/auth/login", headers: {origin: "https://tibo.ink"},
      payload: {username: "recovery-agent", password: "test-recovery-agent-password"}});
    agentHeaders = {origin: "https://tibo.ink", cookie: String(loggedAgent.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": loggedAgent.json().csrf};
  });
  afterEach(async () => {await app?.close(); runtime?.close();});

  async function queuedOrder(collectionMode: "platform_collect" | "agent_collect" = "platform_collect") {
    if (collectionMode === "agent_collect") {
      fundAndApproveApi(runtime, "pt_demo_a", "220.00");
      const profile = runtime.agents.profile(tenant.merchantId);
      runtime.agents.saveProfile({id: "test-admin", role: "platform_admin", merchantId: null}, tenant.merchantId,
        {...profile, collectionModes: ["platform_collect", "agent_collect"]});
    }
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m", quantity: 1,
      saleAmount: "135.00", deliveryMode: "auto_recharge", collectionMode});
    const paid = collectionMode === "agent_collect" ? order
      : runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "test:" + order.id, receivedMinor: order.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(paid, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "test-only"});
    return {order, task};
  }
  function resolve(orderId: string, fulfillmentId: string, action: "retry" | "refund", requestKey = randomUUID(), headers = adminHeaders) {
    return app.inject({method: "POST", url: "/workspace/api/orders/" + orderId + "/recharge/resolve", headers,
      payload: {fulfillmentId, action, requestKey, reason: "test cancellation choice", confirmCancel: true}});
  }

  it("rejects an agent even for their own task, and allows an admin to open the original order for retry", async () => {
    const {order, task} = await queuedOrder();
    expect((await resolve(order.id, task.id, "retry", randomUUID(), agentHeaders)).statusCode).toBe(403);
    const done = await resolve(order.id, task.id, "retry");
    expect(done.statusCode).toBe(200);
    expect(done.json().data).toMatchObject({status: "cancelled", retry_allowed: true, recovery_action: "retry", fallback_recharge_available: true});
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("paid");
  });

  it("creates one refund, replays the same choice, rejects a changed payload and locks resubmission", async () => {
    const {order, task} = await queuedOrder(), key = randomUUID();
    const first = await resolve(order.id, task.id, "refund", key);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({status: "cancelled", retry_allowed: false, recovery_action: "refund", refund_status: "requested"});
    expect((await resolve(order.id, task.id, "refund", key)).json()).toEqual(first.json());
    expect((await resolve(order.id, task.id, "retry", key)).statusCode).toBe(409);
    expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(1);
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("disabled");
    const detail = await app.inject({method: "GET", url: "/workspace/api/orders/" + order.id, headers: adminHeaders});
    expect(detail.json().data.canResolveRecharge).toBe(false);
  });

  it("refuses to force-cancel an already-dispatched task", async () => {
    const {order, task} = await queuedOrder();
    runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "private-order", lookupToken: null, status: "review", stage: "payment_review",
      accountEmail: null, quotedAmountMinor: null, currency: null, message: null});
    const blocked = await resolve(order.id, task.id, "refund");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("recharge_result_unconfirmed");
    expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(0);
    expect(runtime.repository.findFulfillment(tenant.merchantId, task.id)?.status).toBe("running");
  });

  it("refunds agent procurement exactly once without creating a customer gateway refund", async () => {
    const {order, task} = await queuedOrder("agent_collect"), key = randomUUID();
    const first = await resolve(order.id, task.id, "refund", key);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({procurement_refunded: true, refund_id: null, retry_allowed: false});
    expect((await resolve(order.id, task.id, "refund", key)).json()).toEqual(first.json());
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("refunded");
    expect(runtime.repository.listRefundsForOrder(tenant.merchantId, order.id)).toHaveLength(0);
    const refunds = runtime.repository.listOperations("wallet_entry", tenant.merchantId).filter(value => value.reference === order.id && value.kind === "purchase_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.procurementDelta).toBe(order.supplyAmountMinor);
    expect(runtime.wallets.summary({id: "test-admin", role: "platform_admin", merchantId: null}, tenant.merchantId).procurementAvailable).toBe("220.00");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("disabled");
  });
});
