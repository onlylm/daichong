import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("platform action center", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    await runtime.accounts.bootstrap("action-admin", "test-action-center-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    await app.close();
    runtime.close();
  });

  it("returns executable operational queues to the platform administrator", async () => {
    const login = await loginPlatform(app, "action-admin", "test-action-center-password", "https://admin.tibo.ink");
    const response = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      counts: {tasks: 0, refunds: 0, settlements: 0, tickets: 0},
      tasks: [], refunds: [], settlements: [], tickets: [],
    });
  });
});
