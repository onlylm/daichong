import {describe, expect, it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {listGlobalWorkspaceProducts, saveGlobalWorkspaceProduct, seedGlobalProductCatalog} from "../src/operations/global-product-catalog.js";

describe("global product catalog", () => {
  it("lists and updates a global product for all merchants", () => {
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent", PUBLIC_BASE_URL: "https://quefa.test"});
    const runtime = createRuntime(config);
    try {
      const merchantA = runtime.repository.findMerchantByPartner("pt_demo_a")!.id;
      const merchantB = runtime.repository.findMerchantByPartner("pt_demo_b")!.id;
      seedGlobalProductCatalog(runtime.repository);
      const listed = listGlobalWorkspaceProducts(runtime.repository, runtime.catalog);
      expect(listed.some(item => item.code === "chatgpt_plus_cdk_1m")).toBe(true);

      const current = listed.find(item => item.code === "chatgpt_plus_cdk_1m")!;
      saveGlobalWorkspaceProduct(runtime.repository, current.code, {
        name: "ChatGPT Plus 全球版",
        supplyPriceMinor: 10800n,
        available: true,
        priceVersion: current.priceVersion,
      });

      expect(runtime.repository.findProductGrant(merchantA, current.code)).toMatchObject({
        name: "ChatGPT Plus 全球版",
        supplyPriceMinor: 10800n,
        available: true,
        priceVersion: current.priceVersion + 1,
      });
      expect(runtime.repository.findProductGrant(merchantB, current.code)).toMatchObject({
        name: "ChatGPT Plus 全球版",
        supplyPriceMinor: 10800n,
        available: true,
        priceVersion: current.priceVersion + 1,
      });
    } finally {
      runtime.close();
    }
  });
});
