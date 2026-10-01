import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";

describe("open platform recovery documentation", () => {
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
  });
  afterEach(async () => {await app.close(); runtime.close();});

  it("shows partner progress and recovery in the public developer portal", async () => {
    const page = await app.inject({method: "GET", url: "/developers"});
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="progress"');
    expect(page.body).toContain("fulfillment.updated");
    expect(page.body).toContain("fallback_recharge_available");
    expect(page.body).toContain("代理无主动取消权限");
    expect(page.body).toContain("开放 API 是代理工作台之外的可选接入方式");
    expect(page.body).toContain("工作台与 API 并存");
    expect(page.body).toContain("零采购余额也可使用");
    expect(page.body).not.toContain("API 审核");
    expect(page.body).not.toContain("提交用途，审核通过后创建应用密钥");
    expect(page.body).not.toContain("普通商城优先跳转");
  });

  it("serves integration examples and brand-page rules in the actual public document routes", async () => {
    for (const path of ["/developers/doc/integration", "/developers/integration.md"]) {
      const page = await app.inject({method: "GET", url: path});
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("可直接据此对接的进度和重提示例");
      expect(page.body).toContain("evt_example_progress_2");
      expect(page.body).toContain("recharge:SHOP-20260930-0001:attempt-2");
      expect(page.body).toContain("procurement.refunded");
      expect(page.body).toContain("开发不是使用平台的前置条件");
      expect(page.body).toContain("两种入口共用同一代理账号");
      expect(page.body).not.toContain("平台只提供后端 API");
      expect(page.body).not.toContain("recharge/resolve");
    }
    const guide = await app.inject({method: "GET", url: "/developers/doc/redemption"});
    expect(guide.statusCode).toBe(200);
    expect(guide.body).toContain("按示例实现重提和取消后的反馈");
    expect(guide.body).toContain("自己的品牌页");
    expect(guide.body).toContain("不开发网站的代理商可以直接使用 Quefa 代理工作台");
  });
});
