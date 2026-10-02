import type {Repository} from "../infra/repository.js";
import {queryRecords, type RecordFilter} from "../infra/record-query.js";
import {isPlatform, permissionList, requirePermission} from "./accounts.js";
import type {Actor} from "./model.js";
import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";

export const searchKinds = ["all", "order", "agent", "cdk", "payment", "wallet"] as const;
type SearchKind = typeof searchKinds[number];
interface SearchItem {id:string; title:string; description:string; orderId?:string; merchantId?:string; occurredAt?:Date|null}
export function workspaceSearch(repo:Repository, actor:Actor, input:{q:string;kind:SearchKind;page:number}) {
  requirePermission(actor,"orders.read");
  const q=input.q.trim();
  if(q.length<2||q.length>120)throw new AppError(422,"search_query_invalid","请输入 2 至 120 个字符，不要输入 Session、密码或密钥");
  const platform=isPlatform(actor),rights=permissionList(actor),can=(p:string)=>rights.includes("*")||rights.includes(p);
  const scope=platform?{}:{merchantId:actor.merchantId!};
  const groups:Array<{kind:string;label:string;data:SearchItem[];meta:{total:number;page:number;limit:number;pages:number}}>=[];
  const wanted=(kind:SearchKind)=>input.kind==="all"||input.kind===kind;
  const options=(fields:string[])=>({...scope,searchAny:{fields,text:q},page:input.page,limit:10});
  if(wanted("order")){
    const result=queryRecords(repo,"order",options(["id","merchantOrderNo"]));
    groups.push({kind:"order",label:"订单",meta:result.meta,data:result.data.map(o=>({id:o.id,title:o.id,description:o.productCode,orderId:o.id,occurredAt:o.createdAt}))});
  }
  if(wanted("agent")&&platform&&can("agents.read")){
    const result=queryRecords(repo,"merchant",{...options(["id","name","partnerId"])});
    groups.push({kind:"agent",label:"代理",meta:result.meta,data:result.data.map(m=>({id:m.id,title:m.name,description:m.partnerId,merchantId:m.id}))});
  }
  if(wanted("cdk")){
    const result=queryRecords(repo,"cdk_voucher",options(["publicCode"]));
    groups.push({kind:"cdk",label:"平台卡密",meta:result.meta,data:result.data.map(c=>({id:c.id,title:"卡密 …"+c.publicCode.slice(-6),description:"平台签发卡密 · "+c.status,orderId:c.orderId,occurredAt:c.createdAt}))});
  }
  if(wanted("payment")&&platform&&can("wallet.read")){
    const result=queryRecords(repo,"payment_attempt",options(["id","providerRef","orderId"]));
    groups.push({kind:"payment",label:"支付流水",meta:result.meta,data:result.data.map(p=>({id:p.id,title:p.providerRef||p.id,description:"支付记录 · "+p.status,orderId:p.orderId,occurredAt:p.paidAt||p.createdAt}))});
  }
  if(wanted("wallet")&&can("wallet.read")){
    const result=queryRecords(repo,"wallet_entry",options(["id","reference"]));
    groups.push({kind:"wallet",label:"钱包流水",meta:result.meta,data:result.data.map(e=>({id:e.id,title:e.reference||e.id,description:"采购变动 ¥"+minorToMoney(e.procurementDelta)+" / 收益变动 ¥"+minorToMoney(e.earningsDelta),merchantId:e.merchantId!,occurredAt:e.createdAt}))});
  }
  return {query:q,groups,total:groups.reduce((n,g)=>n+g.meta.total,0)};
}

export function workspaceAudit(repo:Repository,actor:Actor,input:{merchantId?:string|undefined;target?:string|undefined;action?:string|undefined;from?:string|undefined;to?:string|undefined;page:number;limit:number}) {
  requirePermission(actor,"audit.read");
  if(!isPlatform(actor))throw new AppError(403,"permission_denied","仅平台可查看操作审计");
  const filters:RecordFilter[]=[];
  if(input.target)filters.push({field:"targetId",value:input.target});
  if(input.action)filters.push({field:"action",op:"contains",value:input.action});
  if(input.from)filters.push({field:"createdAt",op:"gte",value:input.from+"T00:00:00+08:00"});
  if(input.to)filters.push({field:"createdAt",op:"lt",value:new Date(Date.parse(input.to+"T00:00:00+08:00")+86400000)});
  // Persisted timestamps use UTC ISO strings; normalize both range bounds.
  if(input.from)filters.find(f=>f.field==="createdAt"&&f.op==="gte")!.value=new Date(input.from+"T00:00:00+08:00");
  const result=queryRecords(repo,"audit",{...(input.merchantId?{merchantId:input.merchantId}:{}),filters,page:input.page,limit:input.limit});
  return {...result,data:result.data.map(a=>{
    let orderId:string|null=null;
    if(a.targetType==="order")orderId=repo.findOrderInternal(a.targetId)?.id??null;
    if(a.targetType==="fulfillment")orderId=(a.merchantId?repo.findFulfillment(a.merchantId,a.targetId):null)?.orderId??null;
    if(a.targetType==="refund")orderId=queryRecords(repo,"refund",{filters:[{field:"id",value:a.targetId}],limit:1,count:false}).data[0]?.orderId??null;
    return {id:a.id,action:a.action,actorId:a.actorId,actorType:a.actorType,targetType:a.targetType,targetId:a.targetId,
      merchantId:a.merchantId,requestId:a.requestId,createdAt:a.createdAt,orderId};
  })};
}
