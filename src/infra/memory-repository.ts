import type {
  ApiKey,
  AuditLog,
  CdkVoucher,
  Fulfillment,
  IdempotencyRecord,
  LedgerItem,
  Merchant,
  MerchantRole,
  MerchantUser,
  Order,
  OutboxEvent,
  PartnerApp,
  PaymentAttempt,
  ProductGrant,
  Refund,
  Settlement,
  SupplierConnection,
  SupplierPlanSnapshot,
  SupplierProductMapping,
  SupplierWebhookEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from "../domain/model.js";
import type { ClaimedWebhookDelivery, CredentialBundle, Repository } from "./repository.js";
import type {OperationsRecords} from "../operations/model.js";
import {formatPublicOrderNo} from "../domain/public-order-no.js";

export class MemoryRepository implements Repository {
  private readonly nonces = new Map<string, number>();
  consumeNonce(key: string, expiresAt: number, now: number): boolean {
    for (const [id, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(id);
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt);
    return true;
  }
  private readonly operations = new Map<string, OperationsRecords[keyof OperationsRecords]>();
  findMerchantById(id: string): Merchant | null { return copyOrNull(this.merchants.get(id)); }
  listMerchants(): Merchant[] { return [...this.merchants.values()].map(clone); }
  listApps(merchantId: string): PartnerApp[] { return [...this.apps.values()].filter(a => a.merchantId === merchantId).map(clone); }
  getOperations<K extends keyof OperationsRecords>(kind: K, id: string): OperationsRecords[K] | null {
    return copyOrNull(this.operations.get(kind + ":" + id)) as OperationsRecords[K] | null;
  }
  listOperations<K extends keyof OperationsRecords>(kind: K, merchantId?: string): OperationsRecords[K][] {
    return [...this.operations.entries()].filter(([key, value]) => key.startsWith(kind + ":") && (merchantId === undefined || value.merchantId === merchantId)).map(([, value]) => clone(value)) as OperationsRecords[K][];
  }
  saveOperations<K extends keyof OperationsRecords>(kind: K, value: OperationsRecords[K], insertOnly = false): void {
    const key = kind + ":" + value.id;
    if ((insertOnly || kind === "wallet_entry" || kind === "ticket_message") && this.operations.has(key)) throw new Error("immutable_record_exists");
    this.operations.set(key, clone(value));
  }
  private readonly merchants = new Map<string, Merchant>();
  private readonly merchantRoles = new Map<string, MerchantRole>();
  private readonly merchantUsers = new Map<string, MerchantUser>();
  private readonly apps = new Map<string, PartnerApp>();
  private readonly keys = new Map<string, ApiKey>();
  private readonly grants = new Map<string, ProductGrant>();
  private readonly orders = new Map<string, Order>();
  private readonly paymentAttempts = new Map<string, PaymentAttempt>();
  private readonly fulfillments = new Map<string, Fulfillment>();
  private readonly cdkVouchers = new Map<string, CdkVoucher>();
  private readonly supplierWebhookEvents = new Map<string, SupplierWebhookEvent>();
  private readonly supplierConnections = new Map<string, SupplierConnection>();
  private readonly supplierPlans = new Map<string, SupplierPlanSnapshot>();
  private readonly supplierMappings = new Map<string, SupplierProductMapping>();
  private readonly refunds = new Map<string, Refund>();
  private readonly settlements = new Map<string, Settlement>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly ledger: LedgerItem[] = [];
  private readonly outbox: OutboxEvent[] = [];
  private readonly webhookEndpoints = new Map<string, WebhookEndpoint>();
  private readonly webhookDeliveries = new Map<string, WebhookDelivery>();
  private readonly audit: AuditLog[] = [];
  private readonly sequences = new Map<string, bigint>();

  allocatePublicOrderNo(): string {
    const current = this.sequences.get("public_order_no") ?? 0n;
    const next = current + 1n;
    this.sequences.set("public_order_no", next);
    return formatPublicOrderNo(next);
  }

  transaction<T>(action: () => T): T {
    const snapshots = Object.values(this).filter((value) => value instanceof Map || Array.isArray(value))
      .map((value) => ({value, snapshot: structuredClone(value)}));
    try {
      const result = action();
      if (result instanceof Promise) throw new Error("repository_transaction_must_be_synchronous");
      return result;
    } catch (error) {
      for (const {value, snapshot} of snapshots) {
        if (value instanceof Map) {
          value.clear();
          for (const [key, item] of snapshot) value.set(key, item);
        } else value.splice(0, value.length, ...snapshot);
      }
      throw error;
    }
  }

  saveMerchant(value: Merchant): void {
    this.merchants.set(value.id, clone(value));
  }

  saveMerchantRole(value: MerchantRole): void {
    this.merchantRoles.set(value.id, clone(value));
  }

  saveMerchantUser(value: MerchantUser): void {
    this.merchantUsers.set(value.id, clone(value));
  }

  findMerchantRole(merchantId: string, roleId: string): MerchantRole | null {
    const value = this.merchantRoles.get(roleId);
    return value?.merchantId === merchantId ? clone(value) : null;
  }

  findMerchantUser(merchantId: string, userId: string): MerchantUser | null {
    return copyOrNull([...this.merchantUsers.values()].find((item) => item.merchantId === merchantId && item.userId === userId));
  }

  saveApp(value: PartnerApp): void {
    this.apps.set(value.id, clone(value));
  }

  saveKey(value: ApiKey): void {
    for (const current of this.keys.values()) {
      if (current.keyId === value.keyId && current.id !== value.id) throw new Error("duplicate_key_id");
    }
    this.keys.set(value.id, clone(value));
  }

  findMerchantByPartner(partnerId: string): Merchant | null {
    return copyOrNull([...this.merchants.values()].find((item) => item.partnerId === partnerId));
  }

  findCredential(partnerId: string, keyId: string): CredentialBundle | null {
    const merchant = [...this.merchants.values()].find((item) => item.partnerId === partnerId);
    if (!merchant) return null;
    const key = [...this.keys.values()].find((item) => item.merchantId === merchant.id && item.keyId === keyId);
    if (!key) return null;
    const app = this.apps.get(key.appId);
    if (!app || app.merchantId !== merchant.id) return null;
    return {merchant: clone(merchant), app: clone(app), key: clone(key)};
  }

  saveProductGrant(value: ProductGrant): void {
    this.grants.set(`${value.merchantId}:${value.productCode}`, clone(value));
  }

  listProductGrants(merchantId: string): ProductGrant[] {
    return [...this.grants.values()].filter((item) => item.merchantId === merchantId).map(clone);
  }

  findProductGrant(merchantId: string, productCode: string): ProductGrant | null {
    return copyOrNull(this.grants.get(`${merchantId}:${productCode}`));
  }

  insertOrder(value: Order): void {
    if (this.orders.has(value.id)) throw new Error("duplicate_order_id");
    if (this.findOrderByMerchantNo(value.merchantId, value.merchantOrderNo)) throw new Error("duplicate_merchant_order_no");
    this.orders.set(value.id, clone(value));
  }

  updateOrder(value: Order): void {
    const current = this.orders.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("order_not_found");
    this.orders.set(value.id, clone(value));
  }

  findOrder(merchantId: string, orderId: string): Order | null {
    const value = this.orders.get(orderId);
    return value?.merchantId === merchantId ? clone(value) : null;
  }

  findOrderInternal(orderId: string): Order | null {
    return copyOrNull(this.orders.get(orderId));
  }

  findOrderByMerchantNo(merchantId: string, merchantOrderNo: string): Order | null {
    return copyOrNull([...this.orders.values()].find((item) => item.merchantId === merchantId && item.merchantOrderNo === merchantOrderNo));
  }

  listOrders(merchantId: string): Order[] {
    return [...this.orders.values()]
      .filter((item) => item.merchantId === merchantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  listOrdersInternal(): Order[] {
    return [...this.orders.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }

  findOrdersInternal(ids:readonly string[]):Order[] {
    return [...new Set(ids)].flatMap(id=>this.orders.get(id)??[]).map(clone);
  }

  insertPaymentAttempt(value: PaymentAttempt): void {
    if (this.paymentAttempts.has(value.id)) throw new Error("duplicate_payment_attempt_id");
    this.paymentAttempts.set(value.id, clone(value));
  }

  updatePaymentAttempt(value: PaymentAttempt): void {
    const current = this.paymentAttempts.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("payment_attempt_not_found");
    this.paymentAttempts.set(value.id, clone(value));
  }

  findPaymentAttemptByOrder(merchantId: string, orderId: string): PaymentAttempt | null {
    return copyOrNull([...this.paymentAttempts.values()].find((item) => item.merchantId === merchantId && item.orderId === orderId));
  }

  insertFulfillment(value: Fulfillment): void {
    if (this.fulfillments.has(value.id)) throw new Error("duplicate_fulfillment_id");
    this.fulfillments.set(value.id, clone(value));
  }

  updateFulfillment(value: Fulfillment): void {
    const current = this.fulfillments.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("fulfillment_not_found");
    this.fulfillments.set(value.id, clone(value));
  }

  findFulfillment(merchantId: string, fulfillmentId: string): Fulfillment | null {
    const value = this.fulfillments.get(fulfillmentId);
    return value?.merchantId === merchantId ? clone(value) : null;
  }

  listFulfillments(merchantId: string, orderId: string): Fulfillment[] {
    return [...this.fulfillments.values()]
      .filter((item) => item.merchantId === merchantId && item.orderId === orderId)
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map(clone);
  }

  listProcessableFulfillments(limit: number, now: Date): Fulfillment[] {
    return [...this.fulfillments.values()]
      .filter((item) => ["queued", "running"].includes(item.status) && (item.nextCheckAt ?? item.createdAt) <= now)
      .sort((a, b) => (a.nextCheckAt ?? a.createdAt).getTime() - (b.nextCheckAt ?? b.createdAt).getTime())
      .slice(0, limit)
      .map(clone);
  }

  findFulfillmentByUpstreamClientRequestId(clientRequestId: string): Fulfillment | null {
    return copyOrNull([...this.fulfillments.values()].find((item) => item.upstreamClientRequestId === clientRequestId));
  }

  insertCdkVoucher(value: CdkVoucher): void {
    if (this.cdkVouchers.has(value.id)) throw new Error("duplicate_cdk_voucher_id");
    if (this.findCdkVoucherByOrder(value.orderId)) throw new Error("duplicate_cdk_voucher_order");
    if (this.findCdkVoucherByPublicCode(value.publicCode)) throw new Error("duplicate_cdk_public_code");
    this.cdkVouchers.set(value.id, clone(value));
  }

  updateCdkVoucher(value: CdkVoucher): void {
    const current = this.cdkVouchers.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("cdk_voucher_not_found");
    this.cdkVouchers.set(value.id, clone(value));
  }

  findCdkVoucherById(voucherId: string): CdkVoucher | null {
    return copyOrNull(this.cdkVouchers.get(voucherId));
  }

  findCdkVoucherByOrder(orderId: string): CdkVoucher | null {
    return copyOrNull([...this.cdkVouchers.values()].find((item) => item.orderId === orderId));
  }

  findCdkVoucherByPublicCode(publicCode: string): CdkVoucher | null {
    const normalized = publicCode.trim().toUpperCase();
    return copyOrNull([...this.cdkVouchers.values()].find((item) => item.publicCode === normalized));
  }

  insertSupplierWebhookEvent(value: SupplierWebhookEvent): void {
    if (this.supplierWebhookEvents.has(value.eventId)) throw new Error("duplicate_supplier_webhook_event");
    this.supplierWebhookEvents.set(value.eventId, clone(value));
  }

  updateSupplierWebhookEvent(value: SupplierWebhookEvent): void {
    if (!this.supplierWebhookEvents.has(value.eventId)) throw new Error("supplier_webhook_event_not_found");
    this.supplierWebhookEvents.set(value.eventId, clone(value));
  }

  findSupplierWebhookEvent(eventId: string): SupplierWebhookEvent | null {
    return copyOrNull(this.supplierWebhookEvents.get(eventId));
  }

  saveSupplierConnection(value: SupplierConnection): void {
    this.supplierConnections.set(value.id, clone(value));
  }

  findSupplierConnection(connectionId: string): SupplierConnection | null {
    return copyOrNull(this.supplierConnections.get(connectionId));
  }

  findEnabledSupplierConnection(): SupplierConnection | null {
    return copyOrNull([...this.supplierConnections.values()].find((item) => item.enabled));
  }

  replaceSupplierPlanSnapshots(connectionId: string, product: SupplierPlanSnapshot["product"], values: SupplierPlanSnapshot[]): void {
    for (const [key, value] of this.supplierPlans) {
      if (value.connectionId === connectionId && value.product === product) this.supplierPlans.delete(key);
    }
    for (const value of values) this.supplierPlans.set(`${value.connectionId}:${value.product}:${value.plan}`, clone(value));
  }

  listSupplierPlanSnapshots(connectionId: string): SupplierPlanSnapshot[] {
    return [...this.supplierPlans.values()].filter((item) => item.connectionId === connectionId).map(clone);
  }

  saveSupplierProductMapping(value: SupplierProductMapping): void {
    this.supplierMappings.set(value.productCode, clone(value));
  }

  findSupplierProductMapping(productCode: string): SupplierProductMapping | null {
    return copyOrNull(this.supplierMappings.get(productCode));
  }

  listSupplierProductMappings(): SupplierProductMapping[] {
    return [...this.supplierMappings.values()].map(clone);
  }

  insertRefund(value: Refund): void {
    if (this.refunds.has(value.id)) throw new Error("duplicate_refund_id");
    if (this.findRefundByMerchantNo(value.merchantId, value.merchantRefundNo)) throw new Error("duplicate_merchant_refund_no");
    this.refunds.set(value.id, clone(value));
  }

  updateRefund(value: Refund): void {
    const current = this.refunds.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("refund_not_found");
    this.refunds.set(value.id, clone(value));
  }

  findRefund(merchantId: string, refundId: string): Refund | null {
    const value = this.refunds.get(refundId);
    return value?.merchantId === merchantId ? clone(value) : null;
  }

  findRefundByMerchantNo(merchantId: string, merchantRefundNo: string): Refund | null {
    return copyOrNull([...this.refunds.values()].find((item) => item.merchantId === merchantId && item.merchantRefundNo === merchantRefundNo));
  }

  listRefundsForOrder(merchantId: string, orderId: string): Refund[] {
    return [...this.refunds.values()].filter((item) => item.merchantId === merchantId && item.orderId === orderId).map(clone);
  }

  appendLedger(items: LedgerItem[]): void {
    this.ledger.push(...items.map(clone));
  }

  listLedger(merchantId: string): LedgerItem[] {
    return this.ledger.filter((item) => item.merchantId === merchantId).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).map(clone);
  }

  insertSettlement(value: Settlement): void {
    if (this.settlements.has(value.id)) throw new Error("duplicate_settlement_id");
    this.settlements.set(value.id, clone(value));
  }

  updateSettlement(value: Settlement): void {
    const current = this.settlements.get(value.id);
    if (!current || current.merchantId !== value.merchantId) throw new Error("settlement_not_found");
    if (["confirmed", "paying", "paid", "failed"].includes(current.status)) {
      if (JSON.stringify(serializeLines(current.lines)) !== JSON.stringify(serializeLines(value.lines))) throw new Error("sealed_settlement_is_immutable");
      if (current.grossMinor !== value.grossMinor || current.adjustmentMinor !== value.adjustmentMinor || current.payableMinor !== value.payableMinor) {
        throw new Error("sealed_settlement_is_immutable");
      }
    }
    this.settlements.set(value.id, clone(value));
  }

  findSettlement(merchantId: string, settlementId: string): Settlement | null {
    const value = this.settlements.get(settlementId);
    return value?.merchantId === merchantId ? clone(value) : null;
  }

  listSettlements(merchantId: string): Settlement[] {
    return [...this.settlements.values()].filter((item) => item.merchantId === merchantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(clone);
  }

  appendOutbox(value: OutboxEvent): void {
    if (this.outbox.some((item) => item.eventKey === value.eventKey)) return;
    this.outbox.push(clone(value));
  }

  listOutbox(merchantId: string): OutboxEvent[] {
    return this.outbox.filter((item) => item.merchantId === merchantId).map(clone);
  }

  saveWebhookEndpoint(value: WebhookEndpoint): void {
    this.webhookEndpoints.set(value.id, clone(value));
  }

  listWebhookEndpoints(merchantId: string): WebhookEndpoint[] {
    return [...this.webhookEndpoints.values()].filter((item) => item.merchantId === merchantId).map(clone);
  }

  insertWebhookDelivery(value: WebhookDelivery): void {
    if (this.webhookDeliveries.has(value.id)) return;
    this.webhookDeliveries.set(value.id, clone(value));
  }

  claimWebhookDeliveries(limit: number, leaseUntil: Date): ClaimedWebhookDelivery[] {
    const now = new Date();
    const due = [...this.webhookDeliveries.values()]
      .filter((item) => (item.status === "pending" && item.nextAttemptAt <= now) || (item.status === "delivering" && item.leaseUntil !== null && item.leaseUntil <= now))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    const claimed: ClaimedWebhookDelivery[] = [];
    for (const item of due) {
      const delivery = {...item, status: "delivering" as const, leaseUntil, attemptCount: item.attemptCount + 1};
      this.webhookDeliveries.set(delivery.id, clone(delivery));
      const endpoint = this.webhookEndpoints.get(delivery.endpointId);
      const event = this.outbox.find((candidate) => candidate.id === delivery.outboxEventId);
      if (endpoint && event) claimed.push({delivery: clone(delivery), endpoint: clone(endpoint), event: clone(event)});
    }
    return claimed;
  }

  markWebhookDelivered(deliveryId: string, responseStatus: number, deliveredAt: Date): void {
    const current = this.webhookDeliveries.get(deliveryId);
    if (!current) throw new Error("webhook_delivery_not_found");
    this.webhookDeliveries.set(deliveryId, {...current, status: "delivered", responseStatus, deliveredAt, leaseUntil: null, lastErrorCode: null});
  }

  rescheduleWebhookDelivery(deliveryId: string, nextAttemptAt: Date | null, errorCode: string): void {
    const current = this.webhookDeliveries.get(deliveryId);
    if (!current) throw new Error("webhook_delivery_not_found");
    this.webhookDeliveries.set(deliveryId, {
      ...current,
      status: nextAttemptAt ? "pending" : "dead_letter",
      nextAttemptAt: nextAttemptAt ?? current.nextAttemptAt,
      leaseUntil: null,
      lastErrorCode: errorCode,
    });
  }

  appendAudit(value: AuditLog): void {
    this.audit.push(clone(value));
  }

  listAudit(merchantId: string): AuditLog[] {
    return this.audit.filter((item) => item.merchantId === merchantId).map(clone);
  }

  getIdempotency(merchantId: string, appId: string, routeKey: string, key: string): IdempotencyRecord | null {
    return copyOrNull(this.idempotency.get(idempotencyKey(merchantId, appId, routeKey, key)));
  }

  saveIdempotency(value: IdempotencyRecord): void {
    this.idempotency.set(idempotencyKey(value.merchantId, value.appId, value.routeKey, value.key), clone(value));
  }

  close(): void {}
}

function idempotencyKey(merchantId: string, appId: string, routeKey: string, key: string): string {
  return `${merchantId}:${appId}:${routeKey}:${key}`;
}

function copyOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function serializeLines(lines: Settlement["lines"]): unknown {
  return lines.map((line) => ({...line, amountMinor: line.amountMinor.toString()}));
}
