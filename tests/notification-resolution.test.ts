import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import type {Actor, Ticket} from "../src/operations/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("notification case resolution", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  const admin: Actor = {id: "notification-admin", role: "platform_admin", merchantId: null};
  let runtime: Runtime;
  let tenant: TenantContext;

  beforeEach(() => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });

  afterEach(() => runtime.close());

  async function cancelledOrder(): Promise<{order: Order; taskId: string}> {
    const draft = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const order = runtime.payment.markPaid(tenant.merchantId, draft.id, {providerRef: "test:" + draft.id, receivedMinor: draft.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const queued = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "test"});
    const cancelled = runtime.fulfillments.prepareRecovery(tenant.merchantId, queued.id, "retry", "明确取消");
    expect(cancelled.status).toBe("cancelled");
    return {order, taskId: queued.id};
  }

  it("does not create a manual review case for an explicitly cancelled fulfillment", async () => {
    await cancelledOrder();
    await runtime.notifications.tick();
    expect(runtime.notifications.tasksPage(admin, 1, 30).data).toHaveLength(0);
  });

  it("resolves legacy system cases without systemCase metadata when the order is clearly cancelled", async () => {
    const {order} = await cancelledOrder();
    const now = new Date();
    const legacy: Ticket = {id: "case_legacy_cancelled", merchantId: tenant.merchantId, orderId: order.id,
      category: "recharge", title: "充值结果尚未确认，请等待平台核对，不要重复下单", status: "in_progress",
      assigneeId: null, version: 1, publicVersion: 1, createdBy: "system", createdAt: now, updatedAt: now};
    runtime.repository.saveOperations("ticket", legacy, true);
    await runtime.notifications.tick();
    expect(runtime.repository.getOperations("ticket", legacy.id)?.status).toBe("resolved");
    expect(runtime.notifications.tasksPage(admin, 1, 30).data).toHaveLength(0);
  });
});
