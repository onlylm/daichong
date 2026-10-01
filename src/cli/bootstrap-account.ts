import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";

const username = process.argv[2];
const password = process.env.QUEFA_BOOTSTRAP_PASSWORD;
if (!username || !password) {
  console.error("请通过临时环境变量 QUEFA_BOOTSTRAP_PASSWORD 提供初始密码，并传入管理员账号名。不要把密码写入命令参数或源码。");
  process.exit(1);
}
const config = loadConfig();
if (config.storageDriver !== "sqlite") throw new Error("账号初始化必须使用持久化 SQLite");
const runtime = createRuntime(config);
try {
  const account = await runtime.accounts.bootstrap(username, password);
  console.log("管理员已创建：" + account.username + "；请访问 /workspace 登录。未输出密码。");
} catch {
  console.error("初始化失败：请检查密码长度、账号格式，或是否已有管理员。");
  process.exitCode = 1;
} finally {runtime.close();}
