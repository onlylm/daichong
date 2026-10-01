import type {CatalogService} from "../modules/catalog-service.js";
import type {Repository} from "../infra/repository.js";
import type {GlobalProductCatalog, GlobalProductEntry} from "./model.js";
import type {ProductGrant} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import {UNBOUNDED_MAX_SALE_PRICE_MINOR, minorToMoney} from "../domain/money.js";
import {managedGptProduct, managedGptProducts, newProductGrant} from "../modules/gpt-products.js";

export function seedGlobalProductCatalog(repository: Repository): void {
  const existing = repository.getOperations("global_product_catalog", "default");
  const retired = existing?.products.some(entry => entry.available && !managedGptProduct(entry.productCode));
  const missing = managedGptProducts.filter(product => !existing?.products.some(entry => entry.productCode === product.productCode));
  if (existing && missing.length === 0 && !retired) return;
  const products: GlobalProductEntry[] = missing.map(product => ({
    productCode: product.productCode,
    name: product.name,
    supplyPriceMinor: product.supplyPriceMinor,
    refundBenchmarkUsdMinor: product.refundBenchmarkUsdMinor,
    refundBenchmarkAt: "2026-09-30T00:00:00.000Z",
    standardCostCnyMinor: product.costPriceMinor,
    available: true,
    priceVersion: 1,
  }));
  repository.saveOperations("global_product_catalog", {
    id: "default",
    merchantId: null,
    version: (existing?.version ?? 0) + 1,
    products: [...(existing?.products ?? []).map(entry => entry.available && !managedGptProduct(entry.productCode)
      ? {...entry, available: false, priceVersion: entry.priceVersion + 1} : entry), ...products],
    updatedAt: new Date(),
  });
}

function requireGlobalCatalog(repository: Repository): GlobalProductCatalog {
  seedGlobalProductCatalog(repository);
  const catalog = repository.getOperations("global_product_catalog", "default");
  if (!catalog) throw new AppError(500, "global_catalog_missing", "全局商品库未初始化");
  return catalog;
}

function entryToGrant(entry: GlobalProductEntry): ProductGrant {
  const template = managedGptProduct(entry.productCode);
  if (!template) throw new AppError(404, "product_not_found", "商品不存在");
  return {
    merchantId: "__global__",
    productCode: entry.productCode,
    name: entry.name,
    supplyPriceMinor: entry.supplyPriceMinor,
    maxSalePriceMinor: UNBOUNDED_MAX_SALE_PRICE_MINOR,
    currency: "CNY",
    maxQuantity: 1,
    available: entry.available,
    priceVersion: entry.priceVersion,
    fulfillmentMode: template.fulfillmentMode,
    upstreamProduct: "gpt",
    upstreamPlan: template.upstreamPlan,
  };
}

export function listGlobalWorkspaceProducts(repository: Repository, catalog: CatalogService) {
  const global = requireGlobalCatalog(repository);
  return global.products
    .filter(entry => managedGptProduct(entry.productCode))
    .map(entry => {
      const mapped = catalog.resolveGrant(entryToGrant(entry));
      const mapping = repository.findSupplierProductMapping(entry.productCode);
      const quote = mapping ? repository.listSupplierPlanSnapshots(mapping.connectionId).find(p => p.plan === mapping.supplierPlan && p.product === "gpt") : null;
      return {
        code: entry.productCode,
        name: entry.name,
        mode: mapped.fulfillmentMode,
        deliveryModes: mapped.fulfillmentMode === "cdk" ? ["auto_recharge", "cdk"] : ["auto_recharge"],
        supplyPrice: minorToMoney(entry.supplyPriceMinor),
        listSupplyPrice: minorToMoney(entry.supplyPriceMinor),
        tierDiscountBps: 0,
        maxSalePrice: minorToMoney(mapped.maxSalePriceMinor),
        ...catalog.availability(entryToGrant(entry)),
        priceVersion: entry.priceVersion,
        refundBenchmarkUsd: entry.refundBenchmarkUsdMinor == null ? null : minorToMoney(entry.refundBenchmarkUsdMinor),
        refundBenchmarkAt: entry.refundBenchmarkAt ?? null,
        // Backwards-compatible API alias only. This value is not an actual cost.
        standardCostUsd: entry.refundBenchmarkUsdMinor == null ? null : minorToMoney(entry.refundBenchmarkUsdMinor),
        standardCostCny: entry.standardCostCnyMinor == null ? null : minorToMoney(entry.standardCostCnyMinor),
        platformCostCny: minorToMoney(entry.standardCostCnyMinor ?? managedGptProduct(entry.productCode)!.costPriceMinor),
        platformProfitCny: minorToMoney(entry.supplyPriceMinor - (entry.standardCostCnyMinor ?? managedGptProduct(entry.productCode)!.costPriceMinor)),
        retainedFeeUsd: minorToMoney(entry.retainedFeeUsdMinor ?? 15n),
        upstreamQuote: {currency: quote?.checkoutCurrency ?? null, amountMinor: quote?.checkoutAmountMinor ?? null,
          usd: quote?.quoteUsdMinor == null ? null : minorToMoney(BigInt(quote.quoteUsdMinor)),
          serviceFeeUsd: quote?.serviceFeeUsdMinor == null ? null : minorToMoney(BigInt(quote.serviceFeeUsdMinor)),
          version: quote?.pricingVersion ?? null, syncedAt: quote?.syncedAt ?? null,
          usdStatus: quote?.quoteUsdMinor == null ? "upstream_usd_quote_missing" : "available"},
      };
    });
}

export function saveGlobalWorkspaceProduct(
  repository: Repository,
  productCode: string,
  input: {name: string; supplyPriceMinor: bigint; available: boolean; priceVersion: number; refundBenchmarkUsdMinor?: bigint | null; standardCostUsdMinor?: bigint | null; standardCostCnyMinor?: bigint | null; retainedFeeUsdMinor?: bigint},
  catalog?: CatalogService,
): GlobalProductEntry {
  const template = managedGptProduct(productCode);
  if (!template) throw new AppError(404, "product_not_found", "商品不存在");
  if (input.supplyPriceMinor < 0n || (input.available && input.supplyPriceMinor === 0n)) throw new AppError(422, "product_price_invalid", "上架商品的提货价必须大于零；未定价商品可保存为下架");
  if (input.standardCostCnyMinor !== undefined && input.standardCostCnyMinor !== null && input.standardCostCnyMinor < 0n)
    throw new AppError(422, "product_cost_invalid", "我方核算成本不能小于零");
  return repository.transaction(() => {
    const global = requireGlobalCatalog(repository);
    const index = global.products.findIndex(entry => entry.productCode === productCode);
    if (index < 0) throw new AppError(404, "product_not_found", "商品不存在");
    const current = global.products[index]!;
    if (current.priceVersion !== input.priceVersion) {
      throw new AppError(409, "product_price_changed", "商品价格已被其他管理员更新，请刷新后重试");
    }
    const updatedEntry: GlobalProductEntry = {
      ...current,
      productCode,
      name: input.name,
      supplyPriceMinor: input.supplyPriceMinor,
      available: input.available,
      priceVersion: current.priceVersion + 1,
      ...(input.refundBenchmarkUsdMinor !== undefined ? {refundBenchmarkUsdMinor: input.refundBenchmarkUsdMinor, refundBenchmarkAt: new Date().toISOString()} : {}),
      ...(input.standardCostUsdMinor !== undefined ? {standardCostUsdMinor: input.standardCostUsdMinor} : {}),
      ...(input.standardCostCnyMinor !== undefined ? {standardCostCnyMinor: input.standardCostCnyMinor} : {}),
      ...(input.retainedFeeUsdMinor !== undefined ? {retainedFeeUsdMinor: input.retainedFeeUsdMinor} : {}),
    };
    // Publishing requires a ready supply route; saving a draft never does.
    if (input.available && !current.available && catalog) {
      const ready = catalog.availability({...entryToGrant(updatedEntry), merchantId: "__publishing__"});
      const blockers = ready.blockers.filter(item => !["unpublished", "price_missing"].includes(item.code));
      if (blockers.length) throw new AppError(409, "product_publish_blocked", blockers.map(item => item.message).join("；"));
    }
    const nextProducts = [...global.products];
    nextProducts[index] = updatedEntry;
    repository.saveOperations("global_product_catalog", {
      ...global,
      version: global.version + 1,
      products: nextProducts,
      updatedAt: new Date(),
    });
    for (const merchant of repository.listMerchants()) {
      const existing = repository.findProductGrant(merchant.id, productCode);
      const grant = existing ?? newProductGrant(merchant.id, template, false);
      repository.saveProductGrant({
        ...grant,
        name: updatedEntry.name,
        supplyPriceMinor: updatedEntry.supplyPriceMinor,
        maxSalePriceMinor: UNBOUNDED_MAX_SALE_PRICE_MINOR,
        available: updatedEntry.available,
        priceVersion: Math.max(grant.priceVersion + 1, updatedEntry.priceVersion),
        fulfillmentMode: template.fulfillmentMode,
        upstreamProduct: "gpt",
        upstreamPlan: template.upstreamPlan,
      });
    }
    return updatedEntry;
  });
}

export function globalProductGrantsForMerchant(repository: Repository, merchantId: string): ProductGrant[] {
  const global = requireGlobalCatalog(repository);
  return global.products
    .filter(entry => managedGptProduct(entry.productCode))
    .map(entry => {
      const template = managedGptProduct(entry.productCode)!;
      const existing = repository.findProductGrant(merchantId, entry.productCode);
      return {
        ...(existing ?? newProductGrant(merchantId, template, false)),
        name: entry.name,
        supplyPriceMinor: entry.supplyPriceMinor,
        maxSalePriceMinor: UNBOUNDED_MAX_SALE_PRICE_MINOR,
        available: entry.available,
        priceVersion: entry.priceVersion,
        fulfillmentMode: template.fulfillmentMode,
        upstreamProduct: "gpt",
        upstreamPlan: template.upstreamPlan,
      };
    });
}
