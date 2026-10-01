import {loadConfig} from "./dist/config.js";
import {createRuntime} from "./dist/bootstrap.js";

const runtime = createRuntime(loadConfig());
try {
  for (const merchant of runtime.repository.listMerchants()) {
    const accounts = runtime.repository.listOperations("account").filter(a => a.merchantId === merchant.id);
    console.log([merchant.partnerId, merchant.name, merchant.status, accounts.map(a => a.username).join(",")].join("\t"));
  }
} finally {
  runtime.close();
}
