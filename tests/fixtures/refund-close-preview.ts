// Local browser acceptance only. Explicit test configuration, memory storage and fake channels.
// Run without --env-file. Nothing in this fixture contacts Alipay or a recharge supplier.
import {loadConfig} from "../../src/config.js";
import {createRuntime} from "../../src/bootstrap.js";
import {buildApp} from "../../src/app.js";
import {RefundService} from "../../src/modules/refund-service.js";
import {publishTestRechargeProduct} from "./recharge-catalog.js";

const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", EXECUTION_MODE: "disabled",
  PAYMENT_PROVIDER: "mock", FULFILLMENT_PROVIDER: "mock", LIVE_TEST_ENABLED: "false", LOG_LEVEL: "silent",
  PUBLIC_BASE_URL: "http://127.0.0.1:3301", ADMIN_BASE_URL: "http://127.0.0.1:3301", DEMO_WEBHOOK_URL: ""});
globalThis.fetch = async () => { throw new Error("preview_external_network_forbidden"); };
const runtime = createRuntime(config);
publishTestRechargeProduct(runtime);
const admin = await runtime.accounts.bootstrap("preview-refund-admin", "preview-initial-password-only");
await runtime.accounts.changePassword(admin, "preview-initial-password-only", "preview-refund-password-only");
const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
const tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId,
  appId: bundle.app.id, keyId: bundle.key.keyId};
const scenarios = new Map<string, {kind: string; orderId: string; queryCalls: number}>();
let executeCalls = 0;
runtime.refunds = new RefundService(runtime.repository, runtime.ledger, runtime.webhooks, {
  providerFor: () => "alipay_page",
  execute: async () => { executeCalls++; throw new Error("preview_refund_execution_forbidden"); },
  query: async (_orderId, refund) => {
    const scenario = scenarios.get(refund.id);
    if (!scenario) throw new Error("preview_unknown_refund");
    scenario.queryCalls++;
    return {status: "not_confirmed", bindingVerified: scenario.kind !== "unconfirmed"};
  },
});
for (const kind of ["unconfirmed", "desktop-success", "mobile-success"]) {
  const order = await runtime.orders.create(tenant, {merchantOrderNo: "preview-refund-" + kind,
    productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
  const paid = runtime.payment.markPaid(tenant.merchantId, order.id,
    {providerRef: "preview-payment-" + kind, receivedMinor: order.saleAmountMinor});
  const payment = runtime.repository.findPaymentAttemptByOrder(tenant.merchantId, order.id)!;
  runtime.repository.updatePaymentAttempt({...payment, provider: "alipay_page"});
  const voucher = (await runtime.cdk.issueOne())!;
  const task = runtime.fulfillments.createCdkPublic(paid, voucher, runtime.cdk.readUpstreamCode(voucher),
    {mode: "session", session: "preview-only-not-a-real-session"});
  runtime.fulfillments.applyUpstreamEvent(task.id, {orderId: "preview-upstream-" + kind, lookupToken: null,
    status: "failed_precharge", stage: "failed_precharge", accountEmail: null, quotedAmountMinor: null,
    currency: null, message: "本地模拟：充值明确失败"});
  const refund = runtime.refunds.request(tenant, order.id, {merchantRefundNo: "preview-refund-request-" + kind,
    type: "full", amount: "135.00", reason: "本地模拟：原充值失败后申请退款"});
  runtime.repository.updateRefund({...refund, status: "failed", failureCode: "preview_channel_failed",
    createdAt: new Date(Date.now() - 15 * 60_000), lastSubmittedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    nextCheckAt: null});
  scenarios.set(refund.id, {kind, orderId: order.id, queryCalls: 0});
}
const app = await buildApp(config, runtime);
app.get("/__preview/state", async () => ({executeCalls, scenarios: [...scenarios].map(([id, scenario]) => {
  const refund = runtime.repository.findRefund(tenant.merchantId, id)!;
  return {id, ...scenario, status: refund.status, failureCode: refund.failureCode,
    review: refund.cancelledReview ?? null,
    fulfillmentStates: runtime.repository.listFulfillments(tenant.merchantId, scenario.orderId).map(value => value.status),
    auditActions: runtime.repository.listAudit(tenant.merchantId).filter(value => value.targetId === id).map(value => value.action)};
})}));
await app.listen({host: "127.0.0.1", port: 3301});
console.log("Memory-only refund-close preview: http://127.0.0.1:3301/workspace");
setTimeout(async () => { await app.close(); runtime.close(); }, 25 * 60_000).unref();
