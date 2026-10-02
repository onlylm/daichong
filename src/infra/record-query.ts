import type {Repository} from './repository.js';
import type {Order, Fulfillment, CdkVoucher, Refund, PaymentAttempt, OutboxEvent, AuditLog, Merchant} from '../domain/model.js';
import type {OperationsRecords} from '../operations/model.js';

export interface QueryRecords extends OperationsRecords { merchant:Merchant; order:Order; fulfillment:Fulfillment; cdk_voucher:CdkVoucher; refund:Refund; payment_attempt:PaymentAttempt; outbox:OutboxEvent; audit:AuditLog }
export interface RecordFilter {field:string;op?:'eq'|'ne'|'in'|'lt'|'lte'|'lte_or_null'|'gte'|'gt'|'contains'|'is_null'|'not_null';value?:string|number|boolean|null|Date|Array<string|number>}
export interface RecordQuery {merchantId?:string;filters?:RecordFilter[];searchAny?:{fields:string[];text:string};page?:number;limit?:number;orderBy?:string;direction?:'asc'|'desc';afterId?:string;count?:boolean}
export interface RecordPage<T> {data:T[];meta:{total:number;page:number;limit:number;pages:number}}

/** SQL in production; memory fallback is for isolated tests, never a cached financial balance. */
export function queryRecords<K extends keyof QueryRecords>(repo:Repository,kind:K,q:RecordQuery={}):RecordPage<QueryRecords[K]> {
  if(repo.queryRecords)return repo.queryRecords(kind,q);
  const domain:Record<string,()=>unknown[]>={merchant:()=>repo.listMerchants(),order:()=>q.merchantId?repo.listOrders(q.merchantId):repo.listOrdersInternal(),
    fulfillment:()=>repo.listMerchants().flatMap(m=>repo.listOrders(m.id).flatMap(o=>repo.listFulfillments(m.id,o.id))),
    cdk_voucher:()=>repo.listOrdersInternal().flatMap(o=>repo.findCdkVoucherByOrder(o.id)??[]),
    refund:()=>repo.listOrdersInternal().flatMap(o=>repo.listRefundsForOrder(o.merchantId,o.id)),
    payment_attempt:()=>repo.listOrdersInternal().flatMap(o=>repo.findPaymentAttemptByOrder(o.merchantId,o.id)??[]),
    outbox:()=>repo.listMerchants().flatMap(m=>repo.listOutbox(m.id)),
    audit:()=>q.merchantId?repo.listAudit(q.merchantId):repo.listAllAudit?.()??repo.listMerchants().flatMap(m=>repo.listAudit(m.id))};
  const values=(domain[kind]?.()??repo.listOperations(kind as keyof OperationsRecords,q.merchantId)) as QueryRecords[K][];
  const field=(v:unknown,path:string):unknown=>path.split('.').reduce((o,k)=>(o as Record<string,unknown>)?.[k],v);
  const scalar=(v:unknown):any=>v instanceof Date?v.toISOString():v;
  const rows=values.filter(v=>(!q.merchantId||('merchantId' in v && v.merchantId===q.merchantId))&&(!q.afterId||String((v as any).id)>q.afterId)
    &&(!q.searchAny||q.searchAny.fields.some(key=>String(field(v,key)??'').toLowerCase().includes(q.searchAny!.text.toLowerCase())))&&(q.filters??[]).every(f=>{
    const a=scalar(field(v,f.field)),b=scalar(f.value);
    switch(f.op??'eq'){case 'is_null':return a==null;case 'not_null':return a!=null;case 'ne':return a!==b;case 'in':return (b as unknown[]).includes(a);case 'contains':return String(a??'').toLowerCase().includes(String(b).toLowerCase());case 'lt':return a!=null&&a<b;case 'lte':return a!=null&&a<=b;case 'lte_or_null':return a==null||a<=b;case 'gte':return a!=null&&a>=b;case 'gt':return a!=null&&a>b;default:return a===b;}
  })).sort((a,b)=>{const x=scalar(field(a,q.orderBy??'createdAt'))??'',y=scalar(field(b,q.orderBy??'createdAt'))??'';return (x<y?-1:x>y?1:String((a as any).id).localeCompare(String((b as any).id)))*(q.direction==='asc'?1:-1);});
  const limit=Math.min(500,Math.max(1,q.limit??30)),total=rows.length,pages=Math.max(1,Math.ceil(total/limit)),page=Math.min(Math.max(1,q.page??1),pages);
  return {data:rows.slice((page-1)*limit,page*limit),meta:{total,page,limit,pages}};
}
