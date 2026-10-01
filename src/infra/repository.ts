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

export interface CredentialBundle {
  merchant: Merchant;
  app: PartnerApp;
  key: ApiKey;
}

export interface ClaimedWebhookDelivery {
  delivery: WebhookDelivery;
  endpoint: WebhookEndpoint;
  event: OutboxEvent;
}

export interface Repository {
  queryRecords?<K extends keyof import('./record-query.js').QueryRecords>(kind:K,query:import('./record-query.js').RecordQuery):import('./record-query.js').RecordPage<import('./record-query.js').QueryRecords[K]>;
  walletTotals?(merchantId:string):{procurement:bigint;earnings:bigint;frozen:bigint};
  walletOverview?():Array<{merchantId:string;procurement:bigint;earnings:bigint;frozen:bigint;pendingEarning:bigint;lastEntryAt:Date|null}>;
  pendingEarningOrders?(merchantId:string):Order[];
  listPendingRefunds?(category:"customer"|"price_adjustment"):Refund[];
  findOrdersInternal?(ids:readonly string[]):Order[];
  queryNotificationTasks?(merchantId:string|null,page:number,limit:number):{
    tickets:import("../operations/model.js").Ticket[];orders:Order[];fulfillments:Fulfillment[];
    meta:{total:number;page:number;limit:number;pages:number};
  };
  financeWindow?(from:string,to:string):{daily:Array<Record<string,string|number>>;todayOrders:Order[]};
  outboxCursor?():number;
  outboxSince?(cursor:number,merchantId:string|null,limit:number):Array<{cursor:number;event:OutboxEvent}>;
  queryWorkspaceOrders?(merchantIds:string[],query:{productCodes?:string[];search?:string;status?:string;page:number;limit:number;today:string;paidFrom?:string;paidTo?:string;collectionMode?:string;financeMetric?:string}):{
    orders:Order[];fulfillments:Fulfillment[];vouchers:CdkVoucher[];meta:{total:number;page:number;limit:number;pages:number;paidCount:number;paidSaleMinor:bigint;todayPaidCount:number;todayPaidSaleMinor:bigint}};
  findMerchantById(id: string): Merchant | null;
  listMerchants(): Merchant[];
  listApps(merchantId: string): PartnerApp[];
  getOperations<K extends keyof import("../operations/model.js").OperationsRecords>(kind: K, id: string): import("../operations/model.js").OperationsRecords[K] | null;
  listOperations<K extends keyof import("../operations/model.js").OperationsRecords>(kind: K, merchantId?: string): import("../operations/model.js").OperationsRecords[K][];
  saveOperations<K extends keyof import("../operations/model.js").OperationsRecords>(kind: K, value: import("../operations/model.js").OperationsRecords[K], insertOnly?: boolean): void;
  consumeNonce(key: string, expiresAt: number, now: number): boolean;
  /** Synchronous unit of work. Never hold a database transaction across network calls. */
  transaction<T>(action: () => T): T;
  saveMerchant(value: Merchant): void;
  saveMerchantRole(value: MerchantRole): void;
  saveMerchantUser(value: MerchantUser): void;
  findMerchantRole(merchantId: string, roleId: string): MerchantRole | null;
  findMerchantUser(merchantId: string, userId: string): MerchantUser | null;
  saveApp(value: PartnerApp): void;
  saveKey(value: ApiKey): void;
  findMerchantByPartner(partnerId: string): Merchant | null;
  findCredential(partnerId: string, keyId: string): CredentialBundle | null;

  saveProductGrant(value: ProductGrant): void;
  listProductGrants(merchantId: string): ProductGrant[];
  findProductGrant(merchantId: string, productCode: string): ProductGrant | null;

  /** Monotonic QF########## id; call inside a transaction before payment creation. */
  allocatePublicOrderNo(): string;
  insertOrder(value: Order): void;
  updateOrder(value: Order): void;
  findOrder(merchantId: string, orderId: string): Order | null;
  findOrderInternal(orderId: string): Order | null;
  findOrderByMerchantNo(merchantId: string, merchantOrderNo: string): Order | null;
  listOrders(merchantId: string): Order[];
  listOrdersInternal(): Order[];
  listWorkspaceRecords?(merchantIds: string[]): {orders: Order[]; fulfillments: Fulfillment[]; vouchers: CdkVoucher[]};

  insertPaymentAttempt(value: PaymentAttempt): void;
  updatePaymentAttempt(value: PaymentAttempt): void;
  findPaymentAttemptByOrder(merchantId: string, orderId: string): PaymentAttempt | null;

  insertFulfillment(value: Fulfillment): void;
  updateFulfillment(value: Fulfillment): void;
  findFulfillment(merchantId: string, fulfillmentId: string): Fulfillment | null;
  listFulfillments(merchantId: string, orderId: string): Fulfillment[];
  listProcessableFulfillments(limit: number, now: Date): Fulfillment[];
  findFulfillmentByUpstreamClientRequestId(clientRequestId: string): Fulfillment | null;

  insertCdkVoucher(value: CdkVoucher): void;
  updateCdkVoucher(value: CdkVoucher): void;
  findCdkVoucherByOrder(orderId: string): CdkVoucher | null;
  findCdkVoucherByPublicCode(publicCode: string): CdkVoucher | null;
  insertSupplierWebhookEvent(value: SupplierWebhookEvent): void;
  updateSupplierWebhookEvent(value: SupplierWebhookEvent): void;
  findSupplierWebhookEvent(eventId: string): SupplierWebhookEvent | null;

  saveSupplierConnection(value: SupplierConnection): void;
  findSupplierConnection(connectionId: string): SupplierConnection | null;
  findEnabledSupplierConnection(): SupplierConnection | null;
  replaceSupplierPlanSnapshots(connectionId: string, product: SupplierPlanSnapshot["product"], values: SupplierPlanSnapshot[]): void;
  listSupplierPlanSnapshots(connectionId: string): SupplierPlanSnapshot[];
  saveSupplierProductMapping(value: SupplierProductMapping): void;
  findSupplierProductMapping(productCode: string): SupplierProductMapping | null;
  listSupplierProductMappings(): SupplierProductMapping[];

  insertRefund(value: Refund): void;
  updateRefund(value: Refund): void;
  findRefund(merchantId: string, refundId: string): Refund | null;
  findRefundByMerchantNo(merchantId: string, merchantRefundNo: string): Refund | null;
  listRefundsForOrder(merchantId: string, orderId: string): Refund[];

  appendLedger(items: LedgerItem[]): void;
  listLedger(merchantId: string): LedgerItem[];

  insertSettlement(value: Settlement): void;
  updateSettlement(value: Settlement): void;
  findSettlement(merchantId: string, settlementId: string): Settlement | null;
  listSettlements(merchantId: string): Settlement[];

  appendOutbox(value: OutboxEvent): void;
  listOutbox(merchantId: string): OutboxEvent[];
  saveWebhookEndpoint(value: WebhookEndpoint): void;
  listWebhookEndpoints(merchantId: string): WebhookEndpoint[];
  insertWebhookDelivery(value: WebhookDelivery): void;
  claimWebhookDeliveries(limit: number, leaseUntil: Date): ClaimedWebhookDelivery[];
  markWebhookDelivered(deliveryId: string, responseStatus: number, deliveredAt: Date): void;
  rescheduleWebhookDelivery(deliveryId: string, nextAttemptAt: Date | null, errorCode: string): void;
  appendAudit(value: AuditLog): void;
  listAudit(merchantId: string): AuditLog[];

  getIdempotency(merchantId: string, appId: string, routeKey: string, key: string): IdempotencyRecord | null;
  saveIdempotency(value: IdempotencyRecord): void;
  close?(): void;
}
