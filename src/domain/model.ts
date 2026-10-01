export type MerchantStatus = "onboarding" | "active" | "suspended" | "closed";
export type AppStatus = "active" | "disabled";
export type ApiKeyStatus = "active" | "expiring" | "revoked";
export type PaymentStatus = "pending" | "paid" | "expired" | "closed" | "partially_refunded" | "refunded";
export type FulfillmentStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RefundStatus = "requested" | "approved" | "processing" | "succeeded" | "failed" | "rejected" | "cancelled";
export type RefundType = "full" | "partial" | "price_adjustment";
export type SettlementStatus = "draft" | "reviewing" | "confirmed" | "paying" | "paid" | "failed" | "cancelled";
export type FulfillmentMode = "direct" | "cdk";
export type DeliveryMode = "auto_recharge" | "cdk";
export type VoucherStatus = "issuing" | "unused" | "reserved" | "consumed" | "failed" | "disabling" | "disabled";

export interface TenantContext {
  merchantId: string;
  partnerId: string;
  appId: string;
  keyId: string;
}

export interface Merchant {
  id: string;
  partnerId: string;
  name: string;
  status: MerchantStatus;
}

export interface PartnerApp {
  id: string;
  merchantId: string;
  appId: string;
  name: string;
  status: AppStatus;
  allowedIps: string[];
}

export interface MerchantRole {
  id: string;
  merchantId: string;
  code: string;
  name: string;
  permissions: string[];
}

export interface MerchantUser {
  id: string;
  merchantId: string;
  userId: string;
  roleId: string;
  status: "invited" | "active" | "disabled";
}

export interface ApiKey {
  id: string;
  merchantId: string;
  appId: string;
  keyId: string;
  secret: string;
  status: ApiKeyStatus;
  notBefore: Date;
  expiresAt: Date | null;
}

export interface ProductGrant {
  merchantId: string;
  productCode: string;
  name: string;
  supplyPriceMinor: bigint;
  maxSalePriceMinor: bigint;
  currency: "CNY";
  maxQuantity: number;
  available: boolean;
  priceVersion: number;
  fulfillmentMode: FulfillmentMode;
  upstreamProduct: "gpt" | "claude" | "grok";
  upstreamPlan: string;
}

export interface Order {
  /** Recoverable test-data cleanup; payment evidence and ledger are never deleted. */
  archivedAt?: Date;
  archiveReason?: string;
  archivedBy?: string;
  notifyUrl?: string | null;
  collectionMode?: "platform_collect" | "agent_collect";
  /** Customer-facing delivery choice. Production GPT products are CDK-backed even when this is auto_recharge. */
  deliveryMode?: DeliveryMode;
  /** Automatic redemption ended unsuccessfully; the agent may offer its own branded retry entry. */
  fallbackRechargeAvailable?: boolean;
  liveTest?: boolean;
  id: string;
  merchantId: string;
  appId: string;
  merchantOrderNo: string;
  productCode: string;
  quantity: number;
  saleAmountMinor: bigint;
  supplyAmountMinor: bigint;
  ordinaryRefundedMinor: bigint;
  priceAdjustmentRefundedMinor: bigint;
  costTerms?: {standardUsdMinor: bigint | null; standardCnyMinor: bigint | null; retainedUsdMinor: bigint; productVersion: number;
    refundBenchmarkUsdMinor?: bigint | null;
    quoteCurrency?: string | null; quoteAmountMinor?: number | null; quoteVersion?: number | null; quoteAt?: string | null; serviceFeeUsdMinor?: number | null;
    standardSource?: "operator_verified_baseline" | "upstream_usd_quote" | null; standardAt?: string | null};
  currency: "CNY";
  paymentStatus: PaymentStatus;
  metadata: Record<string, string | number | boolean | null>;
  paymentProviderRef: string | null;
  paymentReceivedMinor: bigint | null;
  paymentFeeMinor: bigint | null;
  qrPayload: string | null;
  qrImageUrl: string | null;
  fulfillmentMode: FulfillmentMode;
  upstreamProduct: "gpt" | "claude" | "grok";
  upstreamPlan: string;
  fulfillmentUrl: string;
  voucherCode: string | null;
  settlementId: string | null;
  paidAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentAttempt {
  paymentConfigId?: string;
  nextCheckAt?: Date;
  /** Cross-process lease used while requesting a provider payment code. */
  precreateLeaseToken?: string | null;
  precreateLeaseUntil?: Date | null;
  id: string;
  merchantId: string;
  orderId: string;
  provider: string;
  status: "pending" | "paid" | "expired" | "closed" | "failed" | "refunded";
  providerRef: string | null;
  requestedMinor: bigint;
  receivedMinor: bigint | null;
  feeMinor: bigint | null;
  qrPayload: string | null;
  expiresAt: Date;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncryptedPayload {
  ciphertext: string | null;
  iv: string | null;
  authTag: string | null;
  keyVersion: string;
  clearedAt: Date | null;
}

export interface Fulfillment {
  retryAllowed?: boolean;
  recoveryAction?: "retry" | "refund";
  recoveryReason?: string;
  progressVersion?: number;
  progressUpdatedAt?: Date;
  liveSubmissionApproved?: boolean;
  id: string;
  merchantId: string;
  orderId: string;
  attemptNo: number;
  status: FulfillmentStatus;
  failureCode: string | null;
  message: string | null;
  accountEmailMasked: string | null;
  sessionPayload: EncryptedPayload;
  mode: FulfillmentMode;
  voucherId: string | null;
  upstreamProvider: string | null;
  upstreamOrderId: string | null;
  upstreamClientRequestId: string;
  upstreamLookupToken: string | null;
  upstreamStatus: string | null;
  upstreamStage: string | null;
    upstreamQuoteMinor: number | null;
    upstreamChargedMinor?: number | null;
    upstreamCardLastFour?: string | null;
  upstreamCurrency: string | null;
  nextCheckAt: Date;
  leaseToken?: string | null;
  leaseUntil?: Date | null;
  lookupPayload?: EncryptedPayload;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface CdkVoucher {
  id: string;
  merchantId: string;
  orderId: string;
  publicCode: string;
  plan: string;
  status: VoucherStatus;
  upstreamProvider: string;
  upstreamCdkId: string | null;
  upstreamCodePayload: EncryptedPayload;
  issueAttempts: number;
  issueLeaseToken?: string | null;
  nextAttemptAt: Date;
  failureCode: string | null;
  createdAt: Date;
  consumedAt: Date | null;
}

export interface SupplierWebhookEvent {
  eventId: string;
  eventType: string;
  clientRequestId: string | null;
  payloadHash: string;
  status: "received" | "processed" | "failed";
  receivedAt: Date;
  processedAt: Date | null;
}

export interface SupplierConnection {
  id: string;
  name: string;
  provider: "zovocard";
  environment: "sandbox" | "production";
  openApiBase: string;
  cdkBase: string;
  enabled: boolean;
  secretPayload: EncryptedPayload;
  configVersion: number;
  lastTestStatus: "never" | "succeeded" | "failed";
  lastTestMessage: string | null;
  lastTestAt: Date | null;
  lastPlanSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierPlanSnapshot {
  connectionId: string;
  product: "gpt" | "claude" | "grok";
  plan: string;
  accPlanKey: string;
  name: string;
  enabled: boolean;
  purchasable: boolean;
  serviceFeeUsdMinor: number | null;
  checkoutAmountMinor?: number | null;
  checkoutCurrency?: string | null;
  quoteUsdMinor?: number | null;
  pricingVersion: number | null;
  syncedAt: Date;
}

export interface SupplierProductMapping {
  productCode: string;
  connectionId: string;
  fulfillmentMode: FulfillmentMode;
  supplierProduct: "gpt" | "claude" | "grok";
  supplierPlan: string;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Refund {
  id: string;
  merchantId: string;
  orderId: string;
  merchantRefundNo: string;
  type: RefundType;
  amountMinor: bigint;
  status: RefundStatus;
  reason: string;
  failureCode: string | null;
  providerRefundNo?: string | null;
  nextCheckAt?: Date | null;
  recoveryAttempts?: number;
  createdAt: Date;
  refundedAt: Date | null;
}

export type PublicLedgerType =
  | "user_payment"
  | "supply_price"
  | "ordinary_refund"
  | "price_adjustment_refund"
  | "merchant_margin"
  | "merchant_pending_settlement"
  | "settlement_transfer"
  | "settlement_adjustment";

export interface LedgerItem {
  id: string;
  merchantId: string;
  orderId: string;
  type: PublicLedgerType;
  amountMinor: bigint;
  direction: "increase" | "decrease";
  occurredAt: Date;
}

export interface SettlementLine {
  id: string;
  merchantId: string;
  orderId: string;
  sourceType: "merchant_margin" | "settlement_adjustment";
  sourceId: string;
  amountMinor: bigint;
  originalSettlementLineId: string | null;
}

export interface Settlement {
  id: string;
  merchantId: string;
  periodFrom: Date;
  periodTo: Date;
  status: SettlementStatus;
  grossMinor: bigint;
  adjustmentMinor: bigint;
  payableMinor: bigint;
  currency: "CNY";
  sealedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
  lines: SettlementLine[];
}

export interface OutboxEvent {
  id: string;
  merchantId: string;
  eventKey: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface WebhookEndpoint {
  id: string;
  merchantId: string;
  url: string;
  secret: string;
  subscribedEvents: string[];
  status: "active" | "disabled";
}

export interface WebhookDelivery {
  id: string;
  merchantId: string;
  outboxEventId: string;
  endpointId: string;
  status: "pending" | "delivering" | "delivered" | "dead_letter";
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
  responseStatus: number | null;
}

export interface AuditLog {
  id: string;
  merchantId: string | null;
  actorType: "partner_api" | "merchant_user" | "platform_user" | "system";
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  createdAt: Date;
}

export interface IdempotencyRecord {
  merchantId: string;
  appId: string;
  routeKey: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  state?: "processing" | "completed";
  leaseToken?: string | null;
  leaseUntil?: Date | null;
}
