import {randomUUID} from "node:crypto";
import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";
import type {Actor} from "../operations/model.js";

const partnerIds = process.argv.slice(2).map(value => value.toLowerCase().trim()).filter(Boolean);
if (!partnerIds.length) {
  console.error("用法：close-test-agents <partner_id> [partner_id...]");
  process.exit(1);
}

const config = loadConfig();
if (config.nodeEnv !== "production" || config.executionMode !== "production" || config.storageDriver !== "sqlite") {
  console.error("该命令只允许在 SQLite 生产运行时关闭测试代理");
  process.exit(1);
}

const runtime = createRuntime(config);
const actor: Actor = {id: "production-maintenance", role: "platform_admin", merchantId: null};
try {
  runtime.repository.transaction(() => {
    for (const partnerId of partnerIds) {
      const merchant = runtime.repository.findMerchantByPartner(partnerId);
      if (!merchant) throw new Error("代理不存在：" + partnerId);
      if (merchant.status === "closed") {
        console.log(JSON.stringify({partnerId, status: "already_closed", merchantId: merchant.id}));
        continue;
      }
      runtime.repository.saveMerchant({...merchant, status: "closed"});
      for (const account of runtime.repository.listOperations("account").filter(item => item.merchantId === merchant.id && item.status === "active")) {
        runtime.repository.saveOperations("account", {...account, status: "disabled"});
      }
      for (const app of runtime.repository.listApps(merchant.id)) {
        if (app.status === "disabled") continue;
        runtime.repository.saveApp({...app, status: "disabled"});
      }
      const access = runtime.repository.getOperations("api_access", merchant.id);
      if (access?.enabled) {
        runtime.repository.saveOperations("api_access", {...access, enabled: false, version: access.version + 1, updatedAt: new Date()});
      }
      runtime.audit.record({merchantId: merchant.id, actorId: actor.id, actorType: "platform_user", action: "agent.close", targetType: "agent", targetId: merchant.id, requestId: randomUUID()});
      console.log(JSON.stringify({partnerId, status: "closed", merchantId: merchant.id, name: merchant.name}));
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "关闭测试代理失败");
  process.exitCode = 1;
} finally {
  runtime.close();
}
