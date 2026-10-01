import {randomUUID} from "node:crypto";
import {existsSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {partnerFulfillmentProgress} from "../src/modules/fulfillment-public.js";
import type {UpstreamOrderState} from "../src/upstream/recharge-provider.js";
import {OutboxWorker} from "../src/worker/outbox-worker.js";
import {RepositoryWebhookDeliveryStore} from "../src/worker/repository-webhook-store.js";
import {verifyWebhook} from "../src/modules/webhook-signature.js";
import {historicalDirectOrder, publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("partner progress delivery and confirmed failure recovery", () => {
  let runtime: Runtime, tenant: TenantContext;
  beforeEach(() => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    publishTestRechargeProduct(runtime);
    const merchant = runtime.repository.findMerchantByPartner("pt_demo_a")!;
    const app = runtime.repository.listApps(merchant.id)[0]!;
    tenant = {merchantId: merchant.id, partnerId: merchant.partnerId, appId: app.id, keyId: "key_demo_a_01"};
  });
  afterEach(() => {vi.restoreAllMocks(); runtime.close();});

  async function paidOrder(cdk = false): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: cdk ? "chatgpt_plus_cdk_1m" : "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", ...(cdk ? {deliveryMode: "auto_recharge" as const} : {})});
    const paid = runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "test:" + order.id, receivedMinor: order.saleAmountMinor});
    return cdk ? paid : historicalDirectOrder(runtime, paid);
  }

  it("persists increasing progress versions, emits only changes, and does not disclose credentials", async () => {
    const order = await paidOrder();
    const task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "private-session-not-for-partners"});
    expect(task.progressVersion).toBe(1);
    const login = runtime.fulfillments.applyUpstreamEvent(task.id, state("running", "logging_in"))!;
    expect(partnerFulfillmentProgress(login)).toMatchObject({progress_stage: "logging_in", progress_version: 2});
    const unchanged = runtime.fulfillments.applyUpstreamEvent(task.id, state("running", "logging_in"))!;
    expect(unchanged.progressVersion).toBe(2);
    expect(unchanged.progressUpdatedAt).toEqual(login.progressUpdatedAt);
    const confirming = runtime.fulfillments.applyUpstreamEvent(task.id, state("pending", "payment_review"))!;
    expect(confirming.progressVersion).toBe(3);
    const events = runtime.repository.listOutbox(tenant.merchantId).filter(event => event.eventType === "fulfillment.updated");
    expect(events.map(event => event.payload.progress_version)).toEqual([1, 2, 3]);
    expect(events[2]!.payload).toMatchObject({status: "running", progress_stage: "confirming", attempt_no: 1, retry_allowed: false, next_action: "wait"});
    expect(JSON.stringify(events)).not.toMatch(/private-session|supplier-order|private-lookup|internal-provider/);
    const done = runtime.fulfillments.applyUpstreamEvent(task.id, state("completed", "completed"))!;
    expect(done.progressVersion).toBe(4);
    const terminal = runtime.repository.listOutbox(tenant.merchantId).find(event => event.eventType === "fulfillment.succeeded")!;
    expect(terminal.payload).toMatchObject({status: "succeeded", progress_version: 4, progress_stage: "completed", redemption_id: task.id});
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(event => event.eventType === "fulfillment.updated")).toHaveLength(3);
  });

  it("allows confirmed CDK failure to resubmit on the original order without charging again", async () => {
    const order = await paidOrder(true), voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "first"});
    const failed = runtime.fulfillments.applyUpstreamEvent(task.id, state("declined", "declined"))!;
    expect(runtime.fulfillments.canResubmit(failed)).toBe(true);
    const event = runtime.repository.listOutbox(tenant.merchantId).find(value => value.eventType === "fulfillment.failed")!;
    expect(event.payload).toMatchObject({status: "failed", retry_allowed: true, next_action: "resubmit", fallback_recharge_available: true});
    const ledgerCount = runtime.repository.listLedger(tenant.merchantId).length;
    const reusable = runtime.repository.findCdkVoucherByOrder(order.id)!;
    const retry = runtime.fulfillments.createCdkPublic(runtime.repository.findOrderInternal(order.id)!, reusable,
      runtime.cdk.readUpstreamCode(reusable), {mode: "session", session: "corrected"});
    expect(retry).toMatchObject({orderId: order.id, attemptNo: 2, progressVersion: 1, status: "queued"});
    expect(runtime.repository.listLedger(tenant.merchantId)).toHaveLength(ledgerCount);
    expect(runtime.fulfillments.canResubmit(failed)).toBe(false);
    expect(runtime.repository.findOrderInternal(order.id)?.fallbackRechargeAvailable).toBe(false);
  });

  it("blocks user resubmission for unknown results and after a refund reserves the order", async () => {
    const order = await paidOrder();
    const task = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "first"});
    const unknown = runtime.fulfillments.applyUpstreamEvent(task.id, state("review", "payment_review"))!;
    expect(runtime.fulfillments.canResubmit(unknown)).toBe(false);
    expect(() => runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "duplicate"})).toThrow();
    const failed = runtime.fulfillments.applyUpstreamEvent(task.id, state("failed_precharge", "failed"))!;
    expect(runtime.fulfillments.canResubmit(failed)).toBe(true);
    runtime.refunds.request(tenant, order.id, {merchantRefundNo: randomUUID(), type: "full", amount: "135.00", reason: "customer chose refund"});
    expect(runtime.fulfillments.canResubmit(failed)).toBe(false);
    expect(() => runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "after-refund"})).toThrow("退款流程");
  });

  it("lets platform cancel an undispatched task and choose refund instead of resubmission", async () => {
    const order = await paidOrder(true), voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "first"});
    const cancelled = runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "refund");
    expect(cancelled).toMatchObject({status: "cancelled", recoveryAction: "refund", retryAllowed: true});
    expect(runtime.fulfillments.canResubmit(cancelled)).toBe(false);
    const pending = runtime.refunds.requestCustomerRefund({id: "admin", merchantId: null, role: "platform_admin"}, order.id,
      {reason: "cancel before dispatch", requestKey: randomUUID()});
    expect(pending.status).toBe("requested");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("disabled");
    expect(() => runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "retry")).toThrow("退款流程");
  });

  it("allows recovery only after the supplier explicitly confirms cancellation", async () => {
    const order = await paidOrder(true), voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "first"});
    runtime.fulfillments.applyUpstreamEvent(task.id, state("processing", "dispatching"));
    expect(() => runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "retry")).toThrow("不能本地强制取消");
    const cancelled = runtime.fulfillments.applyUpstreamEvent(task.id, state("cancelled", "cancelled"))!;
    expect(runtime.fulfillments.canResubmit(cancelled)).toBe(true);
    const choice = runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "refund");
    expect(choice.recoveryAction).toBe("refund");
    expect(runtime.fulfillments.canResubmit(choice)).toBe(false);
    const update = runtime.repository.listOutbox(tenant.merchantId).filter(value => value.eventType === "fulfillment.updated").at(-1)!;
    expect(update.payload).toMatchObject({status: "cancelled", recovery_action: "refund", retry_allowed: false});
  });

  it("rolls back progress and its version if the outbox event cannot be saved", async () => {
    const task = runtime.fulfillments.createDirectPublic(await paidOrder(), {mode: "session", session: "first"});
    const original = runtime.repository.findFulfillment(tenant.merchantId, task.id)!;
    vi.spyOn(runtime.webhooks, "emit").mockImplementation(() => {throw new Error("outbox unavailable");});
    expect(() => runtime.fulfillments.applyUpstreamEvent(task.id, state("running", "logging_in"))).toThrow();
    expect(runtime.repository.findFulfillment(tenant.merchantId, task.id)).toEqual(original);
  });

  it("signs progress notifications through the existing durable delivery mechanism", async () => {
    runtime.repository.saveWebhookEndpoint({id: "test-progress-webhook", merchantId: tenant.merchantId,
      url: "https://partner.example.test/webhooks", secret: "isolated-test-webhook-secret-not-for-production",
      subscribedEvents: ["fulfillment.updated"], status: "active"});
    const task = runtime.fulfillments.createDirectPublic(await paidOrder(), {mode: "session", session: "first"});
    const deliveries: Array<{headers: Headers; body: Buffer}> = [];
    const worker = new OutboxWorker(new RepositoryWebhookDeliveryStore(runtime.repository), async (_url, init) => {
      deliveries.push({headers: new Headers(init.headers), body: Buffer.from(String(init.body))});
      return {ok: true, status: 204};
    });
    await worker.tick();
    const progress = deliveries.find(item => item.headers.get("x-quefa-event") === "fulfillment.updated")!;
    expect(progress).toBeDefined();
    const endpoint = runtime.repository.listWebhookEndpoints(tenant.merchantId).find(value => value.id === "test-progress-webhook")!;
    expect(verifyWebhook(Number(progress.headers.get("x-quefa-timestamp")), progress.body, endpoint.secret,
      progress.headers.get("x-quefa-signature")!)).toBe(true);
    expect(JSON.parse(progress.body.toString()).data.fulfillment_id).toBe(task.id);
  });
});

it("preserves progress versions and timestamps across a SQLite restart", async () => {
  const path = join(tmpdir(), "quefa-progress-" + randomUUID() + ".sqlite");
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: path, LOG_LEVEL: "silent"});
  let runtime: Runtime | undefined;
  try {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
    const app = runtime.repository.listApps(merchant.id)[0]!;
    const tenant: TenantContext = {merchantId: merchant.id, partnerId: merchant.partnerId, appId: app.id, keyId: config.demoKeyId};
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    const paid = historicalDirectOrder(runtime, runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "test:" + order.id, receivedMinor: order.saleAmountMinor}));
    const task = runtime.fulfillments.createDirectPublic(paid, {mode: "session", session: "first"});
    runtime.fulfillments.applyUpstreamEvent(task.id, state("running", "logging_in"));
    runtime.close(); runtime = createRuntime(config);
    const restored = runtime.repository.findFulfillment(tenant.merchantId, task.id)!;
    expect(restored.progressVersion).toBe(2);
    expect(restored.progressUpdatedAt).toBeInstanceOf(Date);
    expect(partnerFulfillmentProgress(restored).progress_updated_at).toBe(restored.progressUpdatedAt!.toISOString());
    const updated = runtime.fulfillments.applyUpstreamEvent(task.id, state("pending", "payment_review"))!;
    expect(updated.progressVersion).toBe(3);
  } finally {
    runtime?.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

function state(status: string, stage: string): UpstreamOrderState {
  return {orderId: "supplier-order-private", lookupToken: "private-lookup", status, stage,
    accountEmail: null, quotedAmountMinor: null, currency: null, message: null};
}
