import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {activateInitialAgentCatalog} from "../src/operations/agents.js";
import {newProductGrant} from "../src/modules/gpt-products.js";
import {managedGptProducts} from "../src/modules/gpt-products.js";
import {loadConfig} from "../src/config.js";
import {defaultTierLevels} from "../src/operations/tier-benefits.js";

describe("agent registration and membership", () => {
  let r: Runtime, app: Awaited<ReturnType<typeof buildApp>>;
  const origin = "http://127.0.0.1:3200";
  beforeEach(async () => {
    r = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", REGISTRATION_ENABLED: "true"}));
    app = await buildApp(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}), r);
  });
  afterEach(async () => {await app.close(); r.close();});

  it("registers a merchant owner and logs in automatically", async () => {
    const response = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "agent_zhang@example.com", password: "secure-password-15"}});
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toMatchObject({username: "agent_zhang@example.com", role: "agent_owner"});
    expect(body.permissions).toContain("tiers.read");
    expect(response.headers["set-cookie"]).toContain("quefa_account=");
    const merchantId = body.merchantId;
    expect(r.agents.profile(merchantId)).toMatchObject({
      tier: "standard",
      collectionModes: ["platform_collect", "agent_collect"],
      customRedemptionEnabled: true,
    });
    expect(r.repository.findMerchantByPartner("agent_zhang")?.name).toBe("agent_zhang");
    const enabled = r.repository.listProductGrants(merchantId).filter(product => product.available).map(product => product.productCode);
    expect(enabled).toEqual(expect.arrayContaining(managedGptProducts.map(product => product.productCode)));
    expect(enabled).not.toContain("chatgpt_go_cdk_1m");
  });

  it("rejects duplicate email registrations", async () => {
    const payload = {email: "agent_dup@example.com", password: "secure-password-15"};
    expect((await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin}, payload})).statusCode).toBe(200);
    expect((await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin}, payload})).statusCode).toBe(409);
  });

  it("accepts an 8-character password and rejects shorter passwords", async () => {
    const ok = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "short_ok@example.com", password: "12345678"}});
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({method: "POST", url: "/workspace/api/auth/register", headers: {origin},
      payload: {email: "short_bad@example.com", password: "1234567"}});
    expect(bad.statusCode).toBe(400);
  });

  it("uses flat grant prices without tier discounts", () => {
    const merchantId = r.repository.findMerchantByPartner("pt_demo_a")!.id;
    r.repository.saveOperations("agent_profile", {...r.agents.profile(merchantId), tier: "preferred", version: 1});
    const grant = r.repository.findProductGrant(merchantId, "chatgpt_plus_cdk_1m")!;
    expect(grant.supplyPriceMinor).toBe(11_000n);
    expect(r.repository.findProductGrant(merchantId, "chatgpt_plus_cdk_1m")?.supplyPriceMinor).toBe(11_000n);
    expect(r.repository.findProductGrant(merchantId, "chatgpt_pro_5x_cdk_1m")?.supplyPriceMinor).toBe(63_800n);
    expect(r.repository.findProductGrant(merchantId, "chatgpt_pro_20x_cdk_1m")?.supplyPriceMinor).toBe(100_000n);
  });

  it("activates legacy unavailable grants on startup migration", () => {
    const merchantId = "legacy-merchant";
    r.repository.saveMerchant({id: merchantId, partnerId: "pt_legacy", name: "存量代理", status: "active"});
    const pro = managedGptProducts.find(p => p.productCode === "chatgpt_pro_5x_cdk_1m")!;
    r.repository.saveProductGrant({...newProductGrant(merchantId, pro, false), available: false, priceVersion: 1});
    r.repository.saveProductGrant({...newProductGrant(merchantId, managedGptProducts.find(p => p.productCode === "chatgpt_plus_cdk_1m")!, true), available: true, priceVersion: 2});
    activateInitialAgentCatalog(r.repository);
    const grant = r.repository.findProductGrant(merchantId, "chatgpt_pro_5x_cdk_1m")!;
    expect(grant.available).toBe(true);
    expect(grant.priceVersion).toBe(1);
  });

  it("seeds default tier rules with benefits", () => {
    const rules = r.agents.rules();
    expect(rules.enabled).toBe(true);
    expect(rules.levels.map(level => level.code)).toEqual(["standard", "preferred", "gold"]);
    expect(rules.levels.find(level => level.code === "gold")?.apiIncluded).toBe(true);
    expect(rules.levels.find(level => level.code === "standard")?.productSupplyPrices?.chatgpt_plus_cdk_1m).toBe("11000");
    expect(rules.levels.find(level => level.code === "gold")?.productSupplyPrices?.chatgpt_plus_cdk_1m).toBe("11000");
    expect(rules.levels.find(level => level.code === "preferred")?.threshold).toBe(10_000_000n);
    expect(rules.levels.find(level => level.code === "gold")?.threshold).toBe(50_000_000n);
    expect(rules.levels.find(level => level.code === "preferred")?.minDepositMinor).toBe("300000");
    expect(rules.levels.find(level => level.code === "standard")?.collectionModes).toContain("agent_collect");
  });
});
