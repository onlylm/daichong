import type {AppConfig} from "../config.js";
import type {FulfillmentMode, SupplierConnection, SupplierPlanSnapshot, SupplierProductMapping} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import type {Repository} from "../infra/repository.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import type {RechargeProduct, RechargeUpstreamProvider} from "../upstream/recharge-provider.js";
import {MockRechargeProvider, UpstreamRequestError} from "../upstream/recharge-provider.js";
import {ZovoCardRechargeProvider} from "../upstream/zovocard-provider.js";
import {validateSupplierBases} from "../upstream/supplier-url.js";
import {managedGptProduct, managedGptProducts, newProductGrant} from "./gpt-products.js";

interface SupplierSecrets {
  apiKey: string | null;
  webhookSecret: string | null;
  directPaymentResourceId: number | null;
}

interface ConnectionInput {
  name: string;
  environment: "sandbox" | "production";
  openApiBase: string;
  cdkBase: string;
  enabled: boolean;
  apiKey?: string;
  webhookSecret?: string;
  directPaymentResourceId?: number;
  clearApiKey?: boolean;
  clearWebhookSecret?: boolean;
  clearDirectPaymentResource?: boolean;
  expectedVersion?: number;
}

export class SupplierManagementService {
  private nextQuoteSyncAt = 0;
  static readonly connectionId = "supplier_primary";

  constructor(
    private readonly repository: Repository,
    private readonly cipher: SensitivePayloadCipher,
    private readonly allowedHosts: string[],
    private readonly allowLiveFulfillment: boolean,
    private readonly liveTest?: AppConfig["liveTest"],
    private readonly executionMode: AppConfig["executionMode"] = "disabled",
  ) {}

  seed(config: AppConfig): void {
    validateSupplierBases(config.zovocardApiBase, config.zovocardCdkBase, config.zovocardApiBase.includes("sandbox.") ? "sandbox" : "production", this.allowedHosts);
    if (!this.repository.findSupplierConnection(SupplierManagementService.connectionId)) {
      const now = new Date();
      const secrets: SupplierSecrets = {
        apiKey: config.zovocardApiKey,
        webhookSecret: config.zovocardWebhookSecret,
        directPaymentResourceId: config.zovocardCardId,
      };
      this.repository.saveSupplierConnection({
        id: SupplierManagementService.connectionId,
        name: "主充值供应渠道",
        provider: "zovocard",
        environment: config.zovocardApiBase.includes("sandbox.") ? "sandbox" : "production",
        openApiBase: config.zovocardApiBase,
        cdkBase: config.zovocardCdkBase,
        enabled: config.fulfillmentProvider === "zovocard" && Boolean(secrets.apiKey),
        secretPayload: this.cipher.encrypt(secrets, connectionAad(SupplierManagementService.connectionId)),
        configVersion: 1,
        lastTestStatus: "never",
        lastTestMessage: null,
        lastTestAt: null,
        lastPlanSyncAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const managedCodes = new Set(managedGptProducts.map((product) => product.productCode));
    for (const product of managedGptProducts) {
      const legacyMapping = product.legacyProductCode
        ? this.repository.findSupplierProductMapping(product.legacyProductCode)
        : null;
      const existing = this.repository.findSupplierProductMapping(product.productCode);
      // Real supplier mappings are always an explicit administrator decision.
      // The isolated mock provider has no external account or money movement, so
      // its initial mappings are enabled to keep local/test flows usable.
      const enabled = existing?.enabled ?? config.fulfillmentProvider === "mock";
      this.seedMapping(product.productCode, product.fulfillmentMode, product.upstreamPlan, enabled);
    }
    // Old direct products and historical non-GPT products remain in storage
    // only for order/audit history. New orders can use CDK-backed GPT products
    // exclusively.
    for (const mapping of this.repository.listSupplierProductMappings()) {
      if ((mapping.supplierProduct !== "gpt" || !managedCodes.has(mapping.productCode)) && mapping.enabled) {
        this.repository.saveSupplierProductMapping({...mapping, enabled: false, version: mapping.version + 1, updatedAt: new Date()});
      }
    }
    this.reconcileProductGrants(managedCodes);
  }

  getConnection() {
    const value = this.requireConnection();
    const secrets = this.readSecrets(value);
    return {...publicConnection(value, secrets), execution_mode: this.allowLiveFulfillment ? "supplier" : "mock", transaction_mode: this.executionMode};
  }

  saveConnection(input: ConnectionInput) {
    return this.repository.transaction(() => this.saveConnectionLocked(input));
  }

  private saveConnectionLocked(input: ConnectionInput) {
    validateSupplierBases(input.openApiBase, input.cdkBase, input.environment, this.allowedHosts);
    const current = this.requireConnection();
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.configVersion) throw new AppError(409, "supplier_config_changed", "供应配置已被更新，请重新读取后保存");
    const previous = this.readSecrets(current);
    const identityChanged = trimSlash(input.openApiBase) !== current.openApiBase || trimSlash(input.cdkBase) !== current.cdkBase || input.environment !== current.environment;
    const keyChanged = Boolean(input.clearApiKey || (input.apiKey && input.apiKey !== previous.apiKey));
    if ((identityChanged || keyChanged) && previous.apiKey && this.hasOutstandingOrders()) {
      throw new AppError(409, "supplier_has_outstanding_orders", "存在未完成订单或有效兑换码，暂不能切换供应地址、环境或 API Key");
    }
    if (identityChanged && previous.apiKey && !input.apiKey && !input.clearApiKey) throw new AppError(422, "supplier_credentials_required", "切换供应环境时必须重新配置或清除密钥");
    const secrets: SupplierSecrets = {
      apiKey: input.clearApiKey ? null : input.apiKey ?? previous.apiKey,
      webhookSecret: input.clearWebhookSecret ? null : input.webhookSecret ?? (identityChanged ? null : previous.webhookSecret),
      directPaymentResourceId: input.clearDirectPaymentResource ? null : input.directPaymentResourceId ?? (identityChanged ? null : previous.directPaymentResourceId),
    };
    if (input.enabled && !secrets.apiKey) throw new AppError(422, "supplier_api_key_required", "启用供应连接前必须配置 API Key");
    const updated: SupplierConnection = {
      ...current,
      name: input.name,
      environment: input.environment,
      openApiBase: trimSlash(input.openApiBase),
      cdkBase: trimSlash(input.cdkBase),
      enabled: input.enabled,
      secretPayload: this.cipher.encrypt(secrets, connectionAad(current.id)),
      configVersion: current.configVersion + 1,
      lastTestStatus: "never",
      lastTestMessage: null,
      lastTestAt: null,
      lastPlanSyncAt: identityChanged || keyChanged ? null : current.lastPlanSyncAt,
      updatedAt: new Date(),
    };
    this.repository.saveSupplierConnection(updated);
    if (identityChanged || keyChanged) for (const product of ["gpt", "claude", "grok"] as const) this.repository.replaceSupplierPlanSnapshots(current.id, product, []);
    return this.getConnection();
  }

  async testConnection() {
    const current = this.requireConnection();
    try {
      const client = this.client(false);
      const [balance, plans] = await Promise.all([client.getBalance(), client.getPlanCatalog("gpt")]);
      const updated = {...current, lastTestStatus: "succeeded" as const, lastTestMessage: "连接、余额与套餐接口正常", lastTestAt: new Date(), updatedAt: new Date()};
      this.saveTestResult(current.configVersion, updated);
      return {status: "succeeded", balance: sanitizeBalance(balance), pricing_version: numberOrNull(plans.version)};
    } catch (error) {
      const message = safeSupplierError(error);
      if (error instanceof AppError && error.code === "supplier_config_changed") throw error;
      this.saveTestResult(current.configVersion, {...current, lastTestStatus: "failed", lastTestMessage: message, lastTestAt: new Date(), updatedAt: new Date()});
      throw new AppError(502, "supplier_connection_failed", message, error instanceof UpstreamRequestError && error.retryable);
    }
  }

  async getBalance() {
    try {
      return sanitizeBalance(await this.client(false).getBalance());
    } catch (error) {
      throw new AppError(502, "supplier_balance_unavailable", safeSupplierError(error), true);
    }
  }

  async syncPlans(): Promise<SupplierPlanSnapshot[]> {
    const connection = this.requireConnection();
    const client = this.client(false);
    try {
      const data = await client.getPlanCatalog("gpt");
      const syncedAt = new Date();
      const plans = normalizePlans(connection.id, "gpt", data, syncedAt);
      this.repository.transaction(() => {
        const latest = this.requireVersion(connection.configVersion);
        this.repository.replaceSupplierPlanSnapshots(connection.id, "gpt", plans);
        this.repository.replaceSupplierPlanSnapshots(connection.id, "claude", []);
        this.repository.replaceSupplierPlanSnapshots(connection.id, "grok", []);
        this.reconcileDisabledMappings(plans);
        this.repository.saveSupplierConnection({...latest, lastPlanSyncAt: syncedAt, updatedAt: syncedAt});
      });
      return this.repository.listSupplierPlanSnapshots(connection.id).sort(planSort);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "supplier_plan_sync_failed", safeSupplierError(error), error instanceof UpstreamRequestError && error.retryable);
    }
  }

  async syncQuotesOne(): Promise<void> {
    if (!this.allowLiveFulfillment || Date.now() < this.nextQuoteSyncAt) return;
    this.nextQuoteSyncAt = Date.now() + 15 * 60_000;
    if (!this.requireConnection().enabled) return;
    try { await this.syncPlans(); } catch (error) { this.nextQuoteSyncAt = Date.now() + 60_000; throw error; }
  }

  listPlans(): SupplierPlanSnapshot[] {
    return this.repository.listSupplierPlanSnapshots(this.requireConnection().id)
      .filter(item => item.product === "gpt" && managedGptProducts.some(p => p.matchPlan(item))).sort(planSort);
  }

  listMappings(): SupplierProductMapping[] {
    return this.repository.listSupplierProductMappings()
      .filter(item => item.supplierProduct === "gpt" && managedGptProduct(item.productCode))
      .sort((a, b) => a.productCode.localeCompare(b.productCode));
  }

  saveMapping(input: {productCode: string; fulfillmentMode: FulfillmentMode; supplierProduct: "gpt"; supplierPlan: string; enabled: boolean; expectedVersion?: number}): SupplierProductMapping {
    return this.repository.transaction(() => {
    const definition = managedGptProduct(input.productCode);
    if (!definition) throw new AppError(422, "product_mapping_unsupported", "仅支持平台内置的 GPT 商品映射");
    if (definition.fulfillmentMode !== input.fulfillmentMode) throw new AppError(422, "fulfillment_mode_mismatch", "商品履约方式不能更改");
    const connection = this.requireConnection();
    const previous = this.repository.findSupplierProductMapping(input.productCode);
    if (input.expectedVersion !== undefined && input.expectedVersion !== (previous?.version ?? 0)) {
      throw new AppError(409, "mapping_changed", "映射已更新，请刷新后重新确认");
    }
    if (input.enabled) {
      const plans = this.repository.listSupplierPlanSnapshots(connection.id);
      const plan = plans.find((item) => item.product === input.supplierProduct && item.plan === input.supplierPlan);
      if (plan && !definition.matchPlan(plan)) throw new AppError(422, "supplier_plan_mismatch", "上游套餐与商品的类型、倍率或点数不匹配");
      if ((this.allowLiveFulfillment || connection.lastPlanSyncAt || plans.length > 0) && (!plan || !plan.enabled || !plan.purchasable)) {
        throw new AppError(422, "supplier_plan_unavailable", "选择的供应套餐当前不可售");
      }
    }
    const current = this.repository.findSupplierProductMapping(input.productCode);
    const now = new Date();
    const value: SupplierProductMapping = {
      productCode: input.productCode,
      connectionId: connection.id,
      fulfillmentMode: input.fulfillmentMode,
      supplierProduct: input.supplierProduct,
      supplierPlan: input.supplierPlan,
      enabled: input.enabled,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.repository.saveSupplierProductMapping(value);
    return value;
    });
  }

  async listDirectOrders(page: number, pageSize: number) {
    return this.readReconciliation(async (client) => sanitizeDirectOrders(await client.listDirectOrders(page, pageSize)));
  }

  async listCdks(page: number, pageSize: number) {
    return this.readReconciliation(async (client) => sanitizeCdks(await client.listCdks(page, pageSize)));
  }

  async listCdkOrders(page: number, pageSize: number) {
    return this.readReconciliation(async (client) => sanitizeCdkOrders(await client.listCdkOrders(page, pageSize)));
  }

  async costFacts(orderId: string, mode: "direct" | "cdk") {
    if (!this.allowLiveFulfillment) throw new AppError(409, "cost_live_supplier_required", "真实成本核对需要生产供应渠道");
    return this.client(false).costFacts(orderId, mode);
  }

  provider(): RechargeUpstreamProvider {
    const mock = new MockRechargeProvider();
    const service = this;
    return {
      get name() { return service.allowLiveFulfillment ? "configured_supplier" : mock.name; },
      submitDirect: (input) => service.allowLiveFulfillment ? service.client(true).submitDirect(input) : mock.submitDirect(input),
      submitCdk: (input) => service.allowLiveFulfillment ? service.client(true).submitCdk(input) : mock.submitCdk(input),
      preflightDirect: (input) => service.allowLiveFulfillment ? service.client(true).preflightDirect(input) : mock.preflightDirect(input),
      preflightCdk: (input) => service.allowLiveFulfillment ? service.client(true).preflightCdk(input) : mock.preflightCdk(input),
      query: (input) => service.allowLiveFulfillment ? service.client(false).query(input) : mock.query(input),
      issueCdk: (input) => service.allowLiveFulfillment ? service.client(true).issueCdk(input) : mock.issueCdk(input),
      disableCdk: (id) => service.allowLiveFulfillment ? service.client(false).disableCdk(id) : mock.disableCdk(id),
    };
  }

  getWebhookSecret(): string | null {
    return this.readSecrets(this.requireConnection()).webhookSecret;
  }

  private client(requireEnabled: boolean): ZovoCardRechargeProvider {
    const connection = requireEnabled ? this.repository.findEnabledSupplierConnection() : this.requireConnection();
    if (!connection) throw new UpstreamRequestError("upstream_configuration_error", false);
    if (requireEnabled && this.executionMode === "production" && connection.environment !== "production") {
      throw new UpstreamRequestError("production_supplier_required", false);
    }
    if (requireEnabled && connection.environment === "production"
        && this.executionMode !== "production" && !(this.executionMode === "controlled" && this.liveTest?.enabled)) {
      throw new UpstreamRequestError("production_execution_disabled", false);
    }
    validateSupplierBases(connection.openApiBase, connection.cdkBase, connection.environment, this.allowedHosts);
    const secrets = this.readSecrets(connection);
    if (!secrets.apiKey) throw new UpstreamRequestError("upstream_configuration_error", false);
    return new ZovoCardRechargeProvider(connection.openApiBase, connection.cdkBase, secrets.apiKey, secrets.directPaymentResourceId, this.liveTest?.cdkFundingCapMinor ?? 0);
  }

  private requireConnection(): SupplierConnection {
    const value = this.repository.findSupplierConnection(SupplierManagementService.connectionId);
    if (!value) throw new AppError(503, "supplier_not_configured", "充值供应连接尚未配置");
    return value;
  }

  private requireVersion(version: number): SupplierConnection {
    const current = this.requireConnection();
    if (current.configVersion !== version) throw new AppError(409, "supplier_config_changed", "操作期间供应配置已变更，请重新执行");
    return current;
  }

  private saveTestResult(version: number, result: SupplierConnection): void {
    this.repository.transaction(() => {
      const current = this.requireVersion(version);
      this.repository.saveSupplierConnection({...current, lastTestAt: result.lastTestAt, lastTestStatus: result.lastTestStatus, lastTestMessage: result.lastTestMessage, updatedAt: new Date()});
    });
  }

  private hasOutstandingOrders(): boolean {
    return this.repository.listOrdersInternal().some((order) => {
      const voucher = this.repository.findCdkVoucherByOrder(order.id);
      if (voucher && ["issuing", "unused", "reserved", "disabling"].includes(voucher.status)) return true;
      if (order.paymentStatus === "pending" && order.expiresAt > new Date()) return true;
      if (!["paid", "partially_refunded"].includes(order.paymentStatus)) return false;
      return !this.repository.listFulfillments(order.merchantId, order.id).some((item) => item.status === "succeeded");
    });
  }

  private readSecrets(value: SupplierConnection): SupplierSecrets {
    return this.cipher.decrypt(value.secretPayload, connectionAad(value.id)) as SupplierSecrets;
  }

  private seedMapping(productCode: string, fulfillmentMode: FulfillmentMode, supplierPlan: string, enabled: boolean): void {
    if (this.repository.findSupplierProductMapping(productCode)) return;
    const now = new Date();
    this.repository.saveSupplierProductMapping({
      productCode, connectionId: SupplierManagementService.connectionId, fulfillmentMode, supplierProduct: "gpt", supplierPlan,
      enabled, version: 1, createdAt: now, updatedAt: now,
    });
  }

  private reconcileProductGrants(managedCodes: Set<string>): void {
    for (const merchant of this.repository.listMerchants()) {
      for (const product of managedGptProducts) {
        const current = this.repository.findProductGrant(merchant.id, product.productCode);
        if (current) {
          // Existing names, prices and mapping choices are business configuration, not seed data.
          continue;
        }
        const legacy = product.legacyProductCode
          ? this.repository.findProductGrant(merchant.id, product.legacyProductCode)
          : null;
        const seeded = newProductGrant(merchant.id, product, false);
        this.repository.saveProductGrant(legacy ? {
          ...seeded,
          supplyPriceMinor: legacy.supplyPriceMinor,
          maxSalePriceMinor: legacy.maxSalePriceMinor,
          available: legacy.available,
          priceVersion: legacy.priceVersion + 1,
        } : seeded);
      }
      for (const grant of this.repository.listProductGrants(merchant.id)) {
        if (grant.upstreamProduct === "gpt" && !managedCodes.has(grant.productCode) && grant.available) {
          this.repository.saveProductGrant({...grant, available: false, priceVersion: grant.priceVersion + 1});
        }
      }
    }
  }

  private reconcileDisabledMappings(plans: SupplierPlanSnapshot[]): void {
    for (const product of managedGptProducts) {
      const mapping = this.repository.findSupplierProductMapping(product.productCode);
      if (!mapping || mapping.enabled || plans.some(plan => plan.plan === mapping.supplierPlan)) continue;
      const matched = plans.find(product.matchPlan);
      if (!matched) continue;
      this.repository.saveSupplierProductMapping({...mapping, supplierProduct: "gpt", supplierPlan: matched.plan,
        version: mapping.version + 1, updatedAt: new Date()});
    }
  }

  private async readReconciliation<T>(action: (client: ZovoCardRechargeProvider) => Promise<T>): Promise<T> {
    try {
      return await action(this.client(false));
    } catch (error) {
      throw new AppError(502, "supplier_reconciliation_unavailable", safeSupplierError(error), error instanceof UpstreamRequestError && error.retryable);
    }
  }
}

function connectionAad(id: string): string {
  return `supplier-connection:${id}`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function publicConnection(value: SupplierConnection, secrets: SupplierSecrets) {
  return {
    id: value.id,
    name: value.name,
    provider: "configured_recharge_supplier",
    environment: value.environment,
    open_api_base: value.openApiBase,
    cdk_base: value.cdkBase,
    enabled: value.enabled,
    api_key_configured: Boolean(secrets.apiKey),
    webhook_secret_configured: Boolean(secrets.webhookSecret),
    direct_payment_resource_configured: Boolean(secrets.directPaymentResourceId),
    config_version: value.configVersion,
    last_test_status: value.lastTestStatus,
    last_test_message: value.lastTestMessage,
    last_test_at: value.lastTestAt?.toISOString() ?? null,
    last_plan_sync_at: value.lastPlanSyncAt?.toISOString() ?? null,
    updated_at: value.updatedAt.toISOString(),
  };
}

function normalizePlans(connectionId: string, product: RechargeProduct, data: Record<string, unknown>, syncedAt: Date): SupplierPlanSnapshot[] {
  const registry = Array.isArray(data.registry) ? data.registry.map(asObject) : [];
  const plans = asObject(data.plans);
  const pricingVersion = numberOrNull(data.version);
  return registry
    .filter((item) => item.product === product && typeof item.key === "string")
    .map((item) => {
      const plan = String(item.key);
      const accPlanKey = String(item.acc_plan_key ?? plan);
      const configured = asObject(plans[accPlanKey]);
      return {
        connectionId,
        product,
        plan,
        accPlanKey,
        name: String(item.name ?? item.label ?? configured.name ?? plan),
        enabled: configured.enabled === true,
        purchasable: item.purchasable === true,
        serviceFeeUsdMinor: numberOrNull(item.service_fee_usd_minor) ?? numberOrNull(configured.serviceFeeUsdMinor),
        checkoutAmountMinor: positiveInteger(item.checkout_amount_minor ?? configured.expectedAmountMinor),
        checkoutCurrency: typeof item.checkout_currency === "string" ? item.checkout_currency : typeof configured.currency === "string" ? configured.currency : null,
        // Never turn a PHP quote or the USD issuance fee into a USD subscription quote.
        quoteUsdMinor: (item.checkout_currency ?? configured.currency) === "USD"
          ? positiveInteger(item.checkout_amount_minor ?? configured.expectedAmountMinor) : null,
        pricingVersion,
        syncedAt,
      };
    });
}

function sanitizeBalance(data: Record<string, unknown>) {
  return {
    balance: numberOrNull(data.balance),
    spendable_balance: numberOrNull(data.spendable_balance),
    reserve_amount: numberOrNull(data.account_reserve_amount),
    minimum_deposit_amount: numberOrNull(data.minimum_deposit_amount),
    currency: typeof data.currency === "string" ? data.currency : "USD",
  };
}

function sanitizeDirectOrders(data: Record<string, unknown>) {
  return {total: numberOrNull(data.total) ?? 0, list: rows(data).map((item) => ({
    supplier_order_id: scalar(item.id ?? item.order_id), client_request_id: scalar(item.client_request_id),
    product: scalar(item.product), plan: scalar(item.plan), status: scalar(item.status), stage: scalar(item.stage),
    account_email_masked: maskedEmail(item.account_email_masked ?? item.account_email), quoted_amount_minor: numberOrNull(item.quoted_amount_minor),
    final_amount_minor: numberOrNull(item.final_amount_minor), currency: scalar(item.currency), created_at: scalar(item.created_at), updated_at: scalar(item.updated_at),
  }))};
}

function sanitizeCdks(data: Record<string, unknown>) {
  return {total: numberOrNull(data.total) ?? 0, list: rows(data).map((item) => ({
    supplier_cdk_id: scalar(item.id), plan: scalar(item.plan), status: scalar(item.status),
    fee_amount_minor: numberOrNull(item.fee_amount_minor), created_at: scalar(item.created_at), updated_at: scalar(item.updated_at),
  }))};
}

function sanitizeCdkOrders(data: Record<string, unknown>) {
  return {total: numberOrNull(data.total) ?? 0, list: rows(data).map((item) => ({
    supplier_order_id: scalar(item.id ?? item.order_id), plan: scalar(item.plan), status: scalar(item.status), stage: scalar(item.stage),
    account_email_masked: maskedEmail(item.account_email_masked ?? item.account_email), quoted_amount_minor: numberOrNull(item.quoted_amount_minor),
    final_amount_minor: numberOrNull(item.final_amount_minor), currency: scalar(item.currency), created_at: scalar(item.created_at), updated_at: scalar(item.updated_at),
  }))};
}

function rows(data: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(data.list) ? data.list.map(asObject) : [];
}

function maskedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = value.lastIndexOf("@");
  return at > 0 ? `${value[0]}***@${value.slice(at + 1)}` : null;
}

function scalar(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positiveInteger(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null; }

function safeSupplierError(error: unknown): string {
  if (error instanceof UpstreamRequestError) {
    if (error.failureCode === "upstream_configuration_error") return "供应连接配置不完整或鉴权失败";
    if (error.failureCode === "upstream_balance_insufficient") return "供应账户可消费余额不足";
    return error.retryable ? "供应服务暂时不可用，请稍后重试" : "供应接口拒绝了请求，请检查配置与权限";
  }
  return "供应连接测试失败";
}

function planSort(a: SupplierPlanSnapshot, b: SupplierPlanSnapshot): number {
  return a.product.localeCompare(b.product) || a.plan.localeCompare(b.plan);
}
