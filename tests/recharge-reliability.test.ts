import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {UpstreamRequestError, type UpstreamOrderState} from "../src/upstream/recharge-provider.js";
import type {Fulfillment, Order, TenantContext} from "../src/domain/model.js";
import {partnerFulfillmentDetails, platformFulfillmentDetails} from "../src/modules/fulfillment-public.js";
import {historicalDirectOrder, publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("recharge recovery and atomicity", () => {
  let runtime: Runtime;
  let tenant: TenantContext;

  beforeEach(() => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });

  afterEach(() => { vi.restoreAllMocks(); runtime.close(); });

  async function paidOrder(mode: "direct" | "cdk" = "direct"): Promise<Order> {
    const order = await runtime.orders.create(tenant, {
      merchantOrderNo: `order-${Math.random()}`, productCode: mode === "direct" ? "chatgpt_plus_cdk_1m" : "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00",
    });
    const paid = runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: `pay-${order.id}`, receivedMinor: order.saleAmountMinor});
    return mode === "direct" ? historicalDirectOrder(runtime, paid) : paid;
  }

  function due(value: Fulfillment): void {
    const latest = runtime.repository.findFulfillment(value.merchantId, value.id)!;
    runtime.repository.updateFulfillment({...latest, nextCheckAt: new Date(0), leaseUntil: null});
  }

  it("keeps an uncertain direct submission running and recovers by query without submitting again", async () => {
    const order = await paidOrder();
    const fulfillment = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "private-session"});
    const submit = vi.spyOn(runtime.upstream, "submitDirect").mockImplementation(async (input) => {
      input.onSubmitting?.(null);
      throw new UpstreamRequestError("upstream_unavailable", true);
    });
    const query = vi.spyOn(runtime.upstream, "query").mockResolvedValue(state("completed", "upstream-1"));
    expect((await runtime.fulfillments.processOne())?.status).toBe("running");
    const uncertain = runtime.repository.findFulfillment(tenant.merchantId, fulfillment.id)!;
    expect(uncertain.upstreamOrderId).toBeNull();
    expect(uncertain.sessionPayload.ciphertext).toBeNull();
    expect(() => runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "duplicate"})).toThrow();
    due(uncertain);
    expect((await runtime.fulfillments.processOne())?.status).toBe("succeeded");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({orderId: "", clientRequestId: fulfillment.id}));
  });

  it("encrypts the CDK recovery token and never releases a code just because querying failed", async () => {
    const order = await paidOrder("cdk");
    const voucher = (await runtime.cdk.issueOne())!;
    const fulfillment = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "private-session"});
    const submit = vi.spyOn(runtime.upstream, "submitCdk").mockImplementation(async (input) => {
      input.onSubmitting?.("private-redemption-lookup-token");
      throw new UpstreamRequestError("upstream_unavailable", true);
    });
    const query = vi.spyOn(runtime.upstream, "query").mockRejectedValue(new UpstreamRequestError("upstream_configuration_error", false));
    await runtime.fulfillments.processOne();
    const uncertain = runtime.repository.findFulfillment(tenant.merchantId, fulfillment.id)!;
    expect(JSON.stringify(uncertain)).not.toContain("private-redemption-lookup-token");
    expect(uncertain.lookupPayload?.ciphertext).toBeTruthy();
    due(uncertain);
    expect((await runtime.fulfillments.processOne())?.status).toBe("running");
    expect(query).toHaveBeenCalledWith(expect.objectContaining({lookupToken: "private-redemption-lookup-token"}));
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("reserved");
    expect(submit).toHaveBeenCalledTimes(1);
    const completed = runtime.fulfillments.applyUpstreamEvent(fulfillment.id, state("completed", "cdk-order-1"));
    expect(completed?.status).toBe("succeeded");
    expect(completed?.lookupPayload?.ciphertext).toBeNull();
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.status).toBe("consumed");
  });

  it("claims one worker task and preserves a webhook terminal state over a late HTTP response", async () => {
    const order = await paidOrder();
    const fulfillment = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "session"});
    let resolveResponse!: (value: UpstreamOrderState) => void;
    const submit = vi.spyOn(runtime.upstream, "submitDirect").mockImplementation(async (input) => {
      input.onSubmitting?.(null);
      return new Promise((resolve) => { resolveResponse = resolve; });
    });
    const firstWorker = runtime.fulfillments.processOne();
    expect(await runtime.fulfillments.processOne()).toBeNull();
    runtime.fulfillments.applyUpstreamEvent(fulfillment.id, state("completed", "upstream-2"));
    resolveResponse(state("queued", "upstream-2"));
    expect((await firstWorker)?.status).toBe("succeeded");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter((event) => event.eventType === "fulfillment.succeeded")).toHaveLength(1);
  });

  it("retries preflight failures that happen before dispatch without losing the credential", async () => {
    const order = await paidOrder();
    const fulfillment = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "session"});
    const submit = vi.spyOn(runtime.upstream, "submitDirect").mockRejectedValueOnce(new UpstreamRequestError("upstream_quote_unavailable", true));
    const retrying = (await runtime.fulfillments.processOne())!;
    expect(retrying.status).toBe("queued");
    expect(retrying.sessionPayload.ciphertext).toBeTruthy();
    due(fulfillment);
    expect((await runtime.fulfillments.processOne())?.status).toBe("succeeded");
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable white-label reason for a terminal preflight rejection", async () => {
    const order = await paidOrder();
    runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "session"});
    vi.spyOn(runtime.upstream, "submitDirect").mockRejectedValue(new UpstreamRequestError("precheck_rejected", false, "该账号需要先完成人机核验"));
    const result = await runtime.fulfillments.processOne();
    expect(result).toMatchObject({status: "failed", failureCode: "precheck_rejected", message: "该账号需要先完成人机核验"});
    const event = runtime.repository.listOutbox(tenant.merchantId).find(x => x.eventType === "fulfillment.failed")!;
    expect(event.payload).toMatchObject({failure_code: "precheck_rejected", message: "该账号需要先完成人机核验"});
    expect(JSON.stringify(event.payload)).not.toMatch(/zovo|supplier|upstream/i);
  });

  it("preserves actual upstream progress and terminal result while filtering partner-visible fields", async () => {
    const order = await paidOrder();
    const profile = runtime.agents.profile(tenant.merchantId);
    runtime.repository.saveOperations("agent_profile", {
      ...profile,
      orderVisibility: ["result_code", "card_last_four", "charge_amount"],
      version: profile.version + 1,
      updatedAt: new Date(),
    });
    const fulfillment = runtime.fulfillments.createDirectPublic(order, {mode: "session", session: "session"});
    const reviewing = runtime.fulfillments.applyUpstreamEvent(fulfillment.id, {
      ...state("review", "upstream-result-1"), stage: "payment_review", message: "ZovoCard 正在人工对账 https://supplier.example/order",
    })!;
    expect(reviewing).toMatchObject({status: "running", upstreamStatus: "review", upstreamStage: "payment_review"});
    expect(reviewing.message).toBe("充值结果待人工对账，请勿重复提交");

    const failed = runtime.fulfillments.applyUpstreamEvent(fulfillment.id, {
      ...state("declined", "upstream-result-1"), stage: "declined", message: "最终支付被拒",
      chargedAmountMinor: 98214, cardLastFour: "1234",
    })!;
    expect(failed).toMatchObject({status: "failed", failureCode: "payment_declined", upstreamStatus: "declined",
      upstreamChargedMinor: 98214, upstreamCardLastFour: "1234", message: "最终支付被拒"});
    expect(partnerFulfillmentDetails(failed, ["result_code", "card_last_four"])).toEqual({result_code: "declined", card_last_four: "1234"});
    expect(platformFulfillmentDetails(failed)).toMatchObject({upstream_order_id: "upstream-result-1", result_code: "declined",
      card_last_four: "1234", charge_amount_minor: 98214});
    const event = runtime.repository.listOutbox(tenant.merchantId).find(x => x.eventType === "fulfillment.failed")!;
    expect(event.payload).toMatchObject({result_code: "declined", card_last_four: "1234", charge_amount_minor: 98214,
      failure_code: "payment_declined", message: "最终支付被拒"});
    expect(JSON.stringify(event.payload)).not.toContain("upstream-result-1");
  });

  it("prevents ordinary refunds while fulfillment or usable CDK delivery is committed", async () => {
    const direct = await paidOrder();
    runtime.fulfillments.createDirectPublic(direct, {mode: "session", session: "session"});
    expect(() => runtime.refunds.request(tenant, direct.id, {merchantRefundNo: "rf-active", type: "full", amount: "135.00", reason: "退款"})).toThrow("不能执行普通退款");
    const cdkOrder = await paidOrder("cdk");
    await runtime.cdk.issueOne();
    expect(() => runtime.refunds.request(tenant, cdkOrder.id, {merchantRefundNo: "rf-code", type: "full", amount: "135.00", reason: "退款"})).toThrow("不能执行普通退款");
  });

  it("does not issue a new CDK after a refund has reserved the order", async () => {
    const order = await paidOrder("cdk");
    runtime.refunds.request(tenant, order.id, {merchantRefundNo: "rf-before-code", type: "full", amount: "135.00", reason: "退款"});
    const issue = vi.spyOn(runtime.upstream, "issueCdk");
    expect(await runtime.cdk.issueOne()).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it("claims CDK issuance once and publishes voucher, order and event together", async () => {
    const order = await paidOrder("cdk");
    let resolveIssue!: (value: {id: string; code: string}) => void;
    const issue = vi.spyOn(runtime.upstream, "issueCdk").mockImplementation(async () => new Promise((resolve) => { resolveIssue = resolve; }));
    const pending = runtime.cdk.issueOne();
    expect(await runtime.cdk.issueOne()).toBeNull();
    expect(() => runtime.refunds.request(tenant, order.id, {merchantRefundNo: "rf-during-issue", type: "full", amount: "135.00", reason: "退款"})).toThrow();
    resolveIssue({id: "supplier-code-1", code: "ZC-PRIVATE-CODE"});
    const voucher = await pending;
    expect(issue).toHaveBeenCalledTimes(1);
    expect(runtime.repository.findOrderInternal(order.id)?.voucherCode).toBe(voucher?.publicCode);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter((event) => event.eventType === "cdk.issued")).toHaveLength(1);
  });

  it("rolls back payment and financial state when its event cannot be persisted", async () => {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: "rollback-payment", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    vi.spyOn(runtime.webhooks, "emit").mockImplementation(() => { throw new Error("simulated storage error"); });
    expect(() => runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "payment-1", receivedMinor: order.saleAmountMinor})).toThrow();
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("pending");
    expect(runtime.repository.findPaymentAttemptByOrder(tenant.merchantId, order.id)?.status).toBe("pending");
    expect(runtime.repository.listLedger(tenant.merchantId)).toHaveLength(0);
  });

  it("keeps one order and payment attempt for concurrent requests with the same merchant order number", async () => {
    const input = {merchantOrderNo: "concurrent-order", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"};
    const [first, second] = await Promise.all([runtime.orders.create(tenant, input), runtime.orders.create(tenant, input)]);
    expect(first.id).toBe(second.id);
    expect(runtime.repository.listOrders(tenant.merchantId)).toHaveLength(1);
    expect(runtime.repository.findPaymentAttemptByOrder(tenant.merchantId, first.id)).not.toBeNull();
  });
  it("forbids an agent from cancelling a stuck running recharge or resubmitting it", async () => {
    const order = await paidOrder("cdk");
    const voucher = (await runtime.cdk.issueOne())!;
    const paid = {...runtime.repository.findOrderInternal(order.id)!, deliveryMode: "auto_recharge" as const};
    runtime.repository.updateOrder(paid);
    const code = runtime.cdk.readUpstreamCode(voucher);
    const fulfillment = runtime.fulfillments.createCdkPublic(paid, voucher, code, {mode: "session", session: "stuck-session"});
    vi.spyOn(runtime.upstream, "submitCdk").mockImplementation(async (input) => {
      input.onSubmitting?.(null);
      return state("processing", "upstream-stuck-1");
    });
    expect((await runtime.fulfillments.processOne())?.status).toBe("running");
    expect(() => runtime.fulfillments.createCdkPublic(
      runtime.repository.findOrderInternal(paid.id)!,
      runtime.repository.findCdkVoucherByOrder(paid.id)!,
      code,
      {mode: "session", session: "again"},
    )).toThrow();
    expect(() => runtime.fulfillments.cancelActiveForResubmit(tenant.merchantId, paid.id)).toThrow("不能主动取消");
    expect(() => runtime.fulfillments.prepareRecovery(tenant.merchantId, fulfillment.id, "retry")).toThrow("不能本地强制取消");
    expect(runtime.repository.findFulfillment(tenant.merchantId, fulfillment.id)?.status).toBe("running");
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)?.status).toBe("reserved");
  });

  it("allows platform cancellation before dispatch so the user can resubmit", async () => {
    const order = await paidOrder("cdk");
    const voucher = (await runtime.cdk.issueOne())!;
    const paid = {...runtime.repository.findOrderInternal(order.id)!, deliveryMode: "auto_recharge" as const};
    runtime.repository.updateOrder(paid);
    const fulfillment = runtime.fulfillments.createCdkPublic(
      paid,
      voucher,
      runtime.cdk.readUpstreamCode(voucher),
      {mode: "session", session: "queued-session"},
    );
    expect(fulfillment.status).toBe("queued");
    expect(() => runtime.fulfillments.cancelActiveForResubmit(tenant.merchantId, paid.id)).toThrow("不能主动取消");
    const cancelled = runtime.fulfillments.prepareRecovery(tenant.merchantId, fulfillment.id, "retry");
    expect(cancelled.status).toBe("cancelled");
    expect(runtime.repository.findOrderInternal(paid.id)?.fallbackRechargeAvailable).toBe(true);
    const retry = runtime.fulfillments.createCdkPublic(
      runtime.repository.findOrderInternal(paid.id)!,
      runtime.repository.findCdkVoucherByOrder(paid.id)!,
      runtime.cdk.readUpstreamCode(runtime.repository.findCdkVoucherByOrder(paid.id)!),
      {mode: "session", session: "retry-session"},
    );
    expect(retry.attemptNo).toBe(2);
  });
});

function state(status: string, orderId: string): UpstreamOrderState {
  return {orderId, status, lookupToken: null, stage: status, accountEmail: null, quotedAmountMinor: null, currency: "USD", message: null};
}
