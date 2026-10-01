import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {TenantContext} from "../src/domain/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("cancel then refund clawback", () => {
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

  it("lets partner request ordinary refund after platform cancellation and claws margin on complete", async () => {
    const created = await runtime.orders.create(tenant, {
      merchantOrderNo: `cancel-refund-${Math.random()}`,
      productCode: "chatgpt_plus_cdk_1m",
      quantity: 1,
      saleAmount: "135.00",
    });
    const paid = runtime.payment.markPaid(tenant.merchantId, created.id, {
      providerRef: `pay-${created.id}`,
      receivedMinor: created.saleAmountMinor,
    });
    runtime.repository.updateOrder({...paid, deliveryMode: "auto_recharge"});
    const voucher = (await runtime.cdk.issueOne())!;
    const task = runtime.fulfillments.createCdkPublic(
      runtime.repository.findOrderInternal(paid.id)!,
      voucher,
      runtime.cdk.readUpstreamCode(voucher),
      {mode: "session", session: "sess"},
    );
    runtime.fulfillments.prepareRecovery(tenant.merchantId, task.id, "refund");
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)?.status).toBe("unused");

    const refund = runtime.refunds.request(tenant, paid.id, {
      merchantRefundNo: `R-${paid.id}`,
      type: "full",
      amount: "135.00",
      reason: "不能充值，申请退款",
    });
    expect(refund.status).toBe("requested");
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)?.status).toBe("disabled");

    const finance = {
      id: "fin", merchantId: null, role: "platform_finance" as const, username: "fin", displayName: "fin",
      status: "active" as const, passwordHash: "", authVersion: 1, failedLogins: 0, lockedUntil: null,
      mfaEnabled: false, mfaSecret: null, mustChangePassword: false, createdAt: new Date(0), updatedAt: new Date(0),
    };
    // mark payment as mock so completeForSandbox path isn't needed — use complete via approve with mock provider
    const attempt = runtime.repository.findPaymentAttemptByOrder(tenant.merchantId, paid.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "mock"});
    const done = await runtime.refunds.approve(finance, refund.id);
    expect(done.status).toBe("succeeded");
    const after = runtime.repository.findOrderInternal(paid.id)!;
    expect(after.paymentStatus).toBe("refunded");
    expect(after.ordinaryRefundedMinor).toBe(13500n);
    const marginDown = runtime.repository.listLedger(tenant.merchantId)
      .filter((item) => item.orderId === paid.id && item.type === "merchant_margin" && item.direction === "decrease");
    expect(marginDown.length).toBeGreaterThan(0);
  });
});
