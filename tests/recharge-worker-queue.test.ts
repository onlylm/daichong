import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig, type AppConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import type {Repository} from "../src/infra/repository.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("bounded recharge worker queues", () => {
  let runtime: Runtime;
  let config: AppConfig;
  let tenant: TenantContext;

  beforeEach(() => {
    config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: credential.merchant.id, appId: credential.app.id, keyId: credential.key.keyId, partnerId: credential.merchant.partnerId};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.close();
  });

  async function paidOrder(sequence: number): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: `WORKER-${sequence}`, productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    return runtime.payment.markPaid(order.merchantId, order.id, {providerRef: `worker-payment-${sequence}`, receivedMinor: order.saleAmountMinor});
  }

  it("caps CDK issuance candidates and resolves vouchers by exact id without scanning all orders", async () => {
    for (let index = 0; index < 22; index++) await paidOrder(index);
    const repository = runtime.repository as Repository;
    const candidates = repository.listCdkIssuanceCandidates!(20, new Date());
    expect(candidates).toHaveLength(20);
    expect(new Set(candidates.map(order => order.id)).size).toBe(20);

    const fullOrders = vi.spyOn(runtime.repository, "listOrdersInternal");
    const voucher = await runtime.cdk.issueOne();
    expect(voucher).not.toBeNull();
    expect(runtime.repository.findCdkVoucherById(voucher!.id)?.orderId).toBe(voucher!.orderId);
    expect(fullOrders).not.toHaveBeenCalled();
  });

  it("finds and disables only a refundable unused CDK without a historical order scan", async () => {
    const order = await paidOrder(30);
    const voucher = (await runtime.cdk.issueOne())!;
    runtime.repository.updateOrder({...runtime.repository.findOrderInternal(order.id)!, paymentStatus: "refunded",
      ordinaryRefundedMinor: order.saleAmountMinor, updatedAt: new Date()});
    const repository = runtime.repository as Repository;
    expect(repository.findRefundedCdkCleanupOrder!(new Date())?.id).toBe(order.id);

    const fullOrders = vi.spyOn(runtime.repository, "listOrdersInternal");
    const disabled = await runtime.cdk.reconcileRefundedOne();
    expect(disabled).toMatchObject({id: voucher.id, status: "disabled"});
    expect(fullOrders).not.toHaveBeenCalled();
  });

  it("closes a never-dispatched refunded recharge task through the indexed cleanup queue", async () => {
    const order = await paidOrder(40);
    const voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(runtime.repository.findOrderInternal(order.id)!, voucher,
      runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "worker-cleanup-session"});
    runtime.repository.updateOrder({...runtime.repository.findOrderInternal(order.id)!, paymentStatus: "refunded",
      ordinaryRefundedMinor: order.saleAmountMinor, fallbackRechargeAvailable: true, updatedAt: new Date()});
    const repository = runtime.repository as Repository;
    expect(repository.findRefundedFulfillmentCleanupOrder!(new Date())?.id).toBe(order.id);

    const fullOrders = vi.spyOn(runtime.repository, "listOrdersInternal");
    const closed = await runtime.fulfillments.processOne();
    expect(closed).toMatchObject({id: task.id, status: "cancelled", recoveryAction: "refund"});
    expect(runtime.repository.findOrderInternal(order.id)?.fallbackRechargeAvailable).toBe(false);
    expect(fullOrders).not.toHaveBeenCalled();
  });

  it("selects only successful, due, unconfirmed cost readback candidates", async () => {
    const order = await paidOrder(50);
    const voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(runtime.repository.findOrderInternal(order.id)!, voucher,
      runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "worker-cost-session"});
    runtime.repository.updateFulfillment({...runtime.repository.findFulfillment(order.merchantId, task.id)!, status: "succeeded",
      upstreamProvider: "mock", upstreamOrderId: "worker-upstream-cost", finishedAt: new Date()});
    const repository = runtime.repository as Repository;
    expect(repository.findCostReadCandidate!(new Date(), new Date(Date.now() - 48 * 60 * 60_000))?.id).toBe(order.id);

    runtime.costs.verify({id: "worker-admin", role: "platform_admin", merchantId: null}, order.id, {version: 0,
      actualUsd: "15.00", feesUsd: "0.00", retainedUsd: "0.15", fxRate: "7", sourceReference: "worker-cost-reference",
      evidence: "已核实本次测试成本清算凭证", confirmEvidence: true, destination: "platform_pass_through"});
    expect(repository.findCostReadCandidate!(new Date(), new Date(Date.now() - 48 * 60 * 60_000))).toBeNull();
  });
});
