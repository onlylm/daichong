import {loadConfig} from "./dist/config.js";
import {createRuntime} from "./dist/bootstrap.js";

const runtime = createRuntime(loadConfig());
try {
  const rows = runtime.repository.listMerchants().map(m => ({
    partnerId: m.partnerId,
    name: m.name,
    status: m.status,
    apps: runtime.repository.listApps(m.id).filter(a => a.appId !== "quefa_web_portal").map(a => a.appId),
    webhooks: runtime.repository.listWebhookEndpoints(m.id).map(e => e.url),
    apiEnabled: Boolean(runtime.repository.getOperations("api_access", m.id)?.enabled),
  }));
  console.log(JSON.stringify(rows, null, 2));
} finally {
  runtime.close();
}
