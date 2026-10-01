import {readFileSync} from "node:fs";
import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";
import type {Actor} from "../operations/model.js";

const [partnerId, merchantName, username, displayName] = process.argv.slice(2);
const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!partnerId || !merchantName || !username || !displayName || !password) {
  console.error("用法：通过标准输入提供临时密码，并传入 partner_id、代理商名称、账号、显示名称");
  process.exit(1);
}

const config = loadConfig();
if (config.nodeEnv !== "production" || config.executionMode !== "production" || config.storageDriver !== "sqlite") {
  console.error("该命令只允许在 SQLite 生产运行时创建受限体验账号");
  process.exit(1);
}

const runtime = createRuntime(config);
const actor: Actor = {id: "production-provisioning", role: "platform_admin", merchantId: null};
try {
  const normalizedUsername = username.toLowerCase().trim();
  if (runtime.repository.findMerchantByPartner(partnerId.toLowerCase().trim())) throw new Error("partner_id 已存在");
  if (runtime.repository.listOperations("account").some(account => account.username === normalizedUsername)) throw new Error("账号已存在");
  const {merchant} = runtime.agents.create(actor, {partnerId, name: merchantName});
  const account = await runtime.accounts.create(actor, {
    username: normalizedUsername,
    displayName,
    role: "agent_owner",
    merchantId: merchant.id,
    password,
  });
  console.log(JSON.stringify({
    username: account.username,
    merchantId: merchant.id,
    role: account.role,
    mustChangePassword: account.mustChangePassword,
    procurementBalance: "0.00",
    apiAccess: "disabled",
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "体验账号创建失败");
  process.exitCode = 1;
} finally {
  runtime.close();
}
