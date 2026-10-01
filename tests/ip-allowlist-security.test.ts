import {randomUUID} from "node:crypto";
import {afterEach, describe, expect, it} from "vitest";
import type {FastifyInstance} from "fastify";
import {buildApp} from "../src/app.js";
import {signRequest} from "../src/auth/signature.js";
import {ipAllowed, normalizeIpRules} from "../src/auth/ip.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig, type AppConfig} from "../src/config.js";
import type {Actor} from "../src/operations/model.js";

describe("partner IP allowlist security", () => {
  const resources: Array<{app: FastifyInstance; close: () => void}> = [];
  afterEach(async () => {
    for (const item of resources.splice(0)) {
      await item.app.close();
      item.close();
    }
  });

  async function setup(config: AppConfig) {
    const runtime = createRuntime(config);
    const app = await buildApp(config, runtime);
    resources.push({app, close: () => runtime.close()});
    const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
    const owner: Actor = {id: "owner", role: "agent_owner", merchantId: merchant.id};
    const partnerApp = runtime.apiAccess.summary(owner, merchant.id).apps.find(item => item.appId === "app_demo_a")!;
    return {app, runtime, owner, merchant, partnerApp};
  }

  function signedProducts(app: FastifyInstance, config: AppConfig, remoteAddress: string, forwardedFor?: string) {
    const method = "GET", path = "/v1/products", timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    return app.inject({method, url: path, remoteAddress, headers: {
      "x-partner-id": config.demoPartnerId,
      "x-key-id": config.demoKeyId,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-signature": signRequest({method, path, rawQuery: "", timestamp, nonce, keyId: config.demoKeyId,
        idempotencyKey: "", rawBody: Buffer.alloc(0)}, config.demoClientSecret),
      ...(forwardedFor ? {"x-forwarded-for": forwardedFor} : {}),
    }});
  }

  it("only accepts a forwarded client address from an explicitly trusted proxy", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", TRUST_PROXY: "true",
      TRUSTED_PROXY_CIDRS: "192.0.2.0/24"});
    const {app, runtime, owner, merchant, partnerApp} = await setup(config);
    runtime.apiAccess.configureIpAllowlist(owner, merchant.id, partnerApp.id, true, ["203.0.113.8"], partnerApp.configVersion);

    const forged = await signedProducts(app, config, "198.51.100.20", "203.0.113.8");
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.code).toBe("ip_not_allowed");

    const proxied = await signedProducts(app, config, "192.0.2.20", "203.0.113.8");
    expect(proxied.statusCode).toBe(200);
  });

  it("fails closed if an enabled record is damaged and loses all rules", async () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
    const {app, runtime, owner, merchant, partnerApp} = await setup(config);
    const stored = runtime.repository.listApps(merchant.id).find(item => item.id === partnerApp.id)!;
    runtime.repository.saveApp({...stored, ipAllowlistEnabled: true, allowedIps: []});
    const response = await signedProducts(app, config, "203.0.113.8");
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ip_not_allowed");
  });

  it("normalizes mapped IPv4 addresses and rejects allow-all or mapped CIDR rules", () => {
    expect(ipAllowed("::ffff:203.0.113.8", ["203.0.113.8"])).toBe(true);
    expect(normalizeIpRules(["::ffff:203.0.113.8", "203.0.113.8"])).toEqual(["203.0.113.8"]);
    expect(() => normalizeIpRules(["0.0.0.0/0"])).toThrow("invalid_ip_rule");
    expect(() => normalizeIpRules(["::/0"])).toThrow("invalid_ip_rule");
    expect(() => normalizeIpRules(["::ffff:192.0.2.0/120"])).toThrow("invalid_ip_rule");
  });
});
