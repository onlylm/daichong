import {createHash} from "node:crypto";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
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
import type {ClaimedWebhookDelivery, CredentialBundle, Repository} from "./repository.js";
import type {OperationsRecords} from "../operations/model.js";
import {formatPublicOrderNo} from "../domain/public-order-no.js";
import type {QueryRecords,RecordQuery,RecordPage} from './record-query.js';

/** 可跨 API/Worker 进程共享的持久化仓储；当前生产与沙箱均可使用。 */
export class SqliteRepository implements Repository {
  findMerchantById(id: string): Merchant | null { return this.get("merchant", id); }
  listMerchants(): Merchant[] { return this.listAll("merchant"); }
  listApps(merchantId: string): PartnerApp[] { return this.list("partner_app", merchantId); }
  getOperations<K extends keyof OperationsRecords>(kind: K, id: string): OperationsRecords[K] | null { return this.get("ops_" + kind, id); }
  listOperations<K extends keyof OperationsRecords>(kind: K, merchantId?: string): OperationsRecords[K][] {
    return merchantId === undefined ? this.listAll("ops_" + kind) : this.list("ops_" + kind, merchantId);
  }
  saveOperations<K extends keyof OperationsRecords>(kind: K, value: OperationsRecords[K], insertOnly = false): void {
    const write = insertOnly || kind === "wallet_entry" || kind === "ticket_message" ? this.insert.bind(this) : this.put.bind(this);
    write("ops_" + kind, value.id, value.merchantId ?? "_global", value.id, value);
  }
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_nonces (nonce_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS request_nonces_expiry_idx ON request_nonces(expires_at);
      CREATE TABLE IF NOT EXISTS sandbox_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        unique_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id),
        UNIQUE (kind, merchant_id, unique_key)
      );
      CREATE INDEX IF NOT EXISTS sandbox_records_tenant_idx
        ON sandbox_records(kind, merchant_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS sandbox_records_order_relation_idx
        ON sandbox_records(kind, merchant_id, json_extract(payload, '$.orderId'));
      CREATE INDEX IF NOT EXISTS sandbox_records_global_order_relation_idx
        ON sandbox_records(kind, json_extract(payload, '$.orderId'));
      CREATE INDEX IF NOT EXISTS sandbox_records_public_code_idx
        ON sandbox_records(kind, json_extract(payload, '$.publicCode'));
      CREATE INDEX IF NOT EXISTS records_created_idx ON sandbox_records(kind,json_extract(payload,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_tenant_created_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_status_due_idx ON sandbox_records(kind,json_extract(payload,'$.status'),json_extract(payload,'$.nextCheckAt'));
      CREATE INDEX IF NOT EXISTS records_status_updated_idx ON sandbox_records(kind,json_extract(payload,'$.status'),json_extract(payload,'$.updatedAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_tenant_status_updated_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.status'),json_extract(payload,'$.updatedAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_status_order_relation_idx ON sandbox_records(kind,json_extract(payload,'$.status'),json_extract(payload,'$.orderId'));
      CREATE INDEX IF NOT EXISTS records_payment_created_idx ON sandbox_records(kind,json_extract(payload,'$.paymentStatus'),json_extract(payload,'$.createdAt'));
      CREATE INDEX IF NOT EXISTS records_tenant_payment_created_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.paymentStatus'),json_extract(payload,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_payment_provider_due_idx ON sandbox_records(kind,json_extract(payload,'$.provider'),json_extract(payload,'$.status'),json_extract(payload,'$.nextCheckAt'));
      CREATE INDEX IF NOT EXISTS records_paid_at_idx ON sandbox_records(kind,json_extract(payload,'$.paidAt'));
      CREATE INDEX IF NOT EXISTS records_task_attempt_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.orderId'),CAST(json_extract(payload,'$.attemptNo') AS INTEGER) DESC);
      CREATE INDEX IF NOT EXISTS records_refund_queue_idx ON sandbox_records(kind,json_extract(payload,'$.status'),json_extract(payload,'$.type'),json_extract(payload,'$.createdAt') DESC);
      CREATE INDEX IF NOT EXISTS records_wallet_entry_time_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.createdAt') DESC);
      CREATE INDEX IF NOT EXISTS records_tenant_occurred_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.occurredAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS records_outbox_cursor_idx ON sandbox_records(kind,id);
      CREATE INDEX IF NOT EXISTS records_upstream_client_request_idx ON sandbox_records(kind,json_extract(payload,'$.upstreamClientRequestId'));
      CREATE INDEX IF NOT EXISTS records_username_idx ON sandbox_records(kind,json_extract(payload,'$.username'));
      CREATE INDEX IF NOT EXISTS records_request_key_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.requestKey'));
      CREATE INDEX IF NOT EXISTS records_provider_ref_idx ON sandbox_records(kind,json_extract(payload,'$.providerRef'));
      CREATE INDEX IF NOT EXISTS records_verified_reference_idx ON sandbox_records(kind,json_extract(payload,'$.verifiedReference'));
      CREATE INDEX IF NOT EXISTS records_payout_reference_idx ON sandbox_records(kind,json_extract(payload,'$.payoutReference'));
      CREATE INDEX IF NOT EXISTS records_source_reference_idx ON sandbox_records(kind,json_extract(payload,'$.sourceReference'));
      CREATE INDEX IF NOT EXISTS records_trade_reference_idx ON sandbox_records(kind,json_extract(payload,'$.tradeCandidate.reference'));
      CREATE INDEX IF NOT EXISTS records_webhook_lease_idx ON sandbox_records(kind,json_extract(payload,'$.status'),json_extract(payload,'$.leaseUntil'));
      CREATE INDEX IF NOT EXISTS records_ticket_message_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.ticketId'),json_extract(payload,'$.createdAt'));
      CREATE INDEX IF NOT EXISTS records_withdrawal_application_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.withdrawalApplication.withdrawalId'));
      CREATE INDEX IF NOT EXISTS records_tier_request_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.tierApplication.requestKey'));
      CREATE INDEX IF NOT EXISTS records_wallet_credit_created_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.createdAt'),json_extract(payload,'$.orderId'));
      CREATE INDEX IF NOT EXISTS records_daily_settlement_status_idx ON sandbox_records(kind,merchant_id,json_extract(payload,'$.status'));
    `);
  }

  queryRecords<K extends keyof QueryRecords>(kind:K,q:RecordQuery={}):RecordPage<QueryRecords[K]> {
    const domain=new Set(['order','fulfillment','cdk_voucher','refund','payment_attempt','outbox','audit']);
    const storedKind=domain.has(kind)?kind:'ops_'+kind;
    const args:Array<string|number|null>=[storedKind],conditions=['kind=?'];
    const path=(field:string)=>{if(!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(field))throw new Error('invalid_query_field');return `json_extract(payload,'$.${field}')`;};
    if(q.merchantId!==undefined){conditions.push('merchant_id=?');args.push(q.merchantId);}
    if(q.afterId){conditions.push('id>?');args.push(q.afterId);}
    for(const f of q.filters??[]){
      const expr=path(f.field),op=f.op??'eq';
      if(op==='is_null'){conditions.push(expr+' IS NULL');continue;}
      if(op==='not_null'){conditions.push(expr+' IS NOT NULL');continue;}
      if(op==='in'){const values=f.value as Array<string|number>;if(!values.length){conditions.push('0');continue;}conditions.push(expr+` IN (${values.map(()=>'?').join(',')})`);args.push(...values);continue;}
      if(op==='lte_or_null'){conditions.push(`(${expr} IS NULL OR ${expr}<=?)`);const value=f.value;args.push(value instanceof Date?value.toISOString():value as string|number|null);continue;}
      const operators={eq:'=',ne:'!=',lte:'<=',gte:'>=',gt:'>'};
      conditions.push(expr+(operators[op]??'=')+'?');
      const value=f.value;args.push(value instanceof Date?value.toISOString():typeof value==='boolean'?Number(value):value as string|number|null);
    }
    const where=conditions.join(' AND '),limit=Math.min(500,Math.max(1,q.limit??30));
    const total=q.count===false?0:Number(this.db.prepare(`SELECT COUNT(*) AS total FROM sandbox_records WHERE ${where}`).get(...args)!.total);
    const pages=q.count===false?1:Math.max(1,Math.ceil(total/limit)),page=q.count===false?Math.max(1,q.page??1):Math.min(Math.max(1,q.page??1),pages);
    const order=q.afterId?'id':path(q.orderBy??'createdAt'),direction=q.direction==='asc'?'ASC':'DESC';
    const rows=this.db.prepare(`SELECT payload FROM sandbox_records WHERE ${where} ORDER BY ${order} ${direction},id ${direction} LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
    return {data:rows.map(r=>decode<QueryRecords[K]>(String(r.payload))),meta:{total:q.count===false?rows.length:total,page,limit,pages}};
  }

  queryNotificationTasks(merchantId:string|null,requestedPage:number,requestedLimit:number) {
    const limit=Math.min(100,Math.max(1,requestedLimit)),args:Array<string|number>=[];
    const tenant=merchantId===null?'':` AND t.merchant_id=?`;if(merchantId!==null)args.push(merchantId);
    const active=`t.kind='ops_ticket' AND json_extract(t.payload,'$.archivedAt') IS NULL
      AND json_extract(t.payload,'$.createdBy')='system'
      AND json_extract(t.payload,'$.status') IN ('open','in_progress','waiting_agent')${tenant}`;
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS total FROM sandbox_records t WHERE ${active}`).get(...args)!.total);
    const pages=Math.max(1,Math.ceil(total/limit)),page=Math.min(Math.max(1,requestedPage),pages);
    const rows=this.db.prepare(`SELECT t.payload AS ticket,o.payload AS order_payload,f.payload AS fulfillment_payload
      FROM sandbox_records t
      LEFT JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=t.merchant_id AND o.id=json_extract(t.payload,'$.orderId')
      LEFT JOIN sandbox_records f ON f.rowid=(SELECT ff.rowid FROM sandbox_records ff
        WHERE ff.kind='fulfillment' AND ff.merchant_id=t.merchant_id AND json_extract(ff.payload,'$.orderId')=json_extract(t.payload,'$.orderId')
        ORDER BY CAST(json_extract(ff.payload,'$.attemptNo') AS INTEGER) DESC,ff.rowid DESC LIMIT 1)
      WHERE ${active} ORDER BY json_extract(t.payload,'$.createdAt') DESC,t.id DESC LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
    return {tickets:rows.map(row=>decode<OperationsRecords['ticket']>(String(row.ticket))),
      orders:rows.flatMap(row=>row.order_payload?[decode<Order>(String(row.order_payload))]:[]),
      fulfillments:rows.flatMap(row=>row.fulfillment_payload?[decode<Fulfillment>(String(row.fulfillment_payload))]:[]),
      meta:{total,page,limit,pages}};
  }

  listTicketMessages(merchantId:string,ticketId:string,includeInternal:boolean):OperationsRecords['ticket_message'][] {
    const internal=includeInternal?'':' AND COALESCE(json_extract(payload,\'$.internal\'),0)=0';
    return this.db.prepare(`SELECT payload FROM sandbox_records WHERE kind='ops_ticket_message' AND merchant_id=?
      AND json_extract(payload,'$.ticketId')=?${internal} ORDER BY json_extract(payload,'$.createdAt') ASC,id ASC`).all(merchantId,ticketId)
      .map(row=>decode<OperationsRecords['ticket_message']>(String(row.payload)));
  }

  walletTotals(merchantId:string) {
    const row=this.db.prepare(`SELECT
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.procurementDelta.__bigint') AS INTEGER)),0) AS TEXT) AS procurement,
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.earningsDelta.__bigint') AS INTEGER)),0) AS TEXT) AS earnings,
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.frozenDelta.__bigint') AS INTEGER)),0) AS TEXT) AS frozen
      FROM sandbox_records WHERE kind='ops_wallet_entry' AND merchant_id=?`).get(merchantId)!;
    return {procurement:BigInt(String(row.procurement)),earnings:BigInt(String(row.earnings)),frozen:BigInt(String(row.frozen))};
  }

  tierOrderMetrics(merchantId:string) {
    const amount=`CAST(COALESCE(json_extract(o.payload,'$.supplyAmountMinor.__bigint'),'0') AS INTEGER)`;
    const row=this.db.prepare(`SELECT COUNT(*) AS completedOrders,
      CAST(COALESCE(SUM(${amount}),0) AS TEXT) AS completedSupplyMinor,
      CAST(COALESCE(SUM(CASE WHEN COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')='agent_collect' THEN ${amount} ELSE 0 END),0) AS TEXT) AS agentCollectSupplyMinor
      FROM sandbox_records o
      WHERE o.kind='order' AND o.merchant_id=?
      AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0
      AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded')
      AND CAST(COALESCE(json_extract(o.payload,'$.ordinaryRefundedMinor.__bigint'),'0') AS INTEGER)=0
      AND EXISTS(SELECT 1 FROM sandbox_records p WHERE p.kind='payment_attempt' AND p.merchant_id=o.merchant_id
        AND json_extract(p.payload,'$.orderId')=o.id AND json_extract(p.payload,'$.status')='paid'
        AND json_extract(p.payload,'$.provider') IN ('alipay_page','dujiaopay','agent_wallet'))
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded'
        AND json_extract(f.payload,'$.upstreamProvider') IS NOT NULL AND json_extract(f.payload,'$.upstreamProvider')!='mock')`).get(merchantId)!;
    return {completedOrders:Number(row.completedOrders),completedSupplyMinor:BigInt(String(row.completedSupplyMinor)),
      agentCollectSupplyMinor:BigInt(String(row.agentCollectSupplyMinor))};
  }

  walletOverview() {
    const totals=this.db.prepare(`SELECT merchant_id,
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.procurementDelta.__bigint') AS INTEGER)),0) AS TEXT) AS procurement,
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.earningsDelta.__bigint') AS INTEGER)),0) AS TEXT) AS earnings,
      CAST(COALESCE(SUM(CAST(json_extract(payload,'$.frozenDelta.__bigint') AS INTEGER)),0) AS TEXT) AS frozen,
      MAX(json_extract(payload,'$.createdAt')) AS lastEntryAt
      FROM sandbox_records WHERE kind='ops_wallet_entry' GROUP BY merchant_id`).all() as Array<Record<string,unknown>>;
    const pending=this.db.prepare(`SELECT o.merchant_id,
      CAST(COALESCE(SUM(max(0,
        CAST(COALESCE(json_extract(o.payload,'$.saleAmountMinor.__bigint'),'0') AS INTEGER)
        -CAST(COALESCE(json_extract(o.payload,'$.ordinaryRefundedMinor.__bigint'),'0') AS INTEGER)
        -CAST(COALESCE(json_extract(o.payload,'$.supplyAmountMinor.__bigint'),'0') AS INTEGER))),0) AS TEXT) AS pending
      FROM sandbox_records o WHERE o.kind='order'
      AND COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')!='agent_collect'
      AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0
      AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded','refunded')
      AND NOT EXISTS(SELECT 1 FROM sandbox_records c WHERE c.kind='ops_wallet_credit' AND c.id=o.id)
      AND EXISTS(SELECT 1 FROM sandbox_records p WHERE p.kind='payment_attempt' AND p.merchant_id=o.merchant_id AND json_extract(p.payload,'$.orderId')=o.id AND json_extract(p.payload,'$.provider') IN ('alipay_page','dujiaopay'))
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded' AND COALESCE(json_extract(f.payload,'$.upstreamProvider'),'mock')!='mock')
      GROUP BY o.merchant_id`).all() as Array<Record<string,unknown>>;
    const byMerchant=new Map<string,{merchantId:string;procurement:bigint;earnings:bigint;frozen:bigint;pendingEarning:bigint;lastEntryAt:Date|null}>();
    for(const row of totals){const merchantId=String(row.merchant_id);byMerchant.set(merchantId,{merchantId,
      procurement:BigInt(String(row.procurement)),earnings:BigInt(String(row.earnings)),frozen:BigInt(String(row.frozen)),
      pendingEarning:0n,lastEntryAt:row.lastEntryAt?new Date(String(row.lastEntryAt)):null});}
    for(const row of pending){const merchantId=String(row.merchant_id),current=byMerchant.get(merchantId)??{merchantId,procurement:0n,earnings:0n,frozen:0n,pendingEarning:0n,lastEntryAt:null};
      current.pendingEarning=BigInt(String(row.pending));byMerchant.set(merchantId,current);}
    return [...byMerchant.values()];
  }

  outboxCursor():number {return Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM sandbox_records WHERE kind='outbox'").get()!.n);}
  pendingEarningOrders(merchantId:string):Order[] {
    return this.db.prepare(`SELECT o.payload FROM sandbox_records o WHERE o.kind='order' AND o.merchant_id=?
      AND COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')!='agent_collect'
      AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0 AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded','refunded')
      AND CAST(json_extract(o.payload,'$.saleAmountMinor.__bigint') AS INTEGER)-CAST(json_extract(o.payload,'$.ordinaryRefundedMinor.__bigint') AS INTEGER)-CAST(json_extract(o.payload,'$.supplyAmountMinor.__bigint') AS INTEGER)>0
      AND NOT EXISTS(SELECT 1 FROM sandbox_records c WHERE c.kind='ops_wallet_credit' AND c.id=o.id)
      AND EXISTS(SELECT 1 FROM sandbox_records p WHERE p.kind='payment_attempt' AND p.merchant_id=o.merchant_id AND json_extract(p.payload,'$.orderId')=o.id AND json_extract(p.payload,'$.provider') IN ('alipay_page','dujiaopay'))
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded' AND COALESCE(json_extract(f.payload,'$.upstreamProvider'),'mock')!='mock')
      ORDER BY COALESCE(json_extract(o.payload,'$.paidAt'),json_extract(o.payload,'$.createdAt')) DESC`).all(merchantId).map(r=>decode<Order>(String(r.payload)));
  }

  financeWindow(from:string,to:string) {
    const base=` FROM sandbox_records o WHERE o.kind='order' AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0 AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded','refunded') AND json_extract(o.payload,'$.paidAt')>=? AND json_extract(o.payload,'$.paidAt')<?`;
    const amount=(key:string)=>`CAST(COALESCE(json_extract(o.payload,'$.${key}.__bigint'),'0') AS INTEGER)`,retail=`COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')='platform_collect'`;
    const sum=(expr:string)=>`CAST(COALESCE(SUM(${expr}),0) AS TEXT)`;
    const daily=this.db.prepare(`SELECT strftime('%Y-%m-%d',json_extract(o.payload,'$.paidAt'),'+8 hours') AS day,COUNT(*) AS paidOrders,
      SUM(CASE WHEN ${retail} THEN 1 ELSE 0 END) AS platformCollectOrders,SUM(CASE WHEN NOT (${retail}) THEN 1 ELSE 0 END) AS agentCollectOrders,
      ${sum(`CASE WHEN ${retail} THEN ${amount('saleAmountMinor')} ELSE 0 END`)} AS saleAmountMinor,
      ${sum(`CASE WHEN ${retail} THEN ${amount('supplyAmountMinor')} ELSE 0 END`)} AS supplyAmountMinor,
      ${sum(`CASE WHEN ${retail} THEN ${amount('ordinaryRefundedMinor')} ELSE 0 END`)} AS ordinaryRefundedMinor,
      ${sum(`CASE WHEN ${retail} THEN ${amount('priceAdjustmentRefundedMinor')} ELSE 0 END`)} AS priceAdjustmentRefundedMinor,
      ${sum(`CASE WHEN ${retail} THEN max(0,${amount('saleAmountMinor')}-${amount('ordinaryRefundedMinor')}-${amount('supplyAmountMinor')}) ELSE 0 END`)} AS marginMinor,
      ${sum(`CASE WHEN NOT (${retail}) THEN ${amount('supplyAmountMinor')} ELSE 0 END`)} AS agentCollectSupplyMinor,
      SUM(CASE WHEN EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded') THEN 1 ELSE 0 END) AS succeededOrders
      ${base} GROUP BY day`).all(from,to) as Array<Record<string,string|number>>;
    const todayStart=new Date(Date.parse(to)-86400000).toISOString();
    const todayOrders=this.db.prepare(`SELECT o.payload${base} ORDER BY json_extract(o.payload,'$.paidAt') DESC,o.id DESC LIMIT 50`).all(todayStart,to).map(r=>decode<Order>(String(r.payload)));
    return {daily,todayOrders};
  }
  outboxSince(cursor:number,merchantId:string|null,limit:number) {
    const rows=merchantId===null?this.db.prepare("SELECT rowid,payload FROM sandbox_records WHERE rowid>? AND kind='outbox' ORDER BY rowid LIMIT ?").all(cursor,Math.min(limit,100))
      :this.db.prepare("SELECT rowid,payload FROM sandbox_records WHERE rowid>? AND kind='outbox' AND merchant_id=? ORDER BY rowid LIMIT ?").all(cursor,merchantId,Math.min(limit,100));
    return rows.map(r=>({cursor:Number(r.rowid),event:decode<OutboxEvent>(String(r.payload))}));
  }

  queryWorkspaceOrders(merchantIds:string[],q:{productCodes?:string[];search?:string;status?:string;page:number;limit:number;today:string;paidFrom?:string;paidTo?:string;collectionMode?:string;financeMetric?:string}) {
    const empty={orders:[] as Order[],fulfillments:[] as Fulfillment[],vouchers:[] as CdkVoucher[],meta:{total:0,page:1,limit:q.limit,pages:1,paidCount:0,paidSaleMinor:0n,todayPaidCount:0,todayPaidSaleMinor:0n}};
    if(!merchantIds.length)return empty;
    const args:Array<string|number>=[...merchantIds],conditions=[`o.kind='order'`,`o.merchant_id IN (${merchantIds.map(()=>'?').join(',')})`];
    const j=(alias:string,field:string)=>`json_extract(${alias}.payload,'$.${field}')`;
    // Financial drill-downs retain historic receipts, even for archived test orders.
    if (!q.financeMetric) conditions.push(`${j('o','archivedAt')} IS NULL`);
    const join=` FROM sandbox_records o LEFT JOIN sandbox_records f ON f.rowid=(SELECT ff.rowid FROM sandbox_records ff WHERE ff.kind='fulfillment' AND ff.merchant_id=o.merchant_id AND json_extract(ff.payload,'$.orderId')=o.id ORDER BY CAST(json_extract(ff.payload,'$.attemptNo') AS INTEGER) DESC LIMIT 1)
      LEFT JOIN sandbox_records v ON v.kind='cdk_voucher' AND v.merchant_id=o.merchant_id AND json_extract(v.payload,'$.orderId')=o.id`;
    if(q.productCodes?.length){conditions.push(`${j('o','productCode')} IN (${q.productCodes.map(()=>'?').join(',')})`);args.push(...q.productCodes);}
    const pay=j('o','paymentStatus'),status=j('f','status');
    if(q.paidFrom&&q.paidTo){conditions.push(`${pay} IN ('paid','partially_refunded','refunded') AND COALESCE(${j('o','liveTest')},0)=0 AND ${j('o','paidAt')}>=? AND ${j('o','paidAt')}<?`);args.push(q.paidFrom,q.paidTo);}
    if(q.collectionMode){conditions.push(`COALESCE(${j('o','collectionMode')},'platform_collect')=?`);args.push(q.collectionMode);}
    if(q.financeMetric==='refunds')conditions.push(`CAST(COALESCE(${j('o','ordinaryRefundedMinor.__bigint')},'0') AS INTEGER)+CAST(COALESCE(${j('o','priceAdjustmentRefundedMinor.__bigint')},'0') AS INTEGER)>0`);
    if(q.financeMetric==='margin')conditions.push(`CAST(${j('o','saleAmountMinor.__bigint')} AS INTEGER)-CAST(${j('o','supplyAmountMinor.__bigint')} AS INTEGER)-CAST(COALESCE(${j('o','ordinaryRefundedMinor.__bigint')},'0') AS INTEGER)>0`);
    if(q.financeMetric==='succeeded')conditions.push(`EXISTS(SELECT 1 FROM sandbox_records sf WHERE sf.kind='fulfillment' AND sf.merchant_id=o.merchant_id AND json_extract(sf.payload,'$.orderId')=o.id AND json_extract(sf.payload,'$.status')='succeeded')`);
    if(q.status==='pending')conditions.push(`${pay}='pending'`);
    if(q.status==='paid')conditions.push(`${pay} IN ('paid','partially_refunded') AND COALESCE(${status},'') NOT IN ('succeeded','failed')`);
    if(q.status==='running')conditions.push(`${status} IN ('queued','running')`);
    if(q.status==='succeeded')conditions.push(`${status}='succeeded'`);
    if(q.status==='failed')conditions.push(`(${status}='failed' OR ${j('v','status')}='failed')`);
    if(q.status==='refunded')conditions.push(`${pay}='refunded'`);
    if(q.search?.trim()){
      const needle=q.search.trim().toLowerCase(),fields=['o.id',j('o','merchantOrderNo'),j('o','voucherCode'),j('v','publicCode'),j('v','upstreamCdkId'),j('f','upstreamOrderId'),j('f','accountEmailMasked')];
      const search=fields.map(x=>`instr(lower(COALESCE(${x},'')),?)>0`);args.push(...fields.map(()=>needle));
      const at=needle.lastIndexOf('@');if(at>0&&at===needle.indexOf('@')){search.push(`lower(${j('f','accountEmailMasked')})=?`);const local=needle.slice(0,at);args.push(local[0]+'***'+(local.length>1?local.at(-1):'')+needle.slice(at));}
      conditions.push('('+search.join(' OR ')+')');
    }
    const where=' WHERE '+conditions.join(' AND '),paid=`${pay} IN ('paid','partially_refunded','refunded')`,today=`strftime('%Y-%m-%d',${j('o','paidAt')},'+8 hours')=?`,sale=`CAST(${j('o','saleAmountMinor.__bigint')} AS INTEGER)`;
    const meta=this.db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN ${paid} THEN 1 ELSE 0 END) AS paidCount,
      CAST(COALESCE(SUM(CASE WHEN ${paid} THEN ${sale} ELSE 0 END),0) AS TEXT) AS sale,
      SUM(CASE WHEN ${paid} AND ${today} THEN 1 ELSE 0 END) AS todayCount,
      CAST(COALESCE(SUM(CASE WHEN ${paid} AND ${today} THEN ${sale} ELSE 0 END),0) AS TEXT) AS todaySale${join}${where}`).get(q.today,q.today,...args)!;
    const total=Number(meta.total),pages=Math.max(1,Math.ceil(total/q.limit)),page=Math.min(Math.max(1,q.page),pages);
    const rows=this.db.prepare(`SELECT o.payload AS o,f.payload AS f,v.payload AS v${join}${where} ORDER BY ${j('o','createdAt')} DESC,o.id DESC LIMIT ? OFFSET ?`).all(...args,q.limit,(page-1)*q.limit);
    return {orders:rows.map(r=>decode<Order>(String(r.o))),fulfillments:rows.flatMap(r=>r.f?[decode<Fulfillment>(String(r.f))]:[]),vouchers:rows.flatMap(r=>r.v?[decode<CdkVoucher>(String(r.v))]:[]),
      meta:{total,page,limit:q.limit,pages,paidCount:Number(meta.paidCount??0),paidSaleMinor:BigInt(String(meta.sale)),todayPaidCount:Number(meta.todayCount??0),todayPaidSaleMinor:BigInt(String(meta.todaySale))}};
  }

  queryCostAccountingOrders(q:{status:"all"|"pending_review"|"confirmed"|"disputed";search?:string;page:number;limit:number}) {
    const j=(alias:string,field:string)=>`json_extract(${alias}.payload,'$.${field}')`;
    const join=` FROM sandbox_records o
      LEFT JOIN sandbox_records c ON c.kind='ops_order_cost' AND c.id=o.id
      LEFT JOIN sandbox_records m ON m.kind='merchant' AND m.id=o.merchant_id`;
    const conditions=[`o.kind='order'`,`${j('o','archivedAt')} IS NULL`,`COALESCE(${j('o','liveTest')},0)=0`,
      `${j('o','paymentStatus')} IN ('paid','partially_refunded','refunded')`,
      `(c.id IS NOT NULL OR EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded'))`];
    const args:Array<string|number>=[];
    if(q.status!=="all"){
      if(q.status==="pending_review")conditions.push(`COALESCE(${j('c','status')},'pending_review')='pending_review'`);
      else {conditions.push(`${j('c','status')}=?`);args.push(q.status);}
    }
    if(q.search?.trim()){
      const needle=q.search.trim().toLowerCase(),fields=['o.id',j('o','merchantOrderNo'),j('m','name'),j('m','partnerId')];
      conditions.push(`(${fields.map(field=>`instr(lower(COALESCE(${field},'')),?)>0`).join(' OR ')})`);
      args.push(...fields.map(()=>needle));
    }
    const where=' WHERE '+conditions.join(' AND '),limit=Math.min(100,Math.max(1,q.limit));
    const total=Number(this.db.prepare(`SELECT COUNT(*) AS total${join}${where}`).get(...args)!.total);
    const pages=Math.max(1,Math.ceil(total/limit)),page=Math.min(Math.max(1,q.page),pages);
    const rows=this.db.prepare(`SELECT o.payload AS order_payload,m.payload AS merchant_payload${join}${where}
      ORDER BY ${j('o','createdAt')} DESC,o.id DESC LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
    const merchantNames=new Map<string,string>();
    const orders=rows.map(row=>{const order=decode<Order>(String(row.order_payload));
      if(row.merchant_payload){const merchant=decode<Merchant>(String(row.merchant_payload));merchantNames.set(merchant.id,merchant.name);}return order;});
    return {orders,merchantNames:[...merchantNames].map(([merchantId,name])=>({merchantId,name})),meta:{total,page,limit,pages}};
  }

  queryPartnerOrders(merchantId:string,q:{paymentStatus?:Order["paymentStatus"];cursor?:string;limit:number}) {
    const created=`json_extract(o.payload,'$.createdAt')`,conditions=[`o.kind='order'`,`o.merchant_id=?`],args:Array<string|number>=[merchantId];
    if(q.paymentStatus){conditions.push(`json_extract(o.payload,'$.paymentStatus')=?`);args.push(q.paymentStatus);}
    let cursorValid=true;
    if(q.cursor){
      const cursorConditions=[`kind='order'`,`merchant_id=?`,`id=?`],cursorArgs:Array<string|number>=[merchantId,q.cursor];
      if(q.paymentStatus){cursorConditions.push(`json_extract(payload,'$.paymentStatus')=?`);cursorArgs.push(q.paymentStatus);}
      const cursor=this.db.prepare(`SELECT json_extract(payload,'$.createdAt') AS createdAt FROM sandbox_records WHERE ${cursorConditions.join(' AND ')} LIMIT 1`).get(...cursorArgs);
      cursorValid=!!cursor;
      if(cursor){conditions.push(`(${created}<? OR (${created}=? AND o.id<?))`);args.push(String(cursor.createdAt),String(cursor.createdAt),q.cursor);}
    }
    if(!cursorValid)return {orders:[],fulfillments:[],hasMore:false,cursorValid:false};
    const limit=Math.min(100,Math.max(1,q.limit)),rows=this.db.prepare(`SELECT o.payload AS order_payload,f.payload AS fulfillment_payload
      FROM sandbox_records o LEFT JOIN sandbox_records f ON f.rowid=(SELECT ff.rowid FROM sandbox_records ff
        WHERE ff.kind='fulfillment' AND ff.merchant_id=o.merchant_id AND json_extract(ff.payload,'$.orderId')=o.id
        ORDER BY CAST(json_extract(ff.payload,'$.attemptNo') AS INTEGER) DESC,ff.id DESC LIMIT 1)
      WHERE ${conditions.join(' AND ')} ORDER BY ${created} DESC,o.id DESC LIMIT ?`).all(...args,limit+1);
    const page=rows.slice(0,limit);
    return {orders:page.map(row=>decode<Order>(String(row.order_payload))),
      fulfillments:page.flatMap(row=>row.fulfillment_payload?[decode<Fulfillment>(String(row.fulfillment_payload))]:[]),
      hasMore:rows.length>limit,cursorValid:true};
  }

  queryPartnerLedger(merchantId:string,q:{from?:Date;to?:Date;cursor?:string;limit:number}) {
    const occurred=`json_extract(payload,'$.occurredAt')`,conditions=[`kind='ledger'`,`merchant_id=?`],args:Array<string|number>=[merchantId];
    if(q.from){conditions.push(`${occurred}>=?`);args.push(q.from.toISOString());}
    if(q.to){conditions.push(`${occurred}<?`);args.push(q.to.toISOString());}
    let cursorValid=true;
    if(q.cursor){
      const cursorConditions=[`kind='ledger'`,`merchant_id=?`,`id=?`],cursorArgs:Array<string|number>=[merchantId,q.cursor];
      if(q.from){cursorConditions.push(`${occurred}>=?`);cursorArgs.push(q.from.toISOString());}
      if(q.to){cursorConditions.push(`${occurred}<?`);cursorArgs.push(q.to.toISOString());}
      const cursor=this.db.prepare(`SELECT ${occurred} AS occurredAt FROM sandbox_records WHERE ${cursorConditions.join(' AND ')} LIMIT 1`).get(...cursorArgs);
      cursorValid=!!cursor;
      if(cursor){conditions.push(`(${occurred}<? OR (${occurred}=? AND id<?))`);args.push(String(cursor.occurredAt),String(cursor.occurredAt),q.cursor);}
    }
    if(!cursorValid)return {entries:[],hasMore:false,cursorValid:false};
    const limit=Math.min(100,Math.max(1,q.limit)),rows=this.db.prepare(`SELECT payload FROM sandbox_records WHERE ${conditions.join(' AND ')}
      ORDER BY ${occurred} DESC,id DESC LIMIT ?`).all(...args,limit+1);
    return {entries:rows.slice(0,limit).map(row=>decode<LedgerItem>(String(row.payload))),hasMore:rows.length>limit,cursorValid:true};
  }

  queryPartnerSettlements(merchantId:string,q:{cursor?:string;limit:number}) {
    const created=`json_extract(payload,'$.createdAt')`,conditions=[`kind='settlement'`,`merchant_id=?`],args:Array<string|number>=[merchantId];
    let cursorValid=true;
    if(q.cursor){
      const cursor=this.db.prepare(`SELECT ${created} AS createdAt FROM sandbox_records WHERE kind='settlement' AND merchant_id=? AND id=? LIMIT 1`).get(merchantId,q.cursor);
      cursorValid=!!cursor;
      if(cursor){conditions.push(`(${created}<? OR (${created}=? AND id<?))`);args.push(String(cursor.createdAt),String(cursor.createdAt),q.cursor);}
    }
    if(!cursorValid)return {settlements:[],hasMore:false,cursorValid:false};
    const limit=Math.min(100,Math.max(1,q.limit)),rows=this.db.prepare(`SELECT payload FROM sandbox_records WHERE ${conditions.join(' AND ')}
      ORDER BY ${created} DESC,id DESC LIMIT ?`).all(...args,limit+1);
    return {settlements:rows.slice(0,limit).map(row=>decode<Settlement>(String(row.payload))),hasMore:rows.length>limit,cursorValid:true};
  }

  listDailySettlementCandidates(periodTo:Date) {
    const rows=this.db.prepare(`SELECT o.payload AS order_payload,c.payload AS credit_payload FROM sandbox_records c
      JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=c.merchant_id AND o.id=json_extract(c.payload,'$.orderId')
      JOIN sandbox_records m ON m.kind='merchant' AND m.id=c.merchant_id AND json_extract(m.payload,'$.status')='active'
      JOIN sandbox_records p ON p.kind='payment_attempt' AND p.merchant_id=o.merchant_id AND json_extract(p.payload,'$.orderId')=o.id
      WHERE c.kind='ops_wallet_credit' AND json_extract(c.payload,'$.createdAt')<?
      AND CAST(COALESCE(json_extract(c.payload,'$.recognizedMinor.__bigint'),'0') AS INTEGER)>0
      AND json_extract(o.payload,'$.archivedAt') IS NULL AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0
      AND COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')='platform_collect'
      AND json_extract(p.payload,'$.status')='paid'
      AND CAST(COALESCE(json_extract(p.payload,'$.receivedMinor.__bigint'),json_extract(o.payload,'$.paymentReceivedMinor.__bigint'),'0') AS INTEGER)
        =CAST(json_extract(o.payload,'$.saleAmountMinor.__bigint') AS INTEGER)
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded')
      AND NOT EXISTS(SELECT 1 FROM sandbox_records s,json_each(s.payload,'$.orderIds') assigned
        WHERE s.kind='ops_daily_settlement' AND s.merchant_id=c.merchant_id
        AND json_extract(s.payload,'$.status')!='voided' AND assigned.value=json_extract(c.payload,'$.orderId'))
      ORDER BY c.merchant_id,json_extract(c.payload,'$.createdAt'),c.id`).all(periodTo.toISOString());
    return rows.map(row=>({order:decode<Order>(String(row.order_payload)),credit:decode<OperationsRecords['wallet_credit']>(String(row.credit_payload))}));
  }

  dailySettlementFunds(merchantIds:readonly string[]) {
    const unique=[...new Set(merchantIds)].filter(Boolean);if(!unique.length)return [];
    const result:Array<{merchantId:string;earningsBalance:bigint;alreadyScheduled:bigint}>=[];
    for(let start=0;start<unique.length;start+=400){
      const ids=unique.slice(start,start+400),placeholders=ids.map(()=>'?').join(',');
      const rows=this.db.prepare(`SELECT m.id AS merchantId,
        CAST(COALESCE((SELECT SUM(CAST(json_extract(e.payload,'$.earningsDelta.__bigint') AS INTEGER)) FROM sandbox_records e
          WHERE e.kind='ops_wallet_entry' AND e.merchant_id=m.id),0) AS TEXT) AS earningsBalance,
        CAST(COALESCE((SELECT SUM(CAST(json_extract(s.payload,'$.payableMinor.__bigint') AS INTEGER)) FROM sandbox_records s
          WHERE s.kind='ops_daily_settlement' AND s.merchant_id=m.id AND json_extract(s.payload,'$.status')='pending_payment'),0) AS TEXT) AS alreadyScheduled
        FROM sandbox_records m WHERE m.kind='merchant' AND m.id IN (${placeholders})`).all(...ids);
      result.push(...rows.map(row=>({merchantId:String(row.merchantId),earningsBalance:BigInt(String(row.earningsBalance)),
        alreadyScheduled:BigInt(String(row.alreadyScheduled))})));
    }
    return result;
  }

  earningReversalCandidates(merchantId:string,onlyOrderId?:string) {
    const sale=`CAST(COALESCE(json_extract(o.payload,'$.saleAmountMinor.__bigint'),'0') AS INTEGER)`,refund=`CAST(COALESCE(json_extract(o.payload,'$.ordinaryRefundedMinor.__bigint'),'0') AS INTEGER)`,
      supply=`CAST(COALESCE(json_extract(o.payload,'$.supplyAmountMinor.__bigint'),'0') AS INTEGER)`,recognized=`CAST(COALESCE(json_extract(c.payload,'$.recognizedMinor.__bigint'),'0') AS INTEGER)`;
    const eligible=`o.id IS NOT NULL AND COALESCE(json_extract(o.payload,'$.collectionMode'),'platform_collect')!='agent_collect'
      AND COALESCE(json_extract(o.payload,'$.liveTest'),0)=0 AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded','refunded')
      AND EXISTS(SELECT 1 FROM sandbox_records p WHERE p.kind='payment_attempt' AND p.merchant_id=o.merchant_id
        AND json_extract(p.payload,'$.orderId')=o.id AND json_extract(p.payload,'$.provider') IN ('alipay_page','dujiaopay'))
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded'
        AND json_extract(f.payload,'$.upstreamProvider') IS NOT NULL AND json_extract(f.payload,'$.upstreamProvider')!='mock')`;
    const args:Array<string>=[merchantId],orderFilter=onlyOrderId?` AND json_extract(c.payload,'$.orderId')=?`:'';if(onlyOrderId)args.push(onlyOrderId);
    const rows=this.db.prepare(`WITH candidates AS (SELECT c.payload AS credit_payload,o.payload AS order_payload,${recognized} AS recognized,
      CASE WHEN ${eligible} THEN max(0,${sale}-${refund}-${supply}) ELSE 0 END AS target
      FROM sandbox_records c LEFT JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=c.merchant_id AND o.id=json_extract(c.payload,'$.orderId')
      WHERE c.kind='ops_wallet_credit' AND c.merchant_id=?${orderFilter})
      SELECT credit_payload,order_payload,CAST(target AS TEXT) AS target FROM candidates WHERE target<recognized`).all(...args);
    return rows.map(row=>({credit:decode<OperationsRecords['wallet_credit']>(String(row.credit_payload)),
      order:row.order_payload?decode<Order>(String(row.order_payload)):null,targetMinor:BigInt(String(row.target))}));
  }

  hasPendingRefundForReleasedEarnings(merchantId:string) {
    return !!this.db.prepare(`SELECT 1 FROM sandbox_records c JOIN sandbox_records r
      ON r.kind='refund' AND r.merchant_id=c.merchant_id AND json_extract(r.payload,'$.orderId')=json_extract(c.payload,'$.orderId')
      WHERE c.kind='ops_wallet_credit' AND c.merchant_id=? AND json_extract(r.payload,'$.status') IN ('requested','approved','processing') LIMIT 1`).get(merchantId);
  }

  findDuePaymentOrder(provider:string,now:Date):Order|null {
    const row=this.db.prepare(`SELECT o.payload AS order_payload FROM sandbox_records p
      JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=p.merchant_id AND o.id=json_extract(p.payload,'$.orderId')
      WHERE p.kind='payment_attempt' AND json_extract(p.payload,'$.provider')=? AND json_extract(p.payload,'$.status')='pending'
      AND json_extract(o.payload,'$.paymentStatus')='pending'
      AND (json_extract(p.payload,'$.nextCheckAt') IS NULL OR json_extract(p.payload,'$.nextCheckAt')<=?)
      ORDER BY COALESCE(json_extract(p.payload,'$.nextCheckAt'),json_extract(p.payload,'$.createdAt')) ASC,p.id ASC LIMIT 1`).get(provider,now.toISOString());
    return row?decode<Order>(String(row.order_payload)):null;
  }

  findDueRefund(provider:string,now:Date):Refund|null {
    const row=this.db.prepare(`SELECT r.payload AS refund_payload FROM sandbox_records r
      JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=r.merchant_id AND o.id=json_extract(r.payload,'$.orderId')
      JOIN sandbox_records p ON p.kind='payment_attempt' AND p.merchant_id=o.merchant_id AND json_extract(p.payload,'$.orderId')=o.id
      WHERE r.kind='refund' AND json_extract(r.payload,'$.status')='processing'
      AND (json_extract(r.payload,'$.nextCheckAt') IS NULL OR json_extract(r.payload,'$.nextCheckAt')<=?)
      AND json_extract(p.payload,'$.provider')=?
      ORDER BY COALESCE(json_extract(r.payload,'$.nextCheckAt'),json_extract(r.payload,'$.createdAt')) ASC,r.id ASC LIMIT 1`).get(now.toISOString(),provider);
    return row?decode<Refund>(String(row.refund_payload)):null;
  }

  findRefundInternal(refundId:string):Refund|null {return this.get<Refund>('refund',refundId);}

  listCdkIssuanceCandidates(limit:number,now:Date):Order[] {
    return this.db.prepare(`SELECT o.payload AS order_payload FROM sandbox_records o
      LEFT JOIN sandbox_records v ON v.kind='cdk_voucher' AND json_extract(v.payload,'$.orderId')=o.id
      WHERE o.kind='order' AND json_extract(o.payload,'$.archivedAt') IS NULL
      AND json_extract(o.payload,'$.fulfillmentMode')='cdk'
      AND json_extract(o.payload,'$.paymentStatus') IN ('paid','partially_refunded')
      AND CAST(COALESCE(json_extract(o.payload,'$.ordinaryRefundedMinor.__bigint'),'0') AS INTEGER)=0
      AND NOT EXISTS(SELECT 1 FROM sandbox_records r WHERE r.kind='refund' AND r.merchant_id=o.merchant_id
        AND json_extract(r.payload,'$.orderId')=o.id AND json_extract(r.payload,'$.status') IN ('requested','approved','processing'))
      AND (v.id IS NULL OR (json_extract(v.payload,'$.status')='issuing'
        AND COALESCE(json_extract(v.payload,'$.nextAttemptAt'),json_extract(v.payload,'$.createdAt'))<=?))
      ORDER BY json_extract(o.payload,'$.createdAt') ASC,o.id ASC LIMIT ?`).all(now.toISOString(),Math.min(100,Math.max(1,limit)))
      .map(row=>decode<Order>(String(row.order_payload)));
  }

  findRefundedCdkCleanupOrder(now:Date):Order|null {
    const row=this.db.prepare(`SELECT o.payload AS order_payload FROM sandbox_records o
      JOIN sandbox_records v ON v.kind='cdk_voucher' AND json_extract(v.payload,'$.orderId')=o.id
      WHERE o.kind='order' AND json_extract(o.payload,'$.paymentStatus')='refunded'
      AND json_extract(v.payload,'$.upstreamCdkId') IS NOT NULL
      AND json_extract(v.payload,'$.status') IN ('unused','reserved','disabling','disabled')
      AND (json_extract(v.payload,'$.status')!='disabled' OR json_extract(v.payload,'$.upstreamCodePayload.ciphertext') IS NOT NULL)
      AND (json_extract(v.payload,'$.status')!='disabling' OR json_extract(v.payload,'$.nextAttemptAt')<=?)
      AND NOT EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND NOT (json_extract(f.payload,'$.status') IN ('failed','cancelled')
          AND (COALESCE(json_extract(f.payload,'$.retryAllowed'),0)=1 OR json_extract(f.payload,'$.upstreamStatus') IN ('declined','failed_precharge'))))
      ORDER BY json_extract(o.payload,'$.updatedAt') ASC,o.id ASC LIMIT 1`).get(now.toISOString());
    return row?decode<Order>(String(row.order_payload)):null;
  }

  findRefundedFulfillmentCleanupOrder(now:Date):Order|null {
    const row=this.db.prepare(`SELECT o.payload AS order_payload FROM sandbox_records o
      WHERE o.kind='order' AND json_extract(o.payload,'$.paymentStatus')='refunded'
      AND (COALESCE(json_extract(o.payload,'$.fallbackRechargeAvailable'),0)=1 OR EXISTS(
        SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id AND json_extract(f.payload,'$.orderId')=o.id AND (
          (json_extract(f.payload,'$.status')='queued' AND json_extract(f.payload,'$.upstreamOrderId') IS NULL
            AND json_extract(f.payload,'$.upstreamProvider') IS NULL AND json_extract(f.payload,'$.upstreamStatus') IS NULL
            AND json_extract(f.payload,'$.upstreamLookupToken') IS NULL AND json_extract(f.payload,'$.lookupPayload.ciphertext') IS NULL
            AND (json_extract(f.payload,'$.leaseToken') IS NULL OR (json_extract(f.payload,'$.leaseUntil') IS NOT NULL AND json_extract(f.payload,'$.leaseUntil')<=?)))
          OR (json_extract(f.payload,'$.status') IN ('failed','cancelled') AND COALESCE(json_extract(f.payload,'$.recoveryAction'),'')!='refund'
            AND (COALESCE(json_extract(f.payload,'$.retryAllowed'),0)=1 OR json_extract(f.payload,'$.upstreamStatus') IN ('declined','failed_precharge')))
        ))) ORDER BY json_extract(o.payload,'$.updatedAt') ASC,o.id ASC LIMIT 1`).get(now.toISOString());
    return row?decode<Order>(String(row.order_payload)):null;
  }

  findCostReadCandidate(now:Date,createdAfter:Date):Order|null {
    const row=this.db.prepare(`SELECT o.payload AS order_payload FROM sandbox_records o
      LEFT JOIN sandbox_records c ON c.kind='ops_order_cost' AND c.id=o.id
      WHERE o.kind='order' AND json_extract(o.payload,'$.archivedAt') IS NULL AND json_type(o.payload,'$.costTerms') IS NOT NULL
      AND json_extract(o.payload,'$.paymentStatus')='paid' AND json_extract(o.payload,'$.createdAt')>=?
      AND COALESCE(json_extract(c.payload,'$.status'),'pending_review') NOT IN ('confirmed','disputed')
      AND (json_extract(c.payload,'$.nextCheckAt') IS NULL OR json_extract(c.payload,'$.nextCheckAt')<=?)
      AND EXISTS(SELECT 1 FROM sandbox_records f WHERE f.kind='fulfillment' AND f.merchant_id=o.merchant_id
        AND json_extract(f.payload,'$.orderId')=o.id AND json_extract(f.payload,'$.status')='succeeded')
      ORDER BY json_extract(o.payload,'$.createdAt') ASC,o.id ASC LIMIT 1`).get(createdAfter.toISOString(),now.toISOString());
    return row?decode<Order>(String(row.order_payload)):null;
  }

  consumeNonce(key: string, expiresAt: number, now: number): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM request_nonces WHERE expires_at <= ?").run(now);
      const result = this.db.prepare("INSERT OR IGNORE INTO request_nonces(nonce_key, expires_at) VALUES (?, ?)").run(key, expiresAt);
      return Number(result.changes) === 1;
    });
  }

  transaction<T>(action: () => T): T {
    const depth = this.transactionDepth++;
    const savepoint = `unit_of_work_${depth}`;
    try {
      this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        if (result instanceof Promise) throw new Error("repository_transaction_must_be_synchronous");
        this.db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    } finally {
      this.transactionDepth--;
    }
  }

  saveMerchant(value: Merchant): void { this.put("merchant", value.id, "_global", value.partnerId, value); }
  saveMerchantRole(value: MerchantRole): void { this.put("merchant_role", value.id, value.merchantId, value.code, value); }
  saveMerchantUser(value: MerchantUser): void { this.put("merchant_user", value.id, value.merchantId, value.userId, value); }
  findMerchantRole(merchantId: string, roleId: string): MerchantRole | null { return this.get("merchant_role", roleId, merchantId); }
  findMerchantUser(merchantId: string, userId: string): MerchantUser | null { return this.getByUnique("merchant_user", merchantId, userId); }
  saveApp(value: PartnerApp): void { this.put("partner_app", value.id, value.merchantId, value.appId, value); }
  saveKey(value: ApiKey): void { this.put("api_key", value.id, value.merchantId, value.keyId, value); }
  findMerchantByPartner(partnerId: string): Merchant | null { return this.getByUnique("merchant", "_global", partnerId); }

  findCredential(partnerId: string, keyId: string): CredentialBundle | null {
    const merchant = this.findMerchantByPartner(partnerId);
    if (!merchant) return null;
    const key = this.getByUnique<ApiKey>("api_key", merchant.id, keyId);
    if (!key) return null;
    const app = this.get<PartnerApp>("partner_app", key.appId, merchant.id);
    return app ? {merchant, app, key} : null;
  }

  saveProductGrant(value: ProductGrant): void { this.put("product_grant", `${value.merchantId}:${value.productCode}`, value.merchantId, value.productCode, value); }
  listProductGrants(merchantId: string): ProductGrant[] { return this.list("product_grant", merchantId); }
  findProductGrant(merchantId: string, productCode: string): ProductGrant | null { return this.getByUnique("product_grant", merchantId, productCode); }

  allocatePublicOrderNo(): string {
    const current = this.get<{value: string}>("sequence", "public_order_no")?.value ?? "0";
    const next = BigInt(current) + 1n;
    this.put("sequence", "public_order_no", "_global", "public_order_no", {value: next.toString()});
    return formatPublicOrderNo(next);
  }

  insertOrder(value: Order): void { this.insert("order", value.id, value.merchantId, value.merchantOrderNo, value); }
  updateOrder(value: Order): void { this.requireExisting("order", value.id, value.merchantId); this.put("order", value.id, value.merchantId, value.merchantOrderNo, value); }
  findOrder(merchantId: string, orderId: string): Order | null { return this.get("order", orderId, merchantId); }
  findOrderInternal(orderId: string): Order | null { return this.get("order", orderId); }
  findOrderByMerchantNo(merchantId: string, merchantOrderNo: string): Order | null { return this.getByUnique("order", merchantId, merchantOrderNo); }
  listOrders(merchantId: string): Order[] { return this.list<Order>("order", merchantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); }
  listOrdersInternal(): Order[] { return this.listAll<Order>("order").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()); }
  findOrdersInternal(ids:readonly string[]):Order[] {
    const unique=[...new Set(ids)].filter(Boolean);if(!unique.length)return [];
    return this.db.prepare(`SELECT payload FROM sandbox_records WHERE kind='order' AND id IN (${unique.map(()=>'?').join(',')})`).all(...unique)
      .map(row=>decode<Order>(String(row.payload)));
  }
  listWorkspaceRecords(merchantIds: string[]): {orders: Order[]; fulfillments: Fulfillment[]; vouchers: CdkVoucher[]} {
    if (!merchantIds.length) return {orders: [], fulfillments: [], vouchers: []};
    const result: {orders: Order[]; fulfillments: Fulfillment[]; vouchers: CdkVoucher[]} = {orders: [], fulfillments: [], vouchers: []};
    for (let start = 0; start < merchantIds.length; start += 400) {
      const ids = merchantIds.slice(start, start + 400);
      const rows = this.db.prepare(`SELECT kind,payload FROM sandbox_records WHERE kind IN ('order','fulfillment','cdk_voucher') AND merchant_id IN (${ids.map(()=>"?").join(",")})`).all(...ids);
      for (const row of rows) {
        const value = deserialize(String(row.payload));
        if(row.kind === "order")result.orders.push(value as Order);
        else if(row.kind === "fulfillment")result.fulfillments.push(value as Fulfillment);
        else result.vouchers.push(value as CdkVoucher);
      }
    }
    return result;
  }

  insertPaymentAttempt(value: PaymentAttempt): void { this.insert("payment_attempt", value.id, value.merchantId, value.orderId, value); }
  updatePaymentAttempt(value: PaymentAttempt): void { this.requireExisting("payment_attempt", value.id, value.merchantId); this.put("payment_attempt", value.id, value.merchantId, value.orderId, value); }
  findPaymentAttemptByOrder(merchantId: string, orderId: string): PaymentAttempt | null { return this.getByUnique("payment_attempt", merchantId, orderId); }

  insertFulfillment(value: Fulfillment): void { this.insert("fulfillment", value.id, value.merchantId, `${value.orderId}:${value.attemptNo}`, value); }
  updateFulfillment(value: Fulfillment): void { this.requireExisting("fulfillment", value.id, value.merchantId); this.put("fulfillment", value.id, value.merchantId, `${value.orderId}:${value.attemptNo}`, value); }
  findFulfillment(merchantId: string, fulfillmentId: string): Fulfillment | null { return this.get("fulfillment", fulfillmentId, merchantId); }
  listFulfillments(merchantId: string, orderId: string): Fulfillment[] {
    return this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? AND merchant_id=? AND json_extract(payload,'$.orderId')=?").all("fulfillment",merchantId,orderId).map(r=>deserialize(String(r.payload)) as Fulfillment).sort((a,b)=>a.attemptNo-b.attemptNo);
  }
  listProcessableFulfillments(limit: number, now: Date): Fulfillment[] {
    return this.db.prepare(`SELECT f.payload AS payload FROM sandbox_records f
      LEFT JOIN sandbox_records o ON o.kind='order' AND o.merchant_id=f.merchant_id AND o.id=json_extract(f.payload,'$.orderId')
      WHERE f.kind='fulfillment' AND json_extract(f.payload,'$.status') IN ('queued','running')
      AND COALESCE(json_extract(f.payload,'$.nextCheckAt'),json_extract(f.payload,'$.createdAt'))<=?
      AND (json_extract(f.payload,'$.status')!='queued' OR COALESCE(json_extract(o.payload,'$.liveTest'),0)=0 OR COALESCE(json_extract(f.payload,'$.liveSubmissionApproved'),0)=1)
      ORDER BY COALESCE(json_extract(f.payload,'$.nextCheckAt'),json_extract(f.payload,'$.createdAt')),f.id LIMIT ?`).all(now.toISOString(),limit).map(r=>decode<Fulfillment>(String(r.payload)));
  }
  findFulfillmentByUpstreamClientRequestId(clientRequestId: string): Fulfillment | null {
    const row=this.db.prepare("SELECT payload FROM sandbox_records WHERE kind='fulfillment' AND json_extract(payload,'$.upstreamClientRequestId')=? LIMIT 1").get(clientRequestId);
    return row?decode<Fulfillment>(String(row.payload)):null;
  }

  insertCdkVoucher(value: CdkVoucher): void { this.insert("cdk_voucher", value.id, value.merchantId, value.orderId, value); }
  updateCdkVoucher(value: CdkVoucher): void { this.requireExisting("cdk_voucher", value.id, value.merchantId); this.put("cdk_voucher", value.id, value.merchantId, value.orderId, value); }
  findCdkVoucherById(voucherId: string): CdkVoucher | null { return this.get("cdk_voucher", voucherId); }
  findCdkVoucherByOrder(orderId: string): CdkVoucher | null {
    const row=this.db.prepare("SELECT payload FROM sandbox_records WHERE kind='cdk_voucher' AND json_extract(payload,'$.orderId')=? LIMIT 1").get(orderId);
    return row ? deserialize(String(row.payload)) as CdkVoucher : null;
  }
  findCdkVoucherByPublicCode(publicCode: string): CdkVoucher | null {
    const normalized = publicCode.trim().toUpperCase();
    const row=this.db.prepare("SELECT payload FROM sandbox_records WHERE kind='cdk_voucher' AND json_extract(payload,'$.publicCode')=? LIMIT 1").get(normalized);
    return row ? deserialize(String(row.payload)) as CdkVoucher : null;
  }

  insertSupplierWebhookEvent(value: SupplierWebhookEvent): void { this.insert("supplier_webhook_event", value.eventId, "_platform", value.eventId, value); }
  updateSupplierWebhookEvent(value: SupplierWebhookEvent): void { this.requireExisting("supplier_webhook_event", value.eventId, "_platform"); this.put("supplier_webhook_event", value.eventId, "_platform", value.eventId, value); }
  findSupplierWebhookEvent(eventId: string): SupplierWebhookEvent | null { return this.get("supplier_webhook_event", eventId, "_platform"); }

  saveSupplierConnection(value: SupplierConnection): void { this.put("supplier_connection", value.id, "_platform", value.id, value); }
  findSupplierConnection(connectionId: string): SupplierConnection | null { return this.get("supplier_connection", connectionId, "_platform"); }
  findEnabledSupplierConnection(): SupplierConnection | null { return this.list<SupplierConnection>("supplier_connection", "_platform").find((item) => item.enabled) ?? null; }
  replaceSupplierPlanSnapshots(connectionId: string, product: SupplierPlanSnapshot["product"], values: SupplierPlanSnapshot[]): void {
    this.db.prepare("DELETE FROM sandbox_records WHERE kind=? AND merchant_id=? AND unique_key LIKE ?")
      .run("supplier_plan", connectionId, `${product}:%`);
    for (const value of values) this.put("supplier_plan", `${connectionId}:${product}:${value.plan}`, connectionId, `${product}:${value.plan}`, value);
  }
  listSupplierPlanSnapshots(connectionId: string): SupplierPlanSnapshot[] { return this.list("supplier_plan", connectionId); }
  saveSupplierProductMapping(value: SupplierProductMapping): void { this.put("supplier_mapping", value.productCode, "_platform", value.productCode, value); }
  findSupplierProductMapping(productCode: string): SupplierProductMapping | null { return this.get("supplier_mapping", productCode, "_platform"); }
  listSupplierProductMappings(): SupplierProductMapping[] { return this.list("supplier_mapping", "_platform"); }

  insertRefund(value: Refund): void { this.insert("refund", value.id, value.merchantId, value.merchantRefundNo, value); }
  updateRefund(value: Refund): void { this.requireExisting("refund", value.id, value.merchantId); this.put("refund", value.id, value.merchantId, value.merchantRefundNo, value); }
  findRefund(merchantId: string, refundId: string): Refund | null { return this.get("refund", refundId, merchantId); }
  findRefundByMerchantNo(merchantId: string, merchantRefundNo: string): Refund | null { return this.getByUnique("refund", merchantId, merchantRefundNo); }
  listRefundsForOrder(merchantId: string, orderId: string): Refund[] { return this.db.prepare("SELECT payload FROM sandbox_records WHERE kind='refund' AND merchant_id=? AND json_extract(payload,'$.orderId')=?").all(merchantId,orderId).map(r=>decode<Refund>(String(r.payload))); }
  listPendingRefunds(category:"customer"|"price_adjustment"):Refund[] {
    const type=category==='price_adjustment'?'=':'!=';
    return this.db.prepare(`SELECT payload FROM sandbox_records WHERE kind='refund'
      AND json_extract(payload,'$.status') IN ('requested','processing','failed')
      AND json_extract(payload,'$.type') ${type} 'price_adjustment'
      ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC`).all().map(row=>decode<Refund>(String(row.payload)));
  }

  appendLedger(items: LedgerItem[]): void { for (const item of items) this.put("ledger", item.id, item.merchantId, item.id, item); }
  listLedger(merchantId: string): LedgerItem[] { return this.list<LedgerItem>("ledger", merchantId).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()); }

  insertSettlement(value: Settlement): void { this.insert("settlement", value.id, value.merchantId, value.id, value); }
  updateSettlement(value: Settlement): void { this.requireExisting("settlement", value.id, value.merchantId); this.put("settlement", value.id, value.merchantId, value.id, value); }
  findSettlement(merchantId: string, settlementId: string): Settlement | null { return this.get("settlement", settlementId, merchantId); }
  listSettlements(merchantId: string): Settlement[] { return this.list<Settlement>("settlement", merchantId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); }

  appendOutbox(value: OutboxEvent): void {
    if (this.getByUnique("outbox", value.merchantId, value.eventKey)) return;
    this.put("outbox", value.id, value.merchantId, value.eventKey, value);
  }
  listOutbox(merchantId: string): OutboxEvent[] { return this.list("outbox", merchantId); }
  saveWebhookEndpoint(value: WebhookEndpoint): void { this.put("webhook_endpoint", value.id, value.merchantId, value.url, value); }
  listWebhookEndpoints(merchantId: string): WebhookEndpoint[] { return this.list("webhook_endpoint", merchantId); }
  insertWebhookDelivery(value: WebhookDelivery): void { this.insert("webhook_delivery", value.id, value.merchantId, `${value.outboxEventId}:${value.endpointId}`, value); }

  claimWebhookDeliveries(limit: number, leaseUntil: Date): ClaimedWebhookDelivery[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date();
      const due=this.db.prepare(`SELECT payload FROM sandbox_records WHERE kind='webhook_delivery' AND (
        (json_extract(payload,'$.status')='pending' AND json_extract(payload,'$.nextAttemptAt')<=?) OR
        (json_extract(payload,'$.status')='delivering' AND json_extract(payload,'$.leaseUntil') IS NOT NULL AND json_extract(payload,'$.leaseUntil')<=?))
        ORDER BY json_extract(payload,'$.nextAttemptAt') ASC,id ASC LIMIT ?`).all(now.toISOString(),now.toISOString(),Math.min(100,Math.max(1,limit)))
        .map(row=>decode<WebhookDelivery>(String(row.payload)));
      const result: ClaimedWebhookDelivery[] = [];
      for (const item of due) {
        const delivery: WebhookDelivery = {...item, status: "delivering", leaseUntil, attemptCount: item.attemptCount + 1};
        this.put("webhook_delivery", delivery.id, delivery.merchantId, `${delivery.outboxEventId}:${delivery.endpointId}`, delivery);
        const endpoint = this.get<WebhookEndpoint>("webhook_endpoint", delivery.endpointId, delivery.merchantId);
        const event = this.get<OutboxEvent>("outbox", delivery.outboxEventId, delivery.merchantId);
        if (endpoint && event) result.push({delivery, endpoint, event});
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markWebhookDelivered(deliveryId: string, responseStatus: number, deliveredAt: Date): void {
    const current = this.get<WebhookDelivery>("webhook_delivery", deliveryId);
    if (!current) throw new Error("webhook_delivery_not_found");
    this.put("webhook_delivery", current.id, current.merchantId, `${current.outboxEventId}:${current.endpointId}`, {
      ...current, status: "delivered", responseStatus, deliveredAt, leaseUntil: null, lastErrorCode: null,
    });
  }

  rescheduleWebhookDelivery(deliveryId: string, nextAttemptAt: Date | null, errorCode: string): void {
    const current = this.get<WebhookDelivery>("webhook_delivery", deliveryId);
    if (!current) throw new Error("webhook_delivery_not_found");
    this.put("webhook_delivery", current.id, current.merchantId, `${current.outboxEventId}:${current.endpointId}`, {
      ...current,
      status: nextAttemptAt ? "pending" : "dead_letter",
      nextAttemptAt: nextAttemptAt ?? current.nextAttemptAt,
      leaseUntil: null,
      lastErrorCode: errorCode,
    });
  }

  appendAudit(value: AuditLog): void { this.put("audit", value.id, value.merchantId ?? "_platform", value.id, value); }
  listAudit(merchantId: string): AuditLog[] { return this.list("audit", merchantId); }

  getIdempotency(merchantId: string, appId: string, routeKey: string, key: string): IdempotencyRecord | null {
    return this.get("idempotency", idempotencyId(merchantId, appId, routeKey, key), merchantId);
  }
  saveIdempotency(value: IdempotencyRecord): void {
    const id = idempotencyId(value.merchantId, value.appId, value.routeKey, value.key);
    this.put("idempotency", id, value.merchantId, `${value.appId}:${value.routeKey}:${value.key}`, value);
  }

  close(): void { this.db.close(); }

  private insert<T>(kind: string, id: string, merchantId: string, uniqueKey: string, value: T): void {
    this.db.prepare("INSERT INTO sandbox_records(kind,id,merchant_id,unique_key,payload,updated_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, merchantId, uniqueKey, encode(value), new Date().toISOString());
  }

  private put<T>(kind: string, id: string, merchantId: string, uniqueKey: string, value: T): void {
    this.db.prepare(`
      INSERT INTO sandbox_records(kind,id,merchant_id,unique_key,payload,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET merchant_id=excluded.merchant_id, unique_key=excluded.unique_key,
        payload=excluded.payload, updated_at=excluded.updated_at
    `).run(kind, id, merchantId, uniqueKey, encode(value), new Date().toISOString());
  }

  private get<T>(kind: string, id: string, merchantId?: string): T | null {
    const row = merchantId === undefined
      ? this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? AND id=?").get(kind, id)
      : this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? AND id=? AND merchant_id=?").get(kind, id, merchantId);
    return row ? decode<T>(String((row as {payload: unknown}).payload)) : null;
  }

  private getByUnique<T>(kind: string, merchantId: string, uniqueKey: string): T | null {
    const row = this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? AND merchant_id=? AND unique_key=?").get(kind, merchantId, uniqueKey);
    return row ? decode<T>(String((row as {payload: unknown}).payload)) : null;
  }

  private list<T>(kind: string, merchantId: string): T[] {
    const rows = this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? AND merchant_id=? ORDER BY updated_at DESC").all(kind, merchantId);
    return rows.map((row) => decode<T>(String((row as {payload: unknown}).payload)));
  }

  private listAll<T>(kind: string): T[] {
    const rows = this.db.prepare("SELECT payload FROM sandbox_records WHERE kind=? ORDER BY updated_at").all(kind);
    return rows.map((row) => decode<T>(String((row as {payload: unknown}).payload)));
  }

  private requireExisting(kind: string, id: string, merchantId: string): void {
    if (!this.get(kind, id, merchantId)) throw new Error(`${kind}_not_found`);
  }
}

const dateKeys = new Set([
  "archivedAt",
  "dueAt",
  "lockedUntil", "startsAt", "endsAt", "readAt", "upstreamCheckedAt",
  "notBefore", "expiresAt", "paidAt", "createdAt", "updatedAt", "finishedAt", "clearedAt", "progressUpdatedAt",
  "refundedAt", "occurredAt", "periodFrom", "periodTo", "sealedAt", "nextAttemptAt", "leaseUntil", "deliveredAt",
  "verifiedAt", "activatedAt", "sentAt", "nextCheckAt", "consumedAt", "receivedAt", "processedAt", "lastTestAt", "lastPlanSyncAt", "syncedAt",
  "generatedAt", "reconciledAt",
]);

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? {__bigint: item.toString()} : item);
}

function decode<T>(value: string): T {
  return JSON.parse(value, (key, item: unknown) => {
    if (item && typeof item === "object" && "__bigint" in item) return BigInt(String((item as {__bigint: unknown}).__bigint));
    if (dateKeys.has(key) && typeof item === "string") return new Date(item);
    return item;
  }) as T;
}

function deserialize(value: string): unknown { return decode<unknown>(value); }

function idempotencyId(merchantId: string, appId: string, routeKey: string, key: string): string {
  return createHash("sha256").update(`${merchantId}\0${appId}\0${routeKey}\0${key}`).digest("hex");
}
