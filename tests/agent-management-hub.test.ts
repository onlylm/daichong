import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("agent management hub", () => {
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const origin = "https://admin.tibo.ink";

  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
      PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: origin});
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
    await runtime.accounts.bootstrap("hub-admin", "test-agent-hub-password");
  });

  afterEach(async () => {await app.close(); runtime.close();});

  it("lets the platform administrator create and manage an account inside one agent scope", async () => {
    const logged = await loginPlatform(app, "hub-admin", "test-agent-hub-password", origin);
    const headers = {origin, cookie: String(logged.headers["set-cookie"]).split(";")[0]!,
      "x-csrf-token": logged.json().csrf};
    const merchant = runtime.repository.findMerchantByPartner("pt_demo_a")!;

    const created = await app.inject({method: "POST", url: "/workspace/api/accounts", headers,
      payload: {username: "agent.finance@example.com", displayName: "代理财务", role: "agent_finance",
        merchantId: merchant.id, password: "agent-finance-password"}});
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toMatchObject({merchantId: merchant.id, role: "agent_finance", mustChangePassword: true});

    const accounts = await app.inject({method: "GET", url: `/workspace/api/agents/${merchant.id}/accounts`, headers});
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({username: "agent.finance@example.com", merchantId: merchant.id}),
    ]));

    const activity = await app.inject({method: "GET", url: `/workspace/api/agents/${merchant.id}/activity`, headers});
    expect(activity.statusCode).toBe(200);
    expect(activity.json().data[0]).toMatchObject({merchantId: merchant.id, action: "account.create"});
  });
});
