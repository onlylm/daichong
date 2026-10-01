export const accountRoles = ["platform_admin", "platform_support", "platform_finance", "platform_auditor", "agent_owner", "agent_staff", "agent_finance"] as const;
export type AccountRole = typeof accountRoles[number];
export type CollectionMode = "platform_collect" | "agent_collect";
export const orderVisibilityFields = ["result_code", "result_stage", "card_last_four", "charge_amount", "upstream_order_id"] as const;
export type OrderVisibilityField = typeof orderVisibilityFields[number];
/** Downstream agents/API consumers see platform CDK and status only unless platform opts in per field. */
export const defaultOrderVisibility: OrderVisibilityField[] = [];
export interface BaseRecord {id: string; merchantId: string | null}
export interface Account extends BaseRecord {
  username: string; displayName: string; role: AccountRole; status: "active" | "disabled";
  passwordHash: string; authVersion: number; failedLogins: number; lockedUntil: Date | null;
  mfaEnabled?: boolean; mfaSecret?: import("../domain/model.js").EncryptedPayload | null;
  mfaRecoveryCodeHashes?: string[]; mfaLastUsedStep?: number | null;
  mustChangePassword: boolean; createdAt: Date; updatedAt: Date;
}
export interface Actor {id: string; merchantId: string | null; role: AccountRole | "agent_api"}
export interface LoginSession extends BaseRecord {accountId: string; authVersion: number; expiresAt: Date; createdAt: Date}
export interface LoginThrottle extends BaseRecord {count: number; expiresAt: Date}
export interface MfaChallenge extends BaseRecord {
  accountId: string; purpose: "enroll" | "login"; encryptedSecret: import("../domain/model.js").EncryptedPayload | null;
  authVersion: number; failedAttempts: number; expiresAt: Date; createdAt: Date;
}
export interface AgentProfile extends BaseRecord {
  merchantId: string; tier: string; collectionModes: CollectionMode[]; customRedemptionEnabled?: boolean;
  /** Allows the signed partner backend to fetch a provider payment code for local display. */
  directPaymentCodeEnabled?: boolean;
  /** 2–8 chars; injected into the controlled public CDK template. */
  cdkCodePrefix?: string;
  /** Controlled template containing one `{PREFIX}` and at least 20 random hexadecimal chars. */
  cdkCodeTemplate?: string;
  orderVisibility?: OrderVisibilityField[]; version: number; updatedAt: Date;
}
export interface TierLevel {
  code: string; name: string; threshold: bigint;
  supplyDiscountBps?: number; maxStaffAccounts?: number; apiIncluded?: boolean;
  collectionModes?: CollectionMode[]; benefits?: string[];
  /** Minimum procurement wallet balance (minor units, string) required to apply for this tier. */
  minDepositMinor?: string;
  /** Minimum share of completed supply via agent_collect, in basis points (1500 = 15%). */
  minAgentCollectShareBps?: number;
  /** productCode -> supply price in minor units (string for persistence). */
  productSupplyPrices?: Record<string, string>;
}
export interface TierRules extends BaseRecord {
  version: number; metric: "supply_amount" | "completed_orders"; enabled: boolean;
  levels: TierLevel[]; updatedAt: Date;
}
export interface GlobalProductEntry {
  productCode: string; name: string; supplyPriceMinor: bigint; available: boolean; priceVersion: number;
  refundBenchmarkUsdMinor?: bigint | null; refundBenchmarkAt?: string;
  /** Legacy storage only; not actual costs. New orders use refundBenchmarkUsdMinor. */
  standardCostUsdMinor?: bigint | null; standardCostCnyMinor?: bigint | null; retainedFeeUsdMinor?: bigint;
  standardCostSource?: "operator_verified_baseline" | "upstream_usd_quote";
  standardCostAt?: string;
}
export interface DailySettlementStatement extends BaseRecord {
  merchantId: string; businessDate: string; periodFrom: Date; periodTo: Date;
  status: "pending_payment" | "paid" | "reconciled" | "no_payable" | "disputed" | "voided";
  orderIds: string[]; orderCount: number;
  supplyAmountMinor: bigint; agentEarningsMinor: bigint; platformCostMinor: bigint; platformProfitMinor: bigint;
  payableMinor: bigint; currency: "CNY";
  payoutMethod: "alipay" | "bank" | "other" | null; payoutReference: string | null;
  payoutEvidence: string | null; note: string | null; confirmedBy: string | null;
  version: number; generatedAt: Date; paidAt: Date | null; reconciledAt: Date | null; updatedAt: Date;
}
export interface GlobalProductCatalog extends BaseRecord {
  version: number; products: GlobalProductEntry[]; updatedAt: Date;
}
export interface Ticket extends BaseRecord {
  archivedAt?: Date; archiveReason?: string; archivedBy?: string;
  merchantId: string; orderId: string | null; category: "payment" | "cdk" | "recharge" | "refund" | "wallet" | "other" | "tier_application" | "api_application";
  apiApplication?: {requestKey: string; depositId: string; status: "pending" | "approved" | "rejected"; reviewReason: string | null};
  tierApplication?: {targetTier: string; previousTier: string; profileVersion: number; rulesVersion: number; requestKey: string;
    status: "pending" | "approved" | "rejected"; reviewReason: string | null; reviewedBy: string | null};
  withdrawalApplication?: {
    withdrawalId: string; amountMinor: bigint; requestKey: string;
    payoutMethod: "alipay" | "bank"; payoutAccount: string; payoutName: string;
    status: "requested" | "approved" | "paid" | "rejected"; reviewReason: string | null;
  };
  title: string; status: "open" | "in_progress" | "waiting_agent" | "resolved" | "closed";
  systemCase?: {issueKey: string; entityId: string}; priority?: "normal" | "urgent"; dueAt?: Date;
  assigneeId: string | null; version: number; publicVersion: number; createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface TicketMessage extends BaseRecord {merchantId: string; ticketId: string; actorId: string; author: "agent" | "platform"; internal: boolean; body: string; createdAt: Date}
export interface TicketRead extends BaseRecord {ticketId: string; accountId: string; version: number}
/** Business exception state. It is deliberately independent from support conversations. */
export interface OperationalIssue extends BaseRecord {
  merchantId: string; orderId: string; entityId: string; kind: "recharge" | "cdk" | "refund";
  status: "open" | "resolved"; severity: "normal" | "urgent"; reason: string; retryAllowed: boolean;
  attentionKey: string; dueAt: Date; firstDetectedAt: Date; updatedAt: Date; resolvedAt: Date | null;
  legacyTicketIds: string[];
}
export interface Announcement extends BaseRecord {
  title: string; body: string; status: "draft" | "published" | "withdrawn"; version: number;
  audience: "all" | "merchants" | "tiers"; merchantIds: string[]; tierCodes: string[];
  pinned: boolean; startsAt: Date; endsAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface AnnouncementRead extends BaseRecord {announcementId: string; accountId: string; version: number; readAt: Date}
export interface WalletEntry extends BaseRecord {
  reason?: string; adjustmentAccount?: "procurement" | "earnings"; beforeMinor?: bigint; afterMinor?: bigint;
  merchantId: string; kind: "adjustment" | "deposit" | "purchase" | "purchase_refund" | "earning_release" | "earning_reversal" | "transfer" | "withdraw_hold" | "withdraw_release" | "withdraw_paid" | "settlement_payout";
  procurementDelta: bigint; earningsDelta: bigint; frozenDelta: bigint; reference: string; actorId: string; createdAt: Date;
}
export interface WalletDeposit extends BaseRecord {
  merchantId: string; amountMinor: bigint; status: "requested" | "credited" | "expired" | "closed" | "rejected"; requestKey: string;
  payerReference: string; verifiedReference: string | null; reviewerId: string | null; createdAt: Date; updatedAt: Date;
  paymentProvider?: "manual" | "alipay_page"; paymentConfigId?: string | null; providerRef?: string | null;
  expiresAt?: Date | null; paidAt?: Date | null; nextCheckAt?: Date | null;
}
export interface WalletWithdrawal extends BaseRecord {
  merchantId: string; amountMinor: bigint; status: "requested" | "approved" | "paid" | "rejected"; requestKey: string;
  requestedBy: string; reviewerId: string | null; payoutReference: string | null; reason: string;
  payoutMethod?: "alipay" | "bank"; payoutAccount?: string; payoutName?: string;
  createdAt: Date; updatedAt: Date;
}
export interface WalletCredit extends BaseRecord {merchantId: string; orderId: string; recognizedMinor: bigint; createdAt: Date}
/**
 * A provider trade query only proves a cumulative refunded amount. Until an
 * exact provider refund request is bound to the local ledger, the difference
 * is a finance reconciliation fact rather than a support ticket.
 */
export interface RefundReconciliation extends BaseRecord {
  merchantId: string; orderId: string; provider: "alipay_page";
  status: "reviewing" | "resolved";
  reportedMinor: bigint; recordedMinor: bigint; differenceMinor: bigint;
  providerReferenceFingerprint: string;
  /** Historical system tickets are retained for traceability, never used as business state. */
  legacyTicketIds: string[];
  version: number; firstDetectedAt: Date; lastCheckedAt: Date; resolvedAt: Date | null;
}
export interface RefundReconciliationEvent extends BaseRecord {
  merchantId: string; reconciliationId: string; orderId: string;
  action: "detected" | "amount_updated" | "reopened" | "resolved" | "legacy_ticket_migrated";
  reportedMinor: bigint; recordedMinor: bigint; differenceMinor: bigint;
  createdAt: Date;
}
export interface InvoiceApplication extends BaseRecord {
  merchantId: string; orderId: string; requestKey: string;
  titleType: "enterprise"; invoiceTitle: string;
  taxIdEncrypted: import("../domain/model.js").EncryptedPayload;
  recipientEmail: string; contactName: string; contactPhone: string | null; remark: string | null;
  /** The face value requested by the agent for its customer. It is not the Quefa order settlement amount. */
  invoiceAmountMinor: bigint; feeRateBps: 500; feeAmountMinor: bigint; category: "技术服务费";
  status: "awaiting_payment" | "submitted" | "processing" | "needs_correction" | "issued";
  paymentId: string | null; providerRef: string | null; paidAt: Date | null; submittedAt: Date | null;
  reviewNote: string | null; invoiceNo: string | null; issuedAt: Date | null;
  version: number; createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface InvoiceFeePayment extends BaseRecord {
  merchantId: string; applicationId: string; amountMinor: bigint;
  status: "pending" | "paid" | "expired" | "closed"; paymentConfigId: string | null;
  qrPayload: string | null; providerRef: string | null; expiresAt: Date; nextCheckAt: Date | null;
  paidAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface ApiAccess extends BaseRecord {merchantId: string; enabled: boolean; depositId: string; ticketId: string; version: number; updatedAt: Date}
export type PaymentChannel = "alipay_page" | "dujiaopay";
export interface PaymentSettings extends BaseRecord {
  channel: PaymentChannel; version: number; draftId: string | null; activeId: string | null; paused: boolean; updatedAt: Date;
}
export interface PaymentRevision extends BaseRecord {
  channel: PaymentChannel; details: Record<string, string>; fingerprint: string;
  encrypted: import("../domain/model.js").EncryptedPayload; createdAt: Date;
}
export interface PaymentCheck extends BaseRecord {revisionId: string; checkedAt: string; kind: "local_keys" | "remote_identity"}
export interface CryptoPayment extends BaseRecord {
  merchantId: string; orderId: string; revisionId: string; providerOrderId: string | null;
  state: "creating" | "pending" | "review" | "paid" | "expired" | "canceled";
  address: string | null; payableAmount: string | null; chain: string; tokenId: string;
  expiresAt: Date; nextCheckAt: Date; leaseUntil: Date | null; leaseToken: string | null; createdAt: Date; updatedAt: Date;
  failureCode: string | null; txHash?: string; settledAmount?: string; fxRate?: string; paidSource?: string;
}
export interface PaymentEvent extends BaseRecord {revisionId: string; eventId: string; digest: string; orderId: string | null; createdAt: Date}
export interface CryptoTransaction extends BaseRecord {orderId: string; chain: string; txHash: string; createdAt: Date}
export interface OperationsRecords {
  order_cost: OrderCost; cost_saving_payment: CostSavingPayment;
  service_checkpoint: ServiceCheckpoint; worker_health: WorkerHealth;
  account: Account; session: LoginSession; login_throttle: LoginThrottle; mfa_challenge: MfaChallenge; agent_profile: AgentProfile; tier_rules: TierRules; global_product_catalog: GlobalProductCatalog;
  ticket: Ticket; ticket_message: TicketMessage; ticket_read: TicketRead; announcement: Announcement; announcement_read: AnnouncementRead;
  operational_issue: OperationalIssue;
  wallet_entry: WalletEntry; wallet_deposit: WalletDeposit; wallet_withdrawal: WalletWithdrawal; wallet_credit: WalletCredit;
  refund_reconciliation: RefundReconciliation; refund_reconciliation_event: RefundReconciliationEvent;
  invoice_application: InvoiceApplication; invoice_fee_payment: InvoiceFeePayment;
  daily_settlement: DailySettlementStatement;
  api_access: ApiAccess;
  payment_settings: PaymentSettings; payment_revision: PaymentRevision; payment_check: PaymentCheck;
  crypto_payment: CryptoPayment; payment_event: PaymentEvent; crypto_transaction: CryptoTransaction;
}

/** Internal finance, deliberately separate from customer refunds and agent earnings. */
export interface OrderCost extends BaseRecord {
  merchantId: string; orderId: string; upstreamOrderId: string | null;
  standardUsdMinor: bigint | null; standardCnyMinor: bigint | null; retainedUsdMinor: bigint;
  actualUsdMinor: bigint | null; additionalFeesUsdMinor: bigint; fxRate: string | null;
  sourceReference: string | null; evidence: string | null; source: "manual_verified" | null;
  status: "pending_review" | "confirmed" | "disputed";
  destination: "customer_direct" | "platform_pass_through" | null;
  paidUsdMinor: bigint; customerReceipt: "pending" | "confirmed";
  customerReceiptEvidence?: string;
  nativeAmountMinor: number | null; nativeCurrency: string | null;
  tradeCandidate?: import("../upstream/cost-facts.js").TradeCostCandidate | null;
  tradeMatchIssue?: string | null;
  upstreamCheckedAt: Date | null; nextCheckAt: Date | null;
  version: number; createdBy: string; reviewedBy: string | null; createdAt: Date; updatedAt: Date;
}
export interface CostSavingPayment extends BaseRecord {
  merchantId: string; orderId: string; costId: string; destination: NonNullable<OrderCost["destination"]>;
  usdMinor: bigint; paymentCurrency: "USD" | "CNY"; paymentMinor: bigint; fxRate: string | null;
  method: string; reference: string; evidence: string; requestKey: string; actorId: string; createdAt: Date;
}

export interface ServiceCheckpoint extends BaseRecord {createdAt: Date; afterId?: string | null}

export interface WorkerLaneHealth {
  name: string;
  inFlight: boolean;
  totalRuns: number;
  consecutiveFailures: number;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  /** Stable internal category only. Never persist an SDK/upstream error message. */
  lastErrorCode: "task_failed" | null;
}

/** Durable API/Worker cross-process heartbeat used for operations monitoring. */
export interface WorkerHealth extends BaseRecord {
  instanceId: string;
  state: "running" | "stopping";
  startedAt: Date;
  heartbeatAt: Date;
  lanes: WorkerLaneHealth[];
}
