import {randomBytes, randomUUID} from "node:crypto";
import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";

const [partnerId, name, webhookUrl] = process.argv.slice(2);
if (!partnerId || !name || !webhookUrl) {
  console.error("用法：npm run sandbox:provision -- <partner_id> <代理商名称> <webhook_url>");
  process.exit(1);
}
if (!/^pt_[a-z0-9_-]{3,48}$/.test(partnerId)) {
  console.error("partner_id 必须匹配 pt_[a-z0-9_-]{3,48}");
  process.exit(1);
}
const parsedWebhook = new URL(webhookUrl);
if (!(["https:", "http:"].includes(parsedWebhook.protocol))) {
  console.error("webhook_url 必须使用 HTTP(S)");
  process.exit(1);
}

const config = loadConfig();
if (config.storageDriver !== "sqlite" || !config.enableSandboxRoutes) {
  console.error("该命令只能用于启用了沙箱路由的 SQLite 联调环境");
  process.exit(1);
}

const runtime = createRuntime(config);
try {
  if (runtime.repository.findMerchantByPartner(partnerId)) {
    console.error("partner_id 已存在；请更换 ID，禁止覆盖既有代理商凭证");
    process.exitCode = 1;
  } else {
    const merchant = runtime.merchantService.createMerchant({partnerId, name});
    const suffix = randomBytes(5).toString("hex");
    const app = runtime.merchantService.createApp(merchant.id, {appId: `app_${suffix}`, name: `${name}沙箱服务端`});
    const keyId = `key_${suffix}`;
    const issued = runtime.merchantService.issueKey(merchant.id, app.id, keyId);
    const webhookSecret = randomBytes(32).toString("base64url");
    runtime.repository.saveWebhookEndpoint({
      id: `wh_${randomUUID().replaceAll("-", "")}`,
      merchantId: merchant.id,
      url: webhookUrl,
      secret: webhookSecret,
      subscribedEvents: ["*"],
      status: "active",
    });
    runtime.repository.saveProductGrant({
      merchantId: merchant.id,
      productCode: "chatgpt_plus_1m",
      name: "ChatGPT Plus 月卡",
      supplyPriceMinor: 11_000n,
      maxSalePriceMinor: 15_900n,
      currency: "CNY",
      maxQuantity: 1,
      available: true,
      priceVersion: 1,
      fulfillmentMode: "direct",
      upstreamProduct: "gpt",
      upstreamPlan: "plus",
    });
    runtime.repository.saveProductGrant({
      merchantId: merchant.id,
      productCode: "chatgpt_plus_cdk_1m",
      name: "ChatGPT Plus 月卡兑换码",
      supplyPriceMinor: 11_000n,
      maxSalePriceMinor: 15_900n,
      currency: "CNY",
      maxQuantity: 1,
      available: true,
      priceVersion: 1,
      fulfillmentMode: "cdk",
      upstreamProduct: "gpt",
      upstreamPlan: "plus",
    });
    console.log(JSON.stringify({
      base_url: config.publicBaseUrl,
      partner_id: partnerId,
      app_id: app.appId,
      key_id: keyId,
      client_secret: issued.clientSecret,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      notice: "client_secret 与 webhook_secret 仅显示本次，请立即安全保存",
    }, null, 2));
  }
} finally {
  runtime.close();
}
