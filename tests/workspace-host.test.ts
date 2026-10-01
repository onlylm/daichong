import {describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";

describe("workspace host separation", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    STORAGE_DRIVER: "memory",
    LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink",
    ADMIN_BASE_URL: "https://admin.tibo.ink",
    REGISTRATION_ENABLED: "true",
  });

  it("routes platform admins to admin host and agents to partner host", async () => {
    const r = createRuntime(config);
    const app = await buildApp(config, r);
    try {
      await r.accounts.bootstrap("platform-admin", "platform-admin-password");
      const merchantId = r.repository.findMerchantByPartner("pt_demo_a")!.id;
      await r.accounts.registerOwner({
        username: "agent@example.com",
        displayName: "测试代理",
        merchantId,
        password: "agent-password-15chars",
      });

      const agentOnAdmin = await app.inject({
        method: "POST",
        url: "/workspace/api/auth/login",
        headers: {origin: "https://admin.tibo.ink"},
        payload: {username: "agent@example.com", password: "agent-password-15chars"},
      });
      expect(agentOnAdmin.statusCode).toBe(403);
      expect(agentOnAdmin.json().error.code).toBe("partner_workspace_required");

      const agentOnPartner = await app.inject({
        method: "POST",
        url: "/workspace/api/auth/login",
        headers: {origin: "https://tibo.ink"},
        payload: {username: "agent@example.com", password: "agent-password-15chars"},
      });
      expect(agentOnPartner.statusCode).toBe(200);
      expect(agentOnPartner.headers["set-cookie"]).toContain("quefa_account=");

      const platformOnPartner = await app.inject({
        method: "POST",
        url: "/workspace/api/auth/login",
        headers: {origin: "https://tibo.ink"},
        payload: {username: "platform-admin", password: "platform-admin-password"},
      });
      expect(platformOnPartner.statusCode).toBe(403);
      expect(platformOnPartner.json().error.code).toBe("admin_workspace_required");

      const platformLogin = await loginPlatform(app, "platform-admin", "platform-admin-password", "https://admin.tibo.ink");
      expect(platformLogin.statusCode).toBe(200);

      const registerOnAdmin = await app.inject({
        method: "POST",
        url: "/workspace/api/auth/register",
        headers: {origin: "https://admin.tibo.ink"},
        payload: {email: "new-agent@example.com", password: "secure-password-15"},
      });
      expect(registerOnAdmin.statusCode).toBe(403);
      expect(registerOnAdmin.json().error.code).toBe("partner_workspace_required");

      const registerOnPartner = await app.inject({
        method: "POST",
        url: "/workspace/api/auth/register",
        headers: {origin: "https://tibo.ink"},
        payload: {email: "new-agent@example.com", password: "secure-password-15"},
      });
      expect(registerOnPartner.statusCode).toBe(200);
    } finally {
      await app.close();
      r.close();
    }
  });
});
