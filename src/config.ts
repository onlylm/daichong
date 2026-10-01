import { z } from "zod";
import {dirname, join} from "node:path";
import {normalizeIpRules} from "./auth/ip.js";

const booleanText = z.enum(["true", "false"]).transform((value) => value === "true");
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const optionalSecret = z.preprocess((value) => value === "" ? undefined : value, z.string().min(16).optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  EXECUTION_MODE: z.preprocess((value) => value === "" ? undefined : value, z.enum(["disabled", "controlled", "production"]).optional()),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: booleanText.default(false),
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  ENABLE_SANDBOX_ROUTES: booleanText.default(false),
  SANDBOX_ADMIN_TOKEN: z.string().min(16).default("replace-local-sandbox-token"),
  PLATFORM_ADMIN_TOKEN: z.string().min(32).default("replace-platform-admin-token-at-least-32-chars"),
  DEMO_PARTNER_ID: z.string().default("pt_demo_a"),
  DEMO_KEY_ID: z.string().default("key_demo_a_01"),
  DEMO_CLIENT_SECRET: z.string().min(32).default("replace-with-demo-secret-at-least-32-chars"),
  DATA_ENCRYPTION_KEY: z.string().default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  KEY_ENCRYPTION_KEY_ID: z.string().default("local-development-only"),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:3200"),
  ADMIN_BASE_URL: optionalUrl,
  PORTAL_TOKEN_SECRET: z.string().min(32).default("replace-public-portal-secret-32-chars"),
  FULFILLMENT_PROVIDER: z.enum(["mock", "zovocard"]).default("mock"),
  PAYMENT_PROVIDER: z.enum(["mock", "alipay_page", "managed"]).default("mock"),
  ALIPAY_APP_ID: z.string().default(""),
  ALIPAY_SELLER_ID: z.string().default(""),
  ALIPAY_PRIVATE_KEY_PATH: z.string().default(""),
  ALIPAY_PUBLIC_KEY_PATH: z.string().default(""),
  ALIPAY_KEY_TYPE: z.enum(["PKCS1", "PKCS8"]).default("PKCS8"),
  LIVE_TEST_ENABLED: booleanText.default(false),
  LIVE_TEST_PARTNER_IDS: z.string().default(""),
  LIVE_TEST_MAX_ORDER_MINOR: z.coerce.number().int().positive().default(16000),
  LIVE_TEST_MAX_TOTAL_MINOR: z.coerce.number().int().positive().default(32000),
  LIVE_TEST_MAX_ORDERS: z.coerce.number().int().positive().default(2),
  ZOVOCARD_CDK_FUNDING_CAP_MINOR: z.coerce.number().int().nonnegative().default(0),
  ZOVOCARD_API_BASE: z.string().url().default("https://sandbox.zovocard.com/openapi/v1"),
  ZOVOCARD_CDK_BASE: z.string().url().default("https://sandbox.zovocard.com/api/v1/cdk"),
  ZOVOCARD_API_KEY: optionalSecret,
  ZOVOCARD_CARD_ID: z.preprocess((value) => value === "" || value === undefined ? undefined : value, z.coerce.number().int().positive().optional()),
  ZOVOCARD_WEBHOOK_SECRET: optionalSecret,
  SUPPLIER_ALLOWED_HOSTS: z.string().default("sandbox.zovocard.com,zovocard.com"),
  STORAGE_DRIVER: z.enum(["memory", "sqlite"]).default("sqlite"),
  SQLITE_PATH: z.string().default("./data/quefa-sandbox.sqlite"),
  BACKUP_HEALTH_REPORT_PATH: z.string().default(""),
  BACKUP_RESTORE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(720).default(192),
  DEMO_WEBHOOK_URL: optionalUrl,
  DEMO_WEBHOOK_SECRET: z.string().min(16).default("replace-demo-webhook-secret"),
  REGISTRATION_ENABLED: booleanText.default(true),
  API_RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  API_RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
});

export type AppConfig = {
  paymentProvider?: "mock" | "alipay_page" | "managed";
  alipay?: {appId: string; sellerId: string; privateKeyPath: string; publicKeyPath: string; keyType: "PKCS1" | "PKCS8"};
  liveTest?: {enabled: boolean; partnerIds: string[]; maxOrderMinor: number; maxTotalMinor: number; maxOrders: number; cdkFundingCapMinor: number};
  nodeEnv: "development" | "test" | "production";
  executionMode: "disabled" | "controlled" | "production";
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  trustedProxyCidrs: string[];
  enableSandboxRoutes: boolean;
  sandboxAdminToken: string;
  platformAdminToken: string;
  demoPartnerId: string;
  demoKeyId: string;
  demoClientSecret: string;
  dataEncryptionKey: Buffer;
  keyEncryptionKeyId: string;
  publicBaseUrl: string;
  adminBaseUrl?: string;
  portalTokenSecret: string;
  fulfillmentProvider: "mock" | "zovocard";
  zovocardApiBase: string;
  zovocardCdkBase: string;
  zovocardApiKey: string | null;
  zovocardCardId: number | null;
  zovocardWebhookSecret: string | null;
  supplierAllowedHosts: string[];
  storageDriver: "memory" | "sqlite";
  sqlitePath: string;
  backupHealthReportPath: string | null;
  backupRestoreMaxAgeMs: number;
  demoWebhookUrl: string | null;
  demoWebhookSecret: string;
  registrationEnabled: boolean;
  apiRateLimitReadPerMinute?: number;
  apiRateLimitWritePerMinute?: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  let trustedProxyCidrs: string[];
  try {
    trustedProxyCidrs = normalizeIpRules(parsed.TRUSTED_PROXY_CIDRS.split(","));
  } catch {
    throw new Error("TRUSTED_PROXY_CIDRS 只允许 IPv4、IPv6 或 CIDR，以逗号分隔");
  }
  const executionMode = parsed.EXECUTION_MODE ?? (parsed.LIVE_TEST_ENABLED ? "controlled" : "disabled");
  if (parsed.PAYMENT_PROVIDER !== "mock" && /alipay|\*/i.test(env.NODE_DEBUG ?? "")) {
    throw new Error("真实支付禁止开启支付宝 SDK 调试日志，避免记录签名请求与交易数据");
  }
  const dataEncryptionKey = Buffer.from(parsed.DATA_ENCRYPTION_KEY, "base64");
  if (dataEncryptionKey.length !== 32) throw new Error("DATA_ENCRYPTION_KEY 必须是 32 字节 Base64");
  if (executionMode === "production" && parsed.NODE_ENV !== "production") {
    throw new Error("生产执行模式必须使用 NODE_ENV=production");
  }
  if (parsed.NODE_ENV === "production") {
    const publicUrl = new URL(parsed.PUBLIC_BASE_URL), adminUrl = new URL(parsed.ADMIN_BASE_URL ?? parsed.PUBLIC_BASE_URL);
    if (parsed.STORAGE_DRIVER !== "sqlite" || parsed.SQLITE_PATH === ":memory:") throw new Error("生产环境必须使用独立持久化数据库");
    if (!parsed.TRUST_PROXY || parsed.ENABLE_SANDBOX_ROUTES || publicUrl.protocol !== "https:" || adminUrl.protocol !== "https:") {
      throw new Error("生产环境必须启用可信反向代理、HTTPS，并关闭沙箱路由");
    }
    if (trustedProxyCidrs.length === 0) throw new Error("生产环境必须显式配置 TRUSTED_PROXY_CIDRS，禁止无条件信任转发头");
    if ([parsed.PLATFORM_ADMIN_TOKEN, parsed.PORTAL_TOKEN_SECRET, parsed.DEMO_CLIENT_SECRET].some(value => value.startsWith("replace-"))
        || dataEncryptionKey.equals(Buffer.alloc(32))) throw new Error("生产环境必须更换全部默认密钥");
  }
  if (executionMode === "production" && (parsed.PAYMENT_PROVIDER !== "managed" || parsed.FULFILLMENT_PROVIDER !== "zovocard")) {
    throw new Error("生产执行模式必须使用后台托管支付和真实充值供应适配器");
  }
  const supplierAllowedHosts = parsed.SUPPLIER_ALLOWED_HOSTS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (supplierAllowedHosts.length === 0) throw new Error("SUPPLIER_ALLOWED_HOSTS 至少配置一个域名");
  return {
    paymentProvider: parsed.PAYMENT_PROVIDER,
    alipay: {appId: parsed.ALIPAY_APP_ID, sellerId: parsed.ALIPAY_SELLER_ID, privateKeyPath: parsed.ALIPAY_PRIVATE_KEY_PATH, publicKeyPath: parsed.ALIPAY_PUBLIC_KEY_PATH, keyType: parsed.ALIPAY_KEY_TYPE},
    liveTest: {enabled: parsed.LIVE_TEST_ENABLED, partnerIds: parsed.LIVE_TEST_PARTNER_IDS.split(",").map(x => x.trim()).filter(Boolean),
      maxOrderMinor: parsed.LIVE_TEST_MAX_ORDER_MINOR, maxTotalMinor: parsed.LIVE_TEST_MAX_TOTAL_MINOR,
      maxOrders: parsed.LIVE_TEST_MAX_ORDERS, cdkFundingCapMinor: parsed.ZOVOCARD_CDK_FUNDING_CAP_MINOR},
    nodeEnv: parsed.NODE_ENV,
    executionMode,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    trustProxy: parsed.TRUST_PROXY,
    trustedProxyCidrs,
    enableSandboxRoutes: parsed.ENABLE_SANDBOX_ROUTES,
    sandboxAdminToken: parsed.SANDBOX_ADMIN_TOKEN,
    platformAdminToken: parsed.PLATFORM_ADMIN_TOKEN,
    demoPartnerId: parsed.DEMO_PARTNER_ID,
    demoKeyId: parsed.DEMO_KEY_ID,
    demoClientSecret: parsed.DEMO_CLIENT_SECRET,
    dataEncryptionKey,
    keyEncryptionKeyId: parsed.KEY_ENCRYPTION_KEY_ID,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    adminBaseUrl: parsed.ADMIN_BASE_URL ?? parsed.PUBLIC_BASE_URL,
    portalTokenSecret: parsed.PORTAL_TOKEN_SECRET,
    fulfillmentProvider: parsed.FULFILLMENT_PROVIDER,
    zovocardApiBase: parsed.ZOVOCARD_API_BASE.replace(/\/$/, ""),
    zovocardCdkBase: parsed.ZOVOCARD_CDK_BASE.replace(/\/$/, ""),
    zovocardApiKey: parsed.ZOVOCARD_API_KEY ?? null,
    zovocardCardId: parsed.ZOVOCARD_CARD_ID ?? null,
    zovocardWebhookSecret: parsed.ZOVOCARD_WEBHOOK_SECRET ?? null,
    supplierAllowedHosts,
    storageDriver: parsed.STORAGE_DRIVER,
    sqlitePath: parsed.SQLITE_PATH,
    backupHealthReportPath: parsed.BACKUP_HEALTH_REPORT_PATH || (parsed.STORAGE_DRIVER === "sqlite" && parsed.SQLITE_PATH !== ":memory:"
      ? join(dirname(parsed.SQLITE_PATH), "sqlite-restore-health.json") : null),
    backupRestoreMaxAgeMs: parsed.BACKUP_RESTORE_MAX_AGE_HOURS * 60 * 60 * 1000,
    demoWebhookUrl: parsed.DEMO_WEBHOOK_URL ?? null,
    demoWebhookSecret: parsed.DEMO_WEBHOOK_SECRET,
    registrationEnabled: parsed.REGISTRATION_ENABLED,
    apiRateLimitReadPerMinute: parsed.API_RATE_LIMIT_READ_PER_MINUTE,
    apiRateLimitWritePerMinute: parsed.API_RATE_LIMIT_WRITE_PER_MINUTE,
  };
}
