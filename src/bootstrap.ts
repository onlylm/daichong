import type { AppConfig } from "./config.js";
import { MemoryRepository } from "./infra/memory-repository.js";
import { SqliteRepository } from "./infra/sqlite-repository.js";
import { SensitivePayloadCipher } from "./infra/crypto.js";
import { ApiAuthenticator, RepositoryNonceStore } from "./auth/authenticator.js";
import { MerchantService } from "./modules/merchant-service.js";
import { CatalogService } from "./modules/catalog-service.js";
import { MockPaymentProvider, PaymentService } from "./modules/payment-service.js";
import { OrderService } from "./modules/order-service.js";
import { LedgerService } from "./modules/ledger-service.js";
import {NotificationService} from "./modules/notifications.js";
import { WebhookService } from "./modules/webhook-service.js";
import { FulfillmentService } from "./modules/fulfillment-service.js";
import { RefundService } from "./modules/refund-service.js";
import { SettlementService } from "./modules/settlement-service.js";
import { AuditService } from "./modules/audit-service.js";
import { AccessControlService } from "./modules/access-control-service.js";
import { PortalTokenService } from "./modules/portal-token.js";
import { CdkService } from "./modules/cdk-service.js";
import { SupplierManagementService } from "./modules/supplier-management-service.js";
import {AlipayPagePaymentProvider, AlipayPaymentService, createAlipayClient} from "./modules/alipay-payment.js";
import {LiveTestPolicy} from "./modules/live-test-policy.js";
import {AccountService} from "./operations/accounts.js";
import {SupportService, AnnouncementService} from "./operations/support.js";
import {activateInitialAgentCatalog, AgentService} from "./operations/agents.js";
import {seedGlobalProductCatalog} from "./operations/global-product-catalog.js";
import {WalletService} from "./operations/wallet.js";
import {ApiAccessService, applyDefaultApiAccessPolicy} from "./operations/api-access.js";
import {PaymentSettingsService} from "./modules/payment-settings.js";
import {ManagedPaymentProvider, ManagedAlipayService} from "./modules/managed-payment.js";
import {DujiaoPaymentService} from "./modules/dujiaopay-payment.js";
import {WalletAlipayService} from "./modules/wallet-alipay.js";
import {CostAccountingService} from "./operations/cost-accounting.js";
import {ManualCompletionService} from "./operations/manual-completion.js";
import {DailySettlementService} from "./operations/daily-settlements.js";
import {InvoiceService} from "./operations/invoices.js";
import {queryRecords} from "./infra/record-query.js";
import {InvoiceAlipayService} from "./modules/invoice-alipay.js";
import {RefundReconciliationService} from "./modules/refund-reconciliation-service.js";

export function createRuntime(config: AppConfig) {
  LiveTestPolicy.validate(config);
  const repository = config.storageDriver === "sqlite" ? new SqliteRepository(config.sqlitePath) : new MemoryRepository();
  return repository.transaction(() => {
  const merchantService = new MerchantService(repository);
  if (config.nodeEnv === "production") {
    // A copied prelaunch database may contain deterministic demo credentials. Revoke them before opening production traffic.
    for (const [partnerId, keyId] of [[config.demoPartnerId, config.demoKeyId], ["pt_demo_b", "key_demo_b_01"]] as const) {
      const merchant = repository.findMerchantByPartner(partnerId), credential = repository.findCredential(partnerId, keyId);
      if (credential) {
        repository.saveKey({...credential.key, status: "revoked", expiresAt: new Date()});
        repository.saveApp({...credential.app, status: "disabled"});
      }
      if (merchant?.name.startsWith("演示代理商")) repository.saveMerchant({...merchant, status: "suspended"});
    }
  } else {
    const merchantA = repository.findMerchantByPartner(config.demoPartnerId)
      ?? merchantService.createMerchant({partnerId: config.demoPartnerId, name: "演示代理商 A"});
    const existingCredentialA = repository.findCredential(config.demoPartnerId, config.demoKeyId);
    const appA = existingCredentialA?.app ?? merchantService.createApp(merchantA.id, {appId: "app_demo_a", name: "演示代理商城 A"});
    if (!existingCredentialA) merchantService.issueKey(merchantA.id, appA.id, config.demoKeyId, config.demoClientSecret);

    const merchantB = repository.findMerchantByPartner("pt_demo_b")
      ?? merchantService.createMerchant({partnerId: "pt_demo_b", name: "演示代理商 B"});
    const existingCredentialB = repository.findCredential("pt_demo_b", "key_demo_b_01");
    const appB = existingCredentialB?.app ?? merchantService.createApp(merchantB.id, {appId: "app_demo_b", name: "演示代理商城 B"});
    if (!existingCredentialB) merchantService.issueKey(merchantB.id, appB.id, "key_demo_b_01", "demo-secret-b-must-be-at-least-32-characters");

    for (const merchant of [merchantA, merchantB]) seedDemoProducts(repository, merchant.id);
    if (config.demoWebhookUrl) repository.saveWebhookEndpoint({
      id: "wh_demo_a", merchantId: merchantA.id, url: config.demoWebhookUrl, secret: config.demoWebhookSecret,
      subscribedEvents: ["*"], status: "active",
    });
  }

  const webhooks = new WebhookService(repository);
  const ledger = new LedgerService(repository);
  const catalog = new CatalogService(repository, config.fulfillmentProvider === "zovocard");
  const cipher = new SensitivePayloadCipher(config.dataEncryptionKey, config.keyEncryptionKeyId);
  const notifications = new NotificationService(repository);
  notifications.migrateLegacyCases();
  const portalTokens = new PortalTokenService(config.publicBaseUrl, config.portalTokenSecret ?? "test-public-portal-secret-at-least-32-chars");
  const supplierManagement = new SupplierManagementService(repository, cipher, config.supplierAllowedHosts, config.fulfillmentProvider === "zovocard", config.liveTest, config.executionMode);
  supplierManagement.seed(config);
  seedGlobalProductCatalog(repository);
  applyDefaultApiAccessPolicy(repository);
  activateInitialAgentCatalog(repository);
  const upstream = supplierManagement.provider();
  const audit = new AuditService(repository);
  const costs = new CostAccountingService(repository, audit, supplierManagement,config.fulfillmentProvider === "zovocard");
  const paymentSettings = new PaymentSettingsService(repository, cipher, config, audit);
  // 单个平台级支付提供方服务全部代理商；不得在代理商循环或租户配置中构造支付实例。
  const paymentProvider = config.paymentProvider === "managed"
    ? new ManagedPaymentProvider(paymentSettings, config.publicBaseUrl, portalTokens) : config.paymentProvider === "alipay_page"
    ? new AlipayPagePaymentProvider(config.publicBaseUrl, portalTokens) : new MockPaymentProvider(config.publicBaseUrl);
  const wallets = new WalletService(repository, audit, webhooks);
  const payment = new PaymentService(repository, ledger, webhooks, orderId => wallets.creditEarningOnFulfillmentSuccess(orderId));
  const walletAlipay = config.paymentProvider === "managed"
    ? new WalletAlipayService(repository, paymentSettings, wallets, config.publicBaseUrl, portalTokens) : null;
  const accounts = new AccountService(repository, audit, config.portalTokenSecret, cipher);
  const invoices = new InvoiceService(repository, cipher, audit);
  const support = new SupportService(repository, audit);
  const announcements = new AnnouncementService(repository, audit);
  const agents = new AgentService(repository, audit, config.registrationEnabled);
  const apiAccess = new ApiAccessService(repository, audit, config.executionMode === "production" && !config.enableSandboxRoutes);
  const livePolicy = new LiveTestPolicy(config, repository);
  const alipayProvider = new AlipayPagePaymentProvider(config.publicBaseUrl, portalTokens);
  const hasLegacyAlipay = queryRecords(repository,"payment_attempt",{filters:[{field:"provider",value:"alipay_page"},
    {field:"paymentConfigId",op:"is_null"}],limit:1,count:false}).data.length>0;
  const legacyAlipay = config.paymentProvider === "alipay_page" || (config.paymentProvider === "managed" && hasLegacyAlipay)
    ? new AlipayPaymentService(repository, payment, createAlipayClient(config.alipay!), config.alipay!, config.publicBaseUrl, alipayProvider) : null;
  const alipay = config.paymentProvider === "managed"
    ? new ManagedAlipayService(repository, paymentSettings, payment, config.publicBaseUrl, alipayProvider, legacyAlipay)
    : legacyAlipay;
  const invoiceAlipay = ["managed", "alipay_page"].includes(config.paymentProvider ?? "mock")
    ? new InvoiceAlipayService(repository, paymentSettings, invoices, config.publicBaseUrl, portalTokens,
      config.paymentProvider === "alipay_page" ? {client: createAlipayClient(config.alipay!), identity: config.alipay!} : null)
    : null;
  const dujiaopay = config.paymentProvider === "managed" ? new DujiaoPaymentService(repository, paymentSettings, payment) : null;
  const orders = new OrderService(repository, catalog, paymentProvider, config.publicBaseUrl, portalTokens, livePolicy, wallets);
  const fulfillments = new FulfillmentService(repository, cipher, webhooks, upstream, livePolicy, orderId => wallets.reconcileOrderEarnings(orderId));
  const manualCompletions = new ManualCompletionService(repository, fulfillments, costs, audit);
  const cdk = new CdkService(repository, cipher, upstream, webhooks, livePolicy);
  const refundReconciliations = new RefundReconciliationService(repository);
  // Migrate former ticket-backed discrepancies before any worker can decide
  // whether an order is safe to fulfil.
  refundReconciliations.migrateLegacyRecords();
  const refundExecutor = alipay ? {
    providerFor: (orderId: string) => {
      const order = repository.findOrderInternal(orderId);
      return order ? repository.findPaymentAttemptByOrder(order.merchantId, orderId)?.provider ?? null : null;
    },
    execute: (orderId: string, refund: import("./domain/model.js").Refund) =>
      alipay.refund(orderId, refund.id, refund.amountMinor, refund.reason),
    query: (orderId: string, refund: import("./domain/model.js").Refund) => alipay.queryRefund(orderId, refund.id, refund.amountMinor),
  } : undefined;
  const refunds = new RefundService(repository, ledger, webhooks, refundExecutor, orderId => {
    wallets.reconcileOrderEarnings(orderId);
    fulfillments.closeRefundedOrder(orderId);
  }, {
    discrepancy: input => refundReconciliations.observe(input),
    recorded: input => refundReconciliations.recorded(input),
  });
  alipay?.setExternalRefundHandler((orderId, refundedMinor, providerReference) => {
    refunds.syncProviderRefund(orderId, refundedMinor, providerReference);
  });
  const settlements = new SettlementService(repository);
  const dailySettlements = new DailySettlementService(repository, audit);
  const accessControl = new AccessControlService(repository);
  const authenticator = new ApiAuthenticator(repository, new RepositoryNonceStore(repository), undefined, {
    readPerMinute: config.apiRateLimitReadPerMinute ?? 600,
    writePerMinute: config.apiRateLimitWritePerMinute ?? 120,
  });

  return {
    repository, notifications, merchantService, accessControl, catalog, payment, alipay, livePolicy, orders, fulfillments, cdk, portalTokens, upstream, supplierManagement, refunds, settlements, webhooks, ledger, audit, authenticator,
    wallets, walletAlipay, accounts, support, announcements, agents, apiAccess, paymentSettings, dujiaopay, costs, manualCompletions, dailySettlements, refundReconciliations,
    invoices, invoiceAlipay,
    close: () => repository.close?.(),
  };
  });
}

export type Runtime = ReturnType<typeof createRuntime>;

function seedDemoProducts(repository: import("./infra/repository.js").Repository, merchantId: string): void {
  if (!repository.findProductGrant(merchantId, "chatgpt_plus_cdk_1m")) repository.saveProductGrant({
    merchantId, productCode: "chatgpt_plus_cdk_1m", name: "ChatGPT Plus 一个月·CDK 兑换",
    supplyPriceMinor: 11_000n, maxSalePriceMinor: 15_900n, currency: "CNY", maxQuantity: 1, available: true,
    priceVersion: 1, fulfillmentMode: "cdk", upstreamProduct: "gpt", upstreamPlan: "plus",
  });
}
