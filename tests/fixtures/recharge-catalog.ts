import type {Runtime} from "../../src/bootstrap.js";
import type {Order} from "../../src/domain/model.js";
import {saveGlobalWorkspaceProduct} from "../../src/operations/global-product-catalog.js";

/** Explicit test publication. Production defaults must stay unpublished. */
export function publishTestRechargeProduct(runtime: Runtime): void {
  if (runtime.upstream.name !== "mock") throw new Error("Test catalogue requires the isolated mock provider");
  const code = "chatgpt_plus_cdk_1m";
  const mapping = runtime.repository.findSupplierProductMapping(code)!;
  runtime.supplierManagement.saveMapping({productCode: code, fulfillmentMode: "cdk", supplierProduct: "gpt",
    supplierPlan: "plus", enabled: true, expectedVersion: mapping.version});
  const entry = runtime.repository.getOperations("global_product_catalog", "default")!.products.find(value => value.productCode === code)!;
  saveGlobalWorkspaceProduct(runtime.repository, code, {name: entry.name, supplyPriceMinor: 11000n,
    available: true, priceVersion: entry.priceVersion}, runtime.catalog);
}

/** Historical direct-order compatibility only; new catalogue products remain CDK-backed. */
export function historicalDirectOrder(runtime: Runtime, order: Order): Order {
  const historical: Order = {...order, fulfillmentMode: "direct"};
  runtime.repository.updateOrder(historical);
  return historical;
}
