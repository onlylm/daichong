import {loadConfig} from "../config.js";
import {createRuntime} from "../bootstrap.js";
import {managedGptProducts, newProductGrant} from "../modules/gpt-products.js";
import {SupplierManagementService} from "../modules/supplier-management-service.js";

const config = loadConfig();
if (config.storageDriver !== "sqlite") {
  console.error("该迁移只支持 SQLite 生产数据库");
  process.exit(1);
}

const runtime = createRuntime(config);
try {
  const result = runtime.repository.transaction(() => {
    let disabledGrants = 0;
    let createdGrants = 0;
    let disabledMappings = 0;

    for (const merchant of runtime.repository.listMerchants()) {
      for (const grant of runtime.repository.listProductGrants(merchant.id)) {
        if (!grant.available) continue;
        runtime.repository.saveProductGrant({...grant, available: false, priceVersion: grant.priceVersion + 1});
        disabledGrants += 1;
      }
      for (const product of managedGptProducts) {
        if (runtime.repository.findProductGrant(merchant.id, product.productCode)) continue;
        runtime.repository.saveProductGrant(newProductGrant(merchant.id, product, false));
        createdGrants += 1;
      }
    }

    for (const mapping of runtime.repository.listSupplierProductMappings()) {
      if (!mapping.enabled) continue;
      runtime.repository.saveSupplierProductMapping({...mapping, enabled: false, version: mapping.version + 1, updatedAt: new Date()});
      disabledMappings += 1;
    }
    runtime.repository.replaceSupplierPlanSnapshots(SupplierManagementService.connectionId, "claude", []);
    runtime.repository.replaceSupplierPlanSnapshots(SupplierManagementService.connectionId, "grok", []);

    return {
      merchants: runtime.repository.listMerchants().length,
      managed_gpt_products: managedGptProducts.length,
      created_product_grants: createdGrants,
      disabled_product_grants: disabledGrants,
      disabled_supplier_mappings: disabledMappings,
    };
  });
  console.log(JSON.stringify(result));
} finally {
  runtime.close();
}
