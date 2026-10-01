import {randomBytes} from "node:crypto";
import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";

const username = process.argv[2]?.toLowerCase().trim();
const password = process.env.QUEFA_RESET_PASSWORD ?? randomBytes(12).toString("base64url");
if (!username) {
  console.error("用法：node dist/cli/reset-account-password.js <账号>（可选 QUEFA_RESET_PASSWORD=新密码）");
  process.exit(1);
}
const config = loadConfig();
if (config.storageDriver !== "sqlite") throw new Error("密码重置必须使用持久化 SQLite");
const runtime = createRuntime(config);
try {
  const account = runtime.repository.listOperations("account").find(item => item.username === username);
  if (!account) {
    console.error("账号不存在：" + username);
    process.exit(1);
  }
  const passwordHash = await runtime.accounts.hashPassword(password);
  runtime.repository.transaction(() => {
    const current = runtime.repository.getOperations("account", account.id)!;
    runtime.repository.saveOperations("account", {
      ...current,
      passwordHash,
      mustChangePassword: false,
      authVersion: current.authVersion + 1,
      failedLogins: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    });
  });
  console.log(JSON.stringify({
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    merchantId: account.merchantId,
    password,
  }));
} finally {
  runtime.close();
}
