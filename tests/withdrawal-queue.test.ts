import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";

describe("withdrawal queue", () => {
  let runtime: Runtime, app: Awaited<ReturnType<typeof buildApp>>;
  const origin = "http://127.0.0.1:3200";

  beforeEach(async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", REGISTRATION_ENABLED: "true"});
    runtime = createRuntime(config);
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {await app.close(); runtime.close();});

  it("creates a finance withdrawal record without creating a support ticket", async () => {
    const registered = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "withdrawal_agent@example.com", password: "secure-password-15"}});
    expect(registered.statusCode).toBe(200);
    const merchantId = registered.json().merchantId as string;
    const cookie = String(registered.headers["set-cookie"]).split(";")[0]!;
    const csrf = registered.json().csrf as string;
    runtime.repository.saveOperations("wallet_entry", {id: "withdrawal-earnings-seed", merchantId, kind: "earning_release",
      procurementDelta: 0n, earningsDelta: 1_000n, frozenDelta: 0n, reference: "seed-order", actorId: "test", createdAt: new Date()});

    const response = await app.inject({method: "POST", url: `/workspace/api/wallets/${merchantId}/withdrawals`,
      headers: {cookie, origin, "x-csrf-token": csrf}, payload: {amount: "5.00", requestKey: "withdrawal-request-001",
        payoutMethod: "alipay", payoutAccount: "agent@example.com", payoutName: "测试代理"}});

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({merchantId, status: "requested", requestKey: "withdrawal-request-001"});
    expect(response.json()).not.toHaveProperty("ticketId");
    expect(runtime.repository.listOperations("wallet_withdrawal", merchantId)).toHaveLength(1);
    expect(runtime.repository.listOperations("ticket", merchantId)).toHaveLength(0);
  });
});
