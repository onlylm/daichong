import type {Repository} from "../infra/repository.js";
import {managedGptProducts, managedGptProduct, newProductGrant} from "../modules/gpt-products.js";
import {seedGlobalProductCatalog} from "./global-product-catalog.js";

export const subscriptionPricingRevision = "subscription-pricing-20261001-v2";

/** Explicit, once-only commercial configuration. Never edits existing orders or money records. */
export function applySubscriptionPricing(repository: Repository) {
  return repository.transaction(() => {
    if (repository.getOperations("service_checkpoint", subscriptionPricingRevision)) return {applied: false, revision: subscriptionPricingRevision};
    seedGlobalProductCatalog(repository);
    const catalog = repository.getOperations("global_product_catalog", "default")!;
    const now = new Date();
    const products = catalog.products.map(entry => {
      const template = managedGptProduct(entry.productCode);
      if (!template) return {...entry, available: false, priceVersion: entry.priceVersion + 1};
      return {...entry, supplyPriceMinor: template.supplyPriceMinor, standardCostCnyMinor: template.costPriceMinor,
        refundBenchmarkUsdMinor: template.refundBenchmarkUsdMinor, refundBenchmarkAt: now.toISOString(), available: true,
        priceVersion: entry.priceVersion + 1};
    });
    repository.saveOperations("global_product_catalog", {...catalog, products, version: catalog.version + 1, updatedAt: now});
    for (const merchant of repository.listMerchants()) {
      for (const grant of repository.listProductGrants(merchant.id)) {
        if (!managedGptProduct(grant.productCode) && grant.available)
          repository.saveProductGrant({...grant, available: false, priceVersion: grant.priceVersion + 1});
      }
      for (const template of managedGptProducts) {
        const entry = products.find(p => p.productCode === template.productCode)!;
        const current = repository.findProductGrant(merchant.id, template.productCode) ?? newProductGrant(merchant.id, template, false);
        repository.saveProductGrant({...current, supplyPriceMinor: entry.supplyPriceMinor, available: entry.available,
          priceVersion: Math.max(current.priceVersion + 1, entry.priceVersion)});
      }
    }
    repository.saveOperations("service_checkpoint", {id: subscriptionPricingRevision, merchantId: null, createdAt: now}, true);
    return {applied: true, revision: subscriptionPricingRevision, products: products.filter(p => managedGptProduct(p.productCode)).map(p => ({
      productCode: p.productCode, supplyPriceMinor: String(p.supplyPriceMinor), platformCostCnyMinor: String(p.standardCostCnyMinor ?? 0n),
      refundBenchmarkUsdMinor: String(p.refundBenchmarkUsdMinor), available: p.available,
    }))};
  });
}
