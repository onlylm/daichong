import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {loadConfig, type AppConfig} from "../config.js";
import {SqliteRepository} from "../infra/sqlite-repository.js";
import type {Repository} from "../infra/repository.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import {SupplierManagementService} from "../modules/supplier-management-service.js";
import {AuditService} from "../modules/audit-service.js";
import {ZovoCardRechargeProvider} from "../upstream/zovocard-provider.js";
import {validateSupplierBases} from "../upstream/supplier-url.js";

const productCode = "chatgpt_pro_50x_cdk_1m";
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Prepares only this supply mapping. Never publishes, sets prices, issues CDKs or starts orders.
export async function preparePro50x(config: AppConfig, repository: Repository) {
  const connection = repository.findSupplierConnection(SupplierManagementService.connectionId);
  if (!connection?.enabled) throw new Error("supplier_connection_disabled");
  validateSupplierBases(connection.openApiBase, connection.cdkBase, connection.environment, config.supplierAllowedHosts);
  const cipher = new SensitivePayloadCipher(config.dataEncryptionKey, config.keyEncryptionKeyId);
  const secrets = cipher.decrypt(connection.secretPayload, "supplier-connection:" + connection.id) as {apiKey?: string};
  if (!secrets.apiKey) throw new Error("supplier_api_key_missing");
  const client = new ZovoCardRechargeProvider(connection.openApiBase, connection.cdkBase, secrets.apiKey, null);
  const data = await client.getPlanCatalog("gpt");
  const rows = Array.isArray(data.registry) ? data.registry.map(asObject) : [];
  const row = rows.find(item => item.product === "gpt" && item.key === "pro_50x");
  const plan = asObject(asObject(data.plans).pro_50x);
  const regions = Array.isArray(data.payment_regions) ? data.payment_regions.map(asObject) : [];
  if (!row || row.acc_plan_key !== "pro_50x" || row.purchasable !== true || plan.enabled !== true
      || row.checkout_currency !== "PHP" || row.is_credit !== false || row.flow !== "direct"
      || !regions.some(region => region.country === "PH" && region.currency === "PHP")) {
    throw new Error("philippines_pro_50x_not_confirmed");
  }
  const management = new SupplierManagementService(repository, cipher, config.supplierAllowedHosts,
    config.fulfillmentProvider === "zovocard", config.liveTest, config.executionMode);
  return repository.transaction(() => {
    if (repository.findSupplierConnection(connection.id)?.configVersion !== connection.configVersion) throw new Error("supplier_config_changed");
    const entry = repository.getOperations("global_product_catalog", "default")?.products.find(item => item.productCode === productCode);
    if (!entry || entry.available) throw new Error("pro_50x_must_be_existing_unpublished_draft");
    const current = repository.findSupplierProductMapping(productCode);
    if (!current || current.supplierPlan !== "pro_50x" || current.supplierProduct !== "gpt" || current.fulfillmentMode !== "cdk") {
      throw new Error("pro_50x_mapping_requires_review");
    }
    const snapshot = {connectionId: connection.id, product: "gpt" as const, plan: "pro_50x", accPlanKey: "pro_50x",
      name: String(row.label ?? "Pro 50x"), enabled: true, purchasable: true,
      serviceFeeUsdMinor: typeof row.service_fee_usd_minor === "number" ? row.service_fee_usd_minor : null,
      pricingVersion: typeof data.version === "number" ? data.version : null, syncedAt: new Date()};
    const retained = repository.listSupplierPlanSnapshots(connection.id).filter(item => item.product === "gpt" && item.plan !== "pro_50x");
    repository.replaceSupplierPlanSnapshots(connection.id, "gpt", [...retained, snapshot]);
    const mapping = current.enabled ? current : management.saveMapping({
      productCode, fulfillmentMode: "cdk", supplierProduct: "gpt", supplierPlan: "pro_50x", enabled: true, expectedVersion: current.version,
    });
    new AuditService(repository).record({merchantId: null, actorId: "deployment:pro-50x-ph", actorType: "system",
      action: "supplier.pro_50x_ph.prepare", targetType: "supplier_mapping", targetId: productCode, requestId: randomUUID()});
    return {productCode, supplierPlan: mapping.supplierPlan, mappingEnabled: mapping.enabled,
      paymentCountry: "PH", paymentCurrency: "PHP", published: entry.available, pricingVersion: snapshot.pricingVersion,
      referenceAmount: typeof row.checkout_amount_minor === "number" ? row.checkout_amount_minor / 100 : null,
      serviceFeeUsd: snapshot.serviceFeeUsdMinor === null ? null : snapshot.serviceFeeUsdMinor / 100};
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--confirm-draft-only")) throw new Error("confirmation_required");
  const config = loadConfig();
  if (config.storageDriver !== "sqlite") throw new Error("sqlite_storage_required");
  const repository = new SqliteRepository(config.sqlitePath);
  try {console.log(JSON.stringify(await preparePro50x(config, repository)));}
  finally {repository.close();}
}
