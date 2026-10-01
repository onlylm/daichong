import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {assertCdkTemplate, createPublicCdkCode, isPublicCdkCode, normalizeCdkPrefix} from "../src/modules/cdk-code.js";
import {loadConfig} from "../src/config.js";
import {minorToMoney} from "../src/domain/money.js";

describe("agent CDK generation", () => {
  let r: Runtime, app: Awaited<ReturnType<typeof buildApp>>;
  const origin = "http://127.0.0.1:3200";

  beforeEach(async () => {
    r = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", REGISTRATION_ENABLED: "true"}));
    app = await buildApp(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}), r);
  });
  afterEach(async () => {await app.close(); r.close();});

  it("formats public codes with a custom prefix", () => {
    expect(createPublicCdkCode("TB")).toMatch(/^TB-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    expect(normalizeCdkPrefix("tb_shop")).toBe("TBSHOP");
  });

  it("supports controlled merchant templates while preserving enough entropy", () => {
    const code = createPublicCdkCode("SHOP", "{PREFIX}_{RANDOM:10}-{RANDOM:10}");
    expect(code).toMatch(/^SHOP_[A-F0-9]{10}-[A-F0-9]{10}$/);
    expect(isPublicCdkCode(code)).toBe(true);
    expect(isPublicCdkCode("QF-ABCDE-12345-67890-ABCDE")).toBe(true);
    expect(() => assertCdkTemplate("{PREFIX}-{RANDOM:8}")).toThrow("随机段总长度不得少于 20 位");
    expect(() => assertCdkTemplate("STATIC-{RANDOM:10}-{RANDOM:10}")).toThrow("必须且只能包含一个 {PREFIX}");
    expect(() => assertCdkTemplate("{PREFIX}/{RANDOM:10}/{RANDOM:10}")).toThrow("仅支持大写字母、数字、横线和下划线");
  });

  it("generates a CDK by deducting procurement balance at supply price", async () => {
    const register = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "cdk_agent@example.com", password: "secure-password-15"}});
    expect(register.statusCode).toBe(200);
    const merchantId = register.json().merchantId as string;
    const cookie = String(register.headers["set-cookie"]).split(";")[0]!;
    const csrf = register.json().csrf as string;
    const profile = r.agents.profile(merchantId);
    r.repository.saveOperations("agent_profile", {...profile, cdkCodePrefix: "LIVE",
      cdkCodeTemplate: "{PREFIX}_{RANDOM:10}-{RANDOM:10}", version: profile.version + 1, updatedAt: new Date()});
    const supplyMinor = r.catalog.requireGrant(merchantId, "chatgpt_plus_cdk_1m").supplyPriceMinor;
    r.repository.saveOperations("wallet_entry", {id: "seed", merchantId, kind: "deposit", procurementDelta: supplyMinor + 10_000n,
      earningsDelta: 0n, frozenDelta: 0n, reference: "seed", actorId: "test", createdAt: new Date()});
    const before = r.repository.listOperations("wallet_entry", merchantId).reduce((sum, e) => sum + e.procurementDelta, 0n);
    const generated = await app.inject({method: "POST", url: "/workspace/api/cdks", headers: {cookie, origin, "x-csrf-token": csrf},
      payload: {productCode: "chatgpt_plus_cdk_1m", merchantOrderNo: "cdk-generate-001"}});
    expect(generated.statusCode).toBe(202);
    const body = generated.json().data;
    expect(body).toMatchObject({voucherCode: null, issuanceStatus: "issuing"});
    const issued = await r.cdk.issueOne();
    expect(issued?.publicCode).toMatch(/^LIVE_[A-F0-9]{10}-[A-F0-9]{10}$/);
    expect(body.supplyPrice).toBe(minorToMoney(supplyMinor));
    const after = r.repository.listOperations("wallet_entry", merchantId).reduce((sum, e) => sum + e.procurementDelta, 0n);
    expect(before - after).toBe(supplyMinor);
  });

  it("lets agent owners customize their CDK prefix and controlled format", async () => {
    const register = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "prefix_agent@example.com", password: "secure-password-15"}});
    const merchantId = register.json().merchantId as string;
    const cookie = String(register.headers["set-cookie"]).split(";")[0]!;
    const csrf = register.json().csrf as string;
    const profile = r.agents.profile(merchantId);
    const updated = await app.inject({method: "PATCH", url: `/workspace/api/agents/${merchantId}/cdk-settings`,
      headers: {cookie, origin, "x-csrf-token": csrf}, payload: {cdkCodePrefix: "MYBRAND",
        cdkCodeTemplate: "{PREFIX}_{RANDOM:10}-{RANDOM:10}", version: profile.version}});
    expect(updated.statusCode).toBe(200);
    expect(r.agents.profile(merchantId)).toMatchObject({cdkCodePrefix: "MYBRAND", cdkCodeTemplate: "{PREFIX}_{RANDOM:10}-{RANDOM:10}"});
  });
});
