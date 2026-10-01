import type { ProductGrant } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError } from "../domain/errors.js";
import {managedGptProduct} from "./gpt-products.js";

export class CatalogService {
  constructor(private readonly repository: Repository, private readonly requireSupplier = false) {}

  list(merchantId: string): ProductGrant[] {
    return this.listConfigured(merchantId).filter((item) => item.available);
  }

  /** Return the merchant's configured catalogue including temporarily
   * unavailable products, so the workspace can show real cards and status
   * instead of looking like an empty mock-up. Public ordering APIs continue
   * to use list()/requireGrant() and therefore cannot buy unavailable items. */
  listConfigured(merchantId: string): ProductGrant[] {
    return this.repository.listProductGrants(merchantId)
      .filter((item) => item.upstreamProduct === "gpt" && managedGptProduct(item.productCode))
      .map((item) => this.applyMapping(this.configuredGrant(item)));
  }

  requireGrant(merchantId: string, productCode: string): ProductGrant {
    // Retired direct-recharge codes are deliberately not aliased. New orders must
    // name one of the four currently managed CDK-backed products explicitly.
    const grant = this.repository.findProductGrant(merchantId, productCode);
    if (!grant || grant.upstreamProduct !== "gpt" || !managedGptProduct(grant.productCode)) throw new AppError(403, "product_not_authorized", "该商品不在平台四款订阅套餐范围内");
    const mapped = this.applyMapping(this.configuredGrant(grant));
    if (!mapped.available) throw new AppError(409, "product_unavailable", "商品暂不可售", true);
    return mapped;
  }

  resolveGrant(grant: ProductGrant): ProductGrant {
    return this.applyMapping(this.configuredGrant(grant));
  }

  configuredGrant(grant: ProductGrant): ProductGrant {
    const entry = this.repository.getOperations("global_product_catalog", "default")?.products
      .find(product => product.productCode === grant.productCode);
    return entry ? {...grant, name: entry.name, supplyPriceMinor: entry.supplyPriceMinor,
      available: entry.available, priceVersion: entry.priceVersion} : grant;
  }

  availability(value: ProductGrant) {
    const grant = this.configuredGrant(value);
    const mapping = this.repository.findSupplierProductMapping(grant.productCode);
    const connection = mapping ? this.repository.findSupplierConnection(mapping.connectionId) : null;
    const plans = mapping ? this.repository.listSupplierPlanSnapshots(mapping.connectionId) : [];
    const plan = plans.find(item => item.product === mapping?.supplierProduct && item.plan === mapping?.supplierPlan);
    const catalogRequired = this.requireSupplier || Boolean(connection?.lastPlanSyncAt) || plans.length > 0;
    const blockers: Array<{code: string; message: string}> = [];
    if (!grant.available) blockers.push({code: "unpublished", message: "平台已下架"});
    if (grant.supplyPriceMinor <= 0n) blockers.push({code: "price_missing", message: "尚未设置提货价"});
    if (!mapping && this.requireSupplier) blockers.push({code: "mapping_missing", message: "尚未配置上游映射"});
    if (mapping && !mapping.enabled) blockers.push({code: "mapping_disabled", message: "上游映射未启用"});
    if (mapping && this.requireSupplier && !connection?.enabled) blockers.push({code: "connection_disabled", message: "供应连接未启用"});
    if (mapping && catalogRequired && !plan) blockers.push({code: "plan_missing", message: "未同步到映射套餐，请同步上游套餐"});
    else if (mapping && catalogRequired && (!plan?.enabled || !plan.purchasable)) blockers.push({code: "plan_unavailable", message: "上游套餐暂不可售"});
    return {available: blockers.length === 0, configuredAvailable: grant.available,
      unavailableReason: blockers.map(item => item.message).join("；") || null, blockers,
      supplierPlan: mapping?.supplierPlan ?? null, mappingEnabled: mapping?.enabled ?? false,
      mappingVersion: mapping?.version ?? null, lastPlanSyncAt: connection?.lastPlanSyncAt?.toISOString() ?? null};
  }

  private applyMapping(grant: ProductGrant): ProductGrant {
    const mapping = this.repository.findSupplierProductMapping(grant.productCode);
    const mapped = !mapping ? this.requireSupplier ? {...grant, available: false} : grant : (() => {
      const connection = this.repository.findSupplierConnection(mapping.connectionId);
      const snapshots = this.repository.listSupplierPlanSnapshots(mapping.connectionId);
      const plan = snapshots.find((item) => item.product === mapping.supplierProduct && item.plan === mapping.supplierPlan);
      const catalogRequired = this.requireSupplier || Boolean(connection?.lastPlanSyncAt) || snapshots.length > 0;
      const sellable = (!this.requireSupplier || Boolean(connection?.enabled)) && (!catalogRequired || Boolean(plan?.enabled && plan.purchasable));
      return {
        ...grant,
        available: grant.available && mapping.enabled && sellable,
        fulfillmentMode: mapping.fulfillmentMode,
        upstreamProduct: mapping.supplierProduct,
        upstreamPlan: mapping.supplierPlan,
      };
    })();
    return {...mapped, available: this.availability(grant).available};
  }
}
