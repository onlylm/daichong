import type {AppConfig} from "../config.js";
import type {Order, TenantContext} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import type {Repository} from "../infra/repository.js";

/** Real-transaction policy: disabled, bounded controlled testing, or normal production execution. */
export class LiveTestPolicy {
  constructor(private readonly config: AppConfig, private readonly repository: Repository) {}

  static validate(config: AppConfig): void {
    if (config.executionMode === "disabled") return;
    if (config.executionMode === "production") {
      if (config.nodeEnv !== "production" || config.paymentProvider !== "managed" || config.fulfillmentProvider !== "zovocard") {
        throw new Error("生产执行模式必须使用生产环境、后台托管支付和真实供应适配器");
      }
      if (config.enableSandboxRoutes || config.storageDriver !== "sqlite" || config.sqlitePath === ":memory:") {
        throw new Error("生产执行模式必须关闭沙箱路由并使用独立持久化数据库");
      }
      const url = new URL(config.publicBaseUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new Error("生产执行模式 PUBLIC_BASE_URL 必须为 HTTPS 站点根地址");
      }
      if ([config.platformAdminToken, config.portalTokenSecret, config.demoClientSecret].some(x => x.startsWith("replace-"))
          || config.dataEncryptionKey.equals(Buffer.alloc(32))) throw new Error("生产执行模式必须更换所有默认密钥");
      return;
    }
    const live = config.liveTest;
    if (!live?.enabled || !live.partnerIds.length || live.partnerIds.includes("pt_demo_b")) throw new Error("实单联调必须开启限额并配置独立测试代理白名单");
    if (config.enableSandboxRoutes || config.storageDriver !== "sqlite" || config.sqlitePath === ":memory:") throw new Error("实单联调必须关闭模拟支付入口，并使用独立的持久化 SQLite 文件");
    const url = new URL(config.publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("实单联调 PUBLIC_BASE_URL 必须为 HTTPS 站点根地址");
    if ([config.platformAdminToken, config.portalTokenSecret, config.demoClientSecret].some(x => x.startsWith("replace-"))
        || config.dataEncryptionKey.equals(Buffer.alloc(32))) throw new Error("实单联调必须更换所有默认密钥");
    if (!["alipay_page", "managed"].includes(config.paymentProvider ?? "mock")) throw new Error("实单联调必须使用真实支付通道");
    if (config.paymentProvider === "alipay_page" && (!config.alipay || !/^\d{16}$/.test(config.alipay.appId) || !/^\d{16}$/.test(config.alipay.sellerId)
        || !config.alipay.privateKeyPath || !config.alipay.publicKeyPath)) throw new Error("请配置支付宝 APPID、收款 PID、应用私钥文件与支付宝公钥文件");
    if (config.fulfillmentProvider === "zovocard" && live.cdkFundingCapMinor <= 0) throw new Error("真实供应联调必须设置正数的 CDK 兑换注资上限（上游计价单位）");
  }

  isProductionSupplier(): boolean {
    return this.config.fulfillmentProvider === "zovocard"
      && this.repository.findEnabledSupplierConnection()?.environment === "production";
  }

  // Called inside the order insertion transaction. Pending/failed/refunded test orders
  // all consume the lifetime budget: expiry, retries and restarts must not reset it.
  assertNewOrder(tenant: TenantContext, amount: bigint): boolean {
    if (!["alipay_page", "managed"].includes(this.config.paymentProvider ?? "mock")) return false;
    if (this.config.executionMode === "disabled") throw new AppError(503, "transactions_disabled", "生产交易当前已暂停");
    if (this.config.executionMode === "production") return false;
    const live = this.config.liveTest;
    if (!live?.enabled || !live.partnerIds.includes(tenant.partnerId)) throw new AppError(403, "live_test_partner_denied", "此代理商未获实单联调授权");
    const orders = this.repository.listOrdersInternal().filter(x => x.liveTest);
    if (amount > BigInt(live.maxOrderMinor) || orders.length >= live.maxOrders
        || orders.reduce((sum, x) => sum + x.saleAmountMinor, 0n) + amount > BigInt(live.maxTotalMinor)) {
      throw new AppError(409, "live_test_budget_exceeded", "实单联调订单数量或金额已达限额");
    }
    return true;
  }

  canFulfill(order: Order): boolean {
    if (this.config.fulfillmentProvider !== "zovocard") return true;
    const connection = this.repository.findEnabledSupplierConnection();
    if (!connection || this.config.executionMode === "disabled") return false;
    if (this.config.executionMode === "production" && connection.environment !== "production") return false;
    if (connection.environment !== "production") return true;
    const attempt = this.repository.findPaymentAttemptByOrder(order.merchantId, order.id);
    if (this.config.executionMode === "production") {
      return !!(attempt && ["alipay_page", "dujiaopay", "agent_wallet"].includes(attempt.provider)
        && attempt.status === "paid" && ["paid", "partially_refunded"].includes(order.paymentStatus));
    }
    const live = this.config.liveTest;
    const allowedMerchant = live?.partnerIds.some(id => this.repository.findMerchantByPartner(id)?.id === order.merchantId);
    return !!(live?.enabled && allowedMerchant && order.liveTest && attempt && ["alipay_page", "dujiaopay", "agent_wallet"].includes(attempt.provider)
      && attempt.status === "paid" && ["paid", "partially_refunded"].includes(order.paymentStatus));
  }

  requiresApproval(order: Order): boolean {
    // The persisted marker remains authoritative across deployment-mode changes.
    return !!order.liveTest;
  }
}
