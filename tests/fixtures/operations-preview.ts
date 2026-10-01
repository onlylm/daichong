// Local visual QA only: no persistent data, production credentials or external providers.
import {loadConfig} from "../../src/config.js";
import {createRuntime} from "../../src/bootstrap.js";
import {buildApp} from "../../src/app.js";
const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PUBLIC_BASE_URL: "http://127.0.0.1:3299"});
const runtime = createRuntime(config);
const admin = await runtime.accounts.bootstrap("preview-admin", "preview-local-password-only");
const merchantId = runtime.repository.findMerchantByPartner("pt_demo_a")!.id;
runtime.agents.saveRules(admin, {version: 0, metric: "completed_orders", enabled: false, levels: [{code: "standard", name: "标准代理", threshold: 0n}, {code: "preferred", name: "优选代理", threshold: 100n}]});
runtime.announcements.save(admin, {title: "合作工作台已开放联调", body: "网页下单、工单协作和 API 兑换共用业务记录。请使用模拟资料测试，不要提交真实凭据。", status: "published", audience: "all", merchantIds: [], tierCodes: [], pinned: true, startsAt: new Date(), endsAt: null});
const owner = await runtime.accounts.registerOwner({username: "preview-agent", displayName: "演示代理负责人", merchantId, password: "preview-agent-password-only"});
await runtime.accounts.changePassword(owner, "preview-agent-password-only", "preview-agent-updated-password");
runtime.agents.applyTier(owner, merchantId, "preferred", "希望申请优选代理等级，请审核。", "preview-tier001");
const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
const previewOrder = await runtime.orders.create({merchantId, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId}, {
  merchantOrderNo: "preview-recharge-001", productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00",
});
const paidOrder = runtime.payment.markPaid(merchantId, previewOrder.id, {providerRef: "preview-payment-001", receivedMinor: previewOrder.saleAmountMinor});
const previewFulfillment = runtime.fulfillments.createDirectPublic(paidOrder, {mode: "session", session: "preview-only-session"});
runtime.fulfillments.applyUpstreamEvent(previewFulfillment.id, {orderId: "upstream-preview-9821", lookupToken: null,
  status: "declined", stage: "account_verification_required", accountEmail: "preview@example.com", quotedAmountMinor: 98214,
  chargedAmountMinor: 98214, cardLastFour: "6831", currency: "PHP", message: "该账号需要先完成人机核验"});
const app = await buildApp(config, runtime);
await app.listen({host: "127.0.0.1", port: 3299});
console.log("Local memory-only preview: http://127.0.0.1:3299/workspace");
setTimeout(async () => {await app.close(); runtime.close();}, 15 * 60_000).unref();
