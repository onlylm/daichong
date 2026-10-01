// Run once in a root-owned container with the new deployment mounted at /deployment.
// Secrets are generated on the server and are never printed.
import {randomBytes} from "node:crypto";
import {mkdirSync, writeFileSync, existsSync, chmodSync, chownSync} from "node:fs";

const base = "/deployment";
if (!existsSync(base)) throw new Error("deployment_mount_missing");
if (existsSync(base + "/config/prelaunch.env")) throw new Error("existing_configuration_preserved");
for (const dir of ["config", "secrets", "state", "backups"]) {
  mkdirSync(base + "/" + dir, {recursive: true, mode: 0o700});
  chmodSync(base + "/" + dir, 0o700);
}
const secret = () => randomBytes(32).toString("base64url");
const values = {
  NODE_ENV: "development", HOST: "0.0.0.0", PORT: "3200", LOG_LEVEL: "info", TRUST_PROXY: "false",
  ENABLE_SANDBOX_ROUTES: "false", SANDBOX_ADMIN_TOKEN: secret(), PLATFORM_ADMIN_TOKEN: secret(),
  DEMO_PARTNER_ID: "pt_prelaunch_preview", DEMO_KEY_ID: "key_prelaunch_preview",
  DEMO_CLIENT_SECRET: secret(), DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  KEY_ENCRYPTION_KEY_ID: "prelaunch-server-v1", PORTAL_TOKEN_SECRET: secret(),
  PAYMENT_PROVIDER: "mock", FULFILLMENT_PROVIDER: "mock", LIVE_TEST_ENABLED: "false",
  PUBLIC_BASE_URL: "http://127.0.0.1:3401", STORAGE_DRIVER: "sqlite",
  SQLITE_PATH: "/app/data/prelaunch.sqlite",
  DEMO_WEBHOOK_URL: "", DEMO_WEBHOOK_SECRET: secret(),
  ZOVOCARD_API_KEY: "", ZOVOCARD_WEBHOOK_SECRET: "",
  SUPPLIER_ALLOWED_HOSTS: "sandbox.zovocard.com,zovocard.com",
};
writeFileSync(base + "/config/prelaunch.env",
  Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n",
  {mode: 0o600, flag: "wx"});
writeFileSync(base + "/secrets/admin-access.json", JSON.stringify({
  username: "platform_admin", password: secret(), loginUrl: "http://127.0.0.1:3401/workspace",
  createdAt: new Date().toISOString(), note: "仅经 SSH 隧道访问，首次登录必须修改密码。不是服务器 SSH 密码。",
}, null, 2) + "\n", {mode: 0o600, flag: "wx"});
chownSync(base + "/state", 1000, 1000);
console.log("Prelaunch configuration prepared; secrets were not printed.");
