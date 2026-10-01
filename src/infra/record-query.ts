import type {Repository} from './repository.js';
import type {Order, Fulfillment, CdkVoucher, Refund, PaymentAttempt, OutboxEvent} from '../domain/model.js';
import type {OperationsRecords} from '../operations/model.js';

export interface QueryRecords extends OperationsRecords { order:Order; fulfillment:Fulfillment; cdk_voucher:CdkVoucher; refund:Refund; payment_attempt:PaymentAttempt; outbox:OutboxEvent }
export interface RecordFilter {field:string;op?:'eq'|'in'|'lte'|'gte'|'gt'|'is_null';value?:string|number|boolean|null|Date|Array<string|number>}
export interface RecordQuery {merchantId?:string;filters?:RecordFilter[];page?:number;limit?:number;orderBy?:string;direction?:'asc'|'desc';afterId?:string;count?:boolean}
export interface RecordPage<T> {data:T[];meta:{total:number;page:number;limit:number;pages:number}}

/** SQL in production; memory fallback is for isolated tests, never a cached financial balance. */
export function queryRecords<K extends keyof QueryRecords>(repo:Repository,kind:K,q:RecordQuery={}):RecordPage<QueryRecords[K]> {
  if(repo.queryRecords)return repo.queryRecords(kind,q);
  const domain:Record<string,()=>unknown[]>={order:()=>q.merchantId?repo.listOrders(q.merchantId):repo.listOrdersInternal(),
    fulfillment:()=>repo.listMerchants().flatMap(m=>repo.listOrders(m.id).flatMap(o=>repo.listFulfillments(m.id,o.id))),
    cdk_voucher:()=>repo.listOrdersInternal().flatMap(o=>repo.findCdkVoucherByOrder(o.id)??[]),
    refund:()=>repo.listOrdersInternal().flatMap(o=>repo.listRefundsForOrder(o.merchantId,o.id)),
    payment_attempt:()=>repo.listOrdersInternal().flatMap(o=>repo.findPaymentAttemptByOrder(o.merchantId,o.id)??[]),
    outbox:()=>repo.listMerchants().flatMap(m=>repo.listOutbox(m.id))};
  const values=(domain[kind]?.()??repo.listOperations(kind as keyof OperationsRecords,q.merchantId)) as QueryRecords[K][];
  const field=(v:unknown,path:string):unknown=>path.split('.').reduce((o,k)=>(o as Record<string,unknown>)?.[k],v);
  const scalar=(v:unknown):any=>v instanceof Date?v.toISOString():v;
  const rows=values.filter(v=>(!q.merchantId||v.merchantId===q.merchantId)&&(!q.afterId||String((v as any).id)>q.afterId)&&(q.filters??[]).every(f=>{
    const a=scalar(field(v,f.field)),b=scalar(f.value);
    switch(f.op??'eq'){case 'is_null':return a==null;case 'in':return (b as unknown[]).includes(a);case 'lte':return a!=null&&a<=b;case 'gte':return a!=null&&a>=b;case 'gt':return a!=null&&a>b;default:return a===b;}
  })).sort((a,b)=>{const x=scalar(field(a,q.orderBy??'createdAt'))??'',y=scalar(field(b,q.orderBy??'createdAt'))??'';return (x<y?-1:x>y?1:String((a as any).id).localeCompare(String((b as any).id)))*(q.direction==='asc'?1:-1);});
  const limit=Math.min(500,Math.max(1,q.limit??30)),total=rows.length,pages=Math.max(1,Math.ceil(total/limit)),page=Math.min(Math.max(1,q.page??1),pages);
  return {data:rows.slice((page-1)*limit,page*limit),meta:{total,page,limit,pages}};
}
