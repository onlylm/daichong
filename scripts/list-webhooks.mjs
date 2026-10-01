import {loadConfig} from "./dist/config.js";
import {createRuntime} from "./dist/bootstrap.js";

const runtime = createRuntime(loadConfig());
try {
  const rows = runtime.repository.listMerchants().flatMap(m =>
    runtime.repository.listWebhookEndpoints(m.id).map(e => ({
      partnerId: m.partnerId,
      name: m.name,
      merchantId: m.id,
      url: e.url,
      status: e.status,
      hasSecret: Boolean(e.secret),
    })));
  console.log(JSON.stringify(rows, null, 2));
} finally {
  runtime.close();
}
