import {readFileSync} from "node:fs";
import {randomBytes, randomUUID} from "node:crypto";
import {loadConfig} from "../dist/config.js";
import {createRuntime} from "../dist/bootstrap.js";

const config = loadConfig();
if (config.paymentProvider !== "mock" || config.fulfillmentProvider !== "mock"
    || config.liveTest.enabled || config.enableSandboxRoutes || config.storageDriver !== "sqlite"
    || config.zovocardApiKey || config.zovocardWebhookSecret) throw new Error("unsafe_prelaunch_configuration");
const access = JSON.parse(readFileSync(0, "utf8"));
if (access.username !== "platform_admin" || typeof access.password !== "string" || access.password.length < 24) {
  throw new Error("invalid_initial_account");
}
const runtime = createRuntime(config);
try {
  const oldAdmin = runtime.repository.listOperations("account").find(a => a.username === access.username);
  if (!oldAdmin) {
    const admin = await runtime.accounts.bootstrap(access.username, access.password);
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: true});
  } else if (oldAdmin.role !== "platform_admin" || oldAdmin.merchantId !== null) {
    throw new Error("existing_account_conflict");
  }
  runtime.repository.transaction(() => {
    const demoB = runtime.repository.findCredential("pt_demo_b", "key_demo_b_01");
    if (demoB && demoB.key.status !== "revoked") {
      runtime.repository.saveMerchant({...demoB.merchant, status: "suspended"});
      runtime.repository.saveApp({...demoB.app, status: "disabled"});
      runtime.repository.saveKey({...demoB.key, status: "revoked",
        secret: randomBytes(32).toString("base64url"), expiresAt: new Date()});
      runtime.audit.record({merchantId: demoB.merchant.id, actorId: "deployment",
        actorType: "platform_user", action: "prelaunch.demo.disable",
        targetType: "merchant", targetId: demoB.merchant.id, requestId: randomUUID()});
    }
  });
  console.log("Admin initialized; password change required; built-in public demo credential revoked.");
} finally {runtime.close();}
