import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {ZovoCardRechargeProvider} from "../src/upstream/zovocard-provider.js";

describe("CDK disable and real supplier isolation", () => {
  let runtime: Runtime;
  let tenant: TenantContext;
  let order: Order;
  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    order = await runtime.orders.create(tenant, {merchantOrderNo: "cdk", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00"});
    order = runtime.payment.markPaid(tenant.merchantId, order.id, {providerRef: "mock-paid", receivedMinor: order.saleAmountMinor});
  });
  afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); runtime.close();});

  it("locks redemption and refund while disable is uncertain, retries safely", async () => {
    const voucher = (await runtime.cdk.issueOne())!;
    const disable = vi.spyOn(runtime.upstream, "disableCdk").mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(undefined);
    await expect(runtime.cdk.disable(order.id)).rejects.toMatchObject({code: "voucher_disable_pending"});
    expect(runtime.cdk.findPublic(voucher.publicCode)?.status).toBe("disabling");
    expect(() => runtime.fulfillments.createCdkPublic(order, voucher, "upstream-code", {mode: "session", session: "session"})).toThrow();
    expect(() => runtime.refunds.request(tenant, order.id, {merchantRefundNo: "refund", type: "full", amount: "135.00", reason: "test"})).toThrow();
    expect((await runtime.cdk.disable(order.id)).status).toBe("disabled");
    await runtime.cdk.disable(order.id);
    expect(disable).toHaveBeenCalledTimes(2);
    expect(runtime.repository.findCdkVoucherByOrder(order.id)?.upstreamCodePayload.ciphertext).toBeNull();
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(x => x.eventType === "cdk.disabled")).toHaveLength(1);
    expect(runtime.orders.get(tenant.merchantId, order.id).paymentStatus).toBe("paid");
  });

  it("refuses to disable reserved codes, but permits disable after queued cancellation", async () => {
    const voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "session"});
    await expect(runtime.cdk.disable(order.id)).rejects.toMatchObject({code: "voucher_disable_conflict"});
    runtime.fulfillments.cancelQueued(tenant.merchantId, task.id);
    expect((await runtime.cdk.disable(order.id)).status).toBe("disabled");
  });

  it("uses the upstream live card-pool policy and validates disable acknowledgement", async () => {
    const calls: Array<{url: string; init: RequestInit}> = [];
    const replies = [{code: 0, data: {issued: [{id: 88, code: "ZC-PRIVATE"}]}}, {code: 0, data: {id: 88, status: "disabled"}}];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({url, init});
      return Response.json(replies.shift());
    }));
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", null, 2500);
    await provider.issueCdk({plan: "plus", idempotencyKey: "order"});
    await provider.disableCdk("88");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({count: 1, funding_confirmed: true});
    expect(body).not.toHaveProperty("owner_funding_cap_minor");
    expect(calls[1]!.url).toBe("https://supplier.test/openapi/v1/gpt-direct/cdks/88/disable");
  });

  it("recovers a lost disable response through read-only inventory confirmation", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(Response.json({code: 0, data: {list: [{id: 88, status: "disabled"}]}}));
    vi.stubGlobal("fetch", fetcher);
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", null);
    await provider.disableCdk("88");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({method: "GET"});
  });
});
