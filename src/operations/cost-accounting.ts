import {createHash} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import type {Order} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import {minorToMoney, moneyToMinor} from "../domain/money.js";
import {isPlatform, requirePermission, permissionList} from "./accounts.js";
import type {Actor, OrderCost, CostSavingPayment} from "./model.js";
import type {AuditService} from "../modules/audit-service.js";
import type {SupplierManagementService} from "../modules/supplier-management-service.js";
import {queryRecords} from "../infra/record-query.js";

const positive = (v: bigint) => v > 0n ? v : 0n;
export function convertUsd(usd: bigint, rate: string): bigint {
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(rate) || Number(rate) <= 0) throw new AppError(422, "invalid_fx", "真实资金汇率须大于零，最多六位小数");
  const [whole, fraction = ""] = rate.split(".");
  const scaled = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const sign = usd < 0n ? -1n : 1n;
  return sign * ((positive(usd * sign) * scaled + 500_000n) / 1_000_000n);
}
export function calculateCost(cost: OrderCost, supply: bigint) {
  const known = cost.status === "confirmed" && cost.actualUsdMinor !== null;
  const saving = known && cost.standardUsdMinor !== null ? positive(cost.standardUsdMinor - cost.actualUsdMinor!) : null;
  const retained = saving === null ? null : saving < cost.retainedUsdMinor ? saving : cost.retainedUsdMinor;
  const due = saving === null ? null : saving - retained!;
  // A refund benchmark or procurement price cannot substitute for an actual funding cost.
  const actualCny = known && cost.fxRate ? convertUsd(cost.actualUsdMinor! + cost.additionalFeesUsdMinor, cost.fxRate) : null;
  const liabilityCny = due === null ? null : due === 0n ? 0n : cost.fxRate ? convertUsd(due, cost.fxRate) : null;
  const grossProfit = actualCny === null || liabilityCny === null ? null : supply - actualCny - liabilityCny;
  return {saving, retained, due, actualCny, grossProfit,
    remaining: due === null ? null : positive(due - cost.paidUsdMinor),
    anomaly: known && cost.standardUsdMinor !== null && cost.actualUsdMinor! > cost.standardUsdMinor};
}
const show = (value: bigint | null) => value === null ? null : minorToMoney(value);

export class CostAccountingService {
  private nextScanAt=0;
  constructor(private readonly repo: Repository, private readonly audit: AuditService, private readonly supplier: SupplierManagementService,private readonly autoReadEnabled=true) {}
  private order(id: string): Order {const o=this.repo.findOrderInternal(id);if(!o)throw new AppError(404,"order_not_found","订单不存在");return o;}
  private admin(actor: Actor) {requirePermission(actor,"wallet.review");if(!isPlatform(actor))throw new AppError(403,"permission_denied","成本核验和补差核销仅限平台财务");}
  private initial(o: Order, actorId = "system"): OrderCost {
    return {id:o.id,merchantId:o.merchantId,orderId:o.id,upstreamOrderId:null,standardUsdMinor:o.costTerms?.refundBenchmarkUsdMinor??o.costTerms?.standardUsdMinor??null,
      standardCnyMinor:o.costTerms?.standardCnyMinor??null,retainedUsdMinor:o.costTerms?.retainedUsdMinor??15n,
      actualUsdMinor:null,additionalFeesUsdMinor:0n,fxRate:null,sourceReference:null,evidence:null,source:null,status:"pending_review",
      destination:null,paidUsdMinor:0n,customerReceipt:"pending",nativeAmountMinor:null,nativeCurrency:null,
      upstreamCheckedAt:null,nextCheckAt:null,version:0,createdBy:actorId,reviewedBy:null,createdAt:new Date(),updatedAt:new Date()};
  }
  private present(o:Order,c:OrderCost,payments:CostSavingPayment[],platform:boolean) {
    const n=calculateCost(c,o.supplyAmountMinor);
    const payoutState=o.ordinaryRefundedMinor>0n?"suspended_refund":n.due===null?"pending_review":n.due===0n?"not_required":c.paidUsdMinor>=n.due?"paid":c.paidUsdMinor>0n?"partially_paid":"pending_payment";
    const common={orderId:o.id,status:c.status,destination:c.destination,payoutState,refundDueUsd:show(n.due),paidUsd:show(c.paidUsdMinor),remainingUsd:show(n.remaining),customerReceipt:c.customerReceipt,version:c.version};
    if(!platform)return common;
    return {...common,refundBenchmarkUsd:show(c.standardUsdMinor),standardUsd:show(c.standardUsdMinor),standardCny:show(c.standardCnyMinor),actualUsd:show(c.actualUsdMinor),additionalFeesUsd:show(c.additionalFeesUsdMinor),
      grossSavingUsd:show(n.saving),retainedFeeUsd:show(c.retainedUsdMinor),retainedAppliedUsd:show(n.retained),actualCostCny:show(n.actualCny),grossProfitCny:show(n.grossProfit),anomaly:n.anomaly,
      fxRate:c.fxRate,sourceReference:c.sourceReference,evidence:c.evidence,upstreamOrderId:c.upstreamOrderId,nativeAmountMinor:c.nativeAmountMinor,nativeCurrency:c.nativeCurrency,upstreamCheckedAt:c.upstreamCheckedAt,
      tradeCandidate:c.tradeCandidate?{...c.tradeCandidate,usd:minorToMoney(BigInt(c.tradeCandidate.usdMinor))}:null,tradeMatchIssue:c.tradeMatchIssue??null,
      payments:payments.map(p=>({id:p.id,usd:show(p.usdMinor),currency:p.paymentCurrency,amount:show(p.paymentMinor),method:p.method,reference:p.reference,evidence:p.evidence,createdAt:p.createdAt,destination:p.destination})),
      existingCustomerAdjustments:minorToMoney(o.priceAdjustmentRefundedMinor),historicalTermsMissing:!o.costTerms,updatedAt:c.updatedAt};
  }
  view(actor: Actor, id: string) {
    if(!permissionList(actor).some(p=>["*","orders.read","wallet.read"].includes(p)))throw new AppError(403,"permission_denied","无权查看财务记录");
    const o=this.order(id);if(!isPlatform(actor)&&actor.merchantId!==o.merchantId)throw new AppError(404,"order_not_found","订单不存在");
    const c=this.repo.getOperations("order_cost",id)??this.initial(o),payments=isPlatform(actor)?this.repo.listOperations("cost_saving_payment",o.merchantId).filter(p=>p.orderId===id):[];
    return this.present(o,c,payments,isPlatform(actor));
  }
  list(actor: Actor) {
    return this.page(actor,{status:"all",page:1,limit:200}).data;
  }
  page(actor: Actor,input:{status:"all"|OrderCost["status"];search?:string;page:number;limit:number}) {
    this.admin(actor);
    const limit=Math.min(100,Math.max(1,input.limit)),requestedPage=Math.max(1,input.page),search=input.search?.trim()??"";
    const sql=this.repo.queryCostAccountingOrders?.({status:input.status,search,page:requestedPage,limit});
    let orders:Order[],merchantMap:Map<string,string>,meta:{total:number;page:number;limit:number;pages:number};
    if(sql){orders=sql.orders;merchantMap=new Map(sql.merchantNames.map(value=>[value.merchantId,value.name]));meta=sql.meta;}
    else {
      const costs=new Map(this.repo.listOperations("order_cost").map(c=>[c.orderId,c]));
      const merchants=this.repo.listMerchants();merchantMap=new Map(merchants.map(value=>[value.id,value.name]));
      const records=this.repo.listWorkspaceRecords?.(merchants.map(value=>value.id));
      const succeeded=records?new Set(records.fulfillments.filter(value=>value.status==="succeeded").map(value=>value.orderId)):null;
      const needle=search.toLowerCase();
      const eligible=(records?.orders??this.repo.listOrdersInternal()).filter(order=>!order.archivedAt&&!order.liveTest&&["paid","partially_refunded","refunded"].includes(order.paymentStatus))
        .filter(order=>costs.has(order.id)||(succeeded?succeeded.has(order.id):this.repo.listFulfillments(order.merchantId,order.id).some(value=>value.status==="succeeded")))
        .filter(order=>input.status==="all"?(true):(costs.get(order.id)?.status??"pending_review")===input.status)
        .filter(order=>!needle||[order.id,order.merchantOrderNo,merchantMap.get(order.merchantId)??"",this.repo.findMerchantById(order.merchantId)?.partnerId??""].some(value=>value.toLowerCase().includes(needle)))
        .sort((a,b)=>b.createdAt.getTime()-a.createdAt.getTime()||b.id.localeCompare(a.id));
      const total=eligible.length,pages=Math.max(1,Math.ceil(total/limit)),page=Math.min(requestedPage,pages);
      orders=eligible.slice((page-1)*limit,page*limit);meta={total,page,limit,pages};
    }
    const orderIds=orders.map(order=>order.id);
    const costs=new Map(queryRecords(this.repo,"order_cost",{filters:[{field:"orderId",op:"in",value:orderIds}],limit:Math.max(1,orderIds.length),count:false}).data.map(cost=>[cost.orderId,cost]));
    return {data:orders.map(order=>({...this.present(order,costs.get(order.id)??this.initial(order),[],true),
      merchantName:merchantMap.get(order.merchantId)??"",productCode:order.productCode,collectionMode:order.collectionMode,createdAt:order.createdAt})),meta};
  }
  verify(actor: Actor,id:string,input:{version:number;standardUsd?:string|null|undefined;standardCny?:string|null|undefined;actualUsd:string;feesUsd:string;retainedUsd:string;fxRate?:string|null|undefined;sourceReference:string;evidence:string;confirmEvidence:true;confirmHistoricalTerms?:boolean|undefined;confirmZeroCost?:boolean|undefined;destination:OrderCost["destination"]}) {
    this.admin(actor);return this.repo.transaction(()=>{
      const o=this.order(id),c=this.repo.getOperations("order_cost",id)??this.initial(o,actor.id);
      if(c.version!==input.version)throw new AppError(409,"cost_changed","核算记录已更新，请刷新后重试");
      if(c.paidUsdMinor>0n)throw new AppError(409,"cost_already_paid","已有补差付款凭证，不能覆盖成本或更换去向；请走争议处理");
      if(!["paid","partially_refunded"].includes(o.paymentStatus)||o.ordinaryRefundedMinor>0n||!this.repo.listFulfillments(o.merchantId,id).some(f=>f.status==="succeeded"))throw new AppError(409,"cost_order_ineligible","仅已付且履约成功、未发生普通退款的订单可确认成本");
      if(!input.confirmEvidence||input.evidence.trim().length<6)throw new AppError(422,"cost_evidence_required","须确认真实清算凭证及订单关联，不能使用报价或授权冻结");
      if(!o.costTerms&&!input.confirmHistoricalTerms)throw new AppError(422,"historical_cost_confirmation_required","历史订单无退差基准快照，须人工核实下单时约定");
      const standard=input.standardUsd?moneyToMinor(input.standardUsd):c.standardUsdMinor;
      if(standard===null||standard<=0n)throw new AppError(422,"cost_standard_required","请先配置并核实美元退差基准");
      const frozen = o.costTerms?.refundBenchmarkUsdMinor ?? o.costTerms?.standardUsdMinor;
      if(frozen!=null&&standard!==frozen)throw new AppError(409,"frozen_cost_changed","不得修改订单创建时冻结的退差基准");
      const actual=moneyToMinor(input.actualUsd);if(actual===0n&&!input.confirmZeroCost)throw new AppError(422,"zero_cost_requires_evidence","零成本必须显式确认真实凭证，不接受上游缺失值");
      const ref=input.sourceReference.trim();if(ref.length<6)throw new AppError(422,"source_reference_required","请填写清算流水唯一标识");
      if(queryRecords(this.repo,"order_cost",{filters:[{field:"sourceReference",value:ref},{field:"orderId",op:"ne",value:id}],limit:1,count:false}).data.length)throw new AppError(409,"cost_evidence_reused","该上游清算凭证已关联其他订单");
      if(input.fxRate)convertUsd(1n,input.fxRate);
      if(o.costTerms&&moneyToMinor(input.retainedUsd)!==o.costTerms.retainedUsdMinor)throw new AppError(409,"frozen_cost_changed","不得修改已冻结保留费用");
      if(o.priceAdjustmentRefundedMinor>0n||this.repo.listRefundsForOrder(o.merchantId,id).some(r=>r.type==="price_adjustment"&&!["rejected","cancelled"].includes(r.status)))throw new AppError(409,"legacy_adjustment_exists","已有客户差价退款记录，禁止再生成另一条补差路径；请人工核对原退款");
      const next:OrderCost={...c,standardUsdMinor:standard,standardCnyMinor:input.standardCny?moneyToMinor(input.standardCny):c.standardCnyMinor,
        actualUsdMinor:actual,additionalFeesUsdMinor:moneyToMinor(input.feesUsd),retainedUsdMinor:moneyToMinor(input.retainedUsd),fxRate:input.fxRate||null,
        sourceReference:ref,evidence:input.evidence.trim(),source:"manual_verified",status:"confirmed",destination:input.destination,
        reviewedBy:actor.id,version:c.version+1,updatedAt:new Date()};
      if(o.costTerms?.standardCnyMinor!=null&&next.standardCnyMinor!==o.costTerms.standardCnyMinor)throw new AppError(409,"frozen_cost_changed","不得修改已冻结人民币内部成本");
      this.repo.saveOperations("order_cost",next);this.log(actor,o,"cost.verify");return this.view(actor,id);
    });
  }
  recordPayment(actor:Actor,id:string,input:{version:number;usd:string;currency:"USD"|"CNY";amount:string;fxRate?:string|undefined;method:string;reference:string;evidence:string;requestKey:string;confirmActualPayout:true}) {
    this.admin(actor);return this.repo.transaction(()=>{
      const o=this.order(id),c=this.repo.getOperations("order_cost",id),n=c&&calculateCost(c,o.supplyAmountMinor);
      const replay=queryRecords(this.repo,"cost_saving_payment",{merchantId:o.merchantId,filters:[{field:"requestKey",value:input.requestKey}],limit:1,count:false}).data[0];
      if(replay){if(replay.orderId!==id||replay.usdMinor!==moneyToMinor(input.usd)||replay.paymentMinor!==moneyToMinor(input.amount)||replay.paymentCurrency!==input.currency||replay.method!==input.method.trim()||replay.reference!==input.reference.trim()||replay.fxRate!==(input.fxRate??null)||replay.evidence!==input.evidence.trim())throw new AppError(409,"cost_payment_conflict","付款请求号已用于不同内容");return this.view(actor,id);}
      if(!c||c.status!=="confirmed"||!c.destination||!n?.remaining||c.version!==input.version)throw new AppError(409,"cost_payment_not_ready","请先确认成本、补差去向及当前版本");
      if(!["paid","partially_refunded"].includes(o.paymentStatus)||o.ordinaryRefundedMinor>0n||o.priceAdjustmentRefundedMinor>0n||this.repo.listRefundsForOrder(o.merchantId,id).some(r=>!["rejected","cancelled"].includes(r.status)))throw new AppError(409,"refund_blocks_cost_payment","存在订单退款，禁止重复补差支付");
      if(!input.confirmActualPayout||input.evidence.trim().length<6)throw new AppError(422,"actual_payout_required","只登记已真实打款，不会由本操作转账");
      const usd=moneyToMinor(input.usd),amount=moneyToMinor(input.amount);if(usd<=0n||usd>n.remaining||amount<=0n)throw new AppError(422,"cost_payment_exceeded","付款金额须为正且不得超过剩余补差");
      if(input.currency==="USD"&&amount!==usd||input.currency==="CNY"&&(!input.fxRate||convertUsd(usd,input.fxRate)!==amount))throw new AppError(422,"payout_currency_mismatch","付款金额与核销美元金额、真实汇率不一致");
      const reference=input.reference.trim(),method=input.method.trim();if(reference.length<6||method.length<2)throw new AppError(422,"payout_reference_required","请填写付款方式和唯一渠道流水");
      const paymentId="csp_"+createHash("sha256").update(method.toLowerCase()+":"+reference.toLowerCase()).digest("hex");
      if(this.repo.getOperations("cost_saving_payment",paymentId))throw new AppError(409,"payout_reference_reused","该付款凭证已经核销，不能重复使用");
      const p:CostSavingPayment={id:paymentId,merchantId:o.merchantId,orderId:id,costId:c.id,destination:c.destination,usdMinor:usd,paymentCurrency:input.currency,paymentMinor:amount,fxRate:input.fxRate??null,method,reference,evidence:input.evidence.trim(),requestKey:input.requestKey,actorId:actor.id,createdAt:new Date()};
      this.repo.saveOperations("cost_saving_payment",p,true);this.repo.saveOperations("order_cost",{...c,paidUsdMinor:c.paidUsdMinor+usd,version:c.version+1,updatedAt:new Date()});this.log(actor,o,"cost.payment.record");return this.view(actor,id);
    });
  }
  async sync(actor:Actor,id:string) {
    this.admin(actor);const o=this.order(id),f=this.repo.listFulfillments(o.merchantId,id).filter(v=>v.upstreamOrderId).at(-1);
    if(!f?.upstreamOrderId)throw new AppError(409,"upstream_order_missing","没有可核对的上游订单号");
    const facts=await this.supplier.costFacts(f.upstreamOrderId,f.mode);
    return this.repo.transaction(()=>{const c=this.repo.getOperations("order_cost",id)??this.initial(o,actor.id);
      const candidate=facts.candidates.length===1?facts.candidates[0]!:null;
      const reused=candidate&&(queryRecords(this.repo,"order_cost",{filters:[{field:"orderId",op:"ne",value:id},{field:"sourceReference",value:candidate.reference}],limit:1,count:false}).data.length>0
        ||queryRecords(this.repo,"order_cost",{filters:[{field:"orderId",op:"ne",value:id},{field:"tradeCandidate.reference",value:candidate.reference}],limit:1,count:false}).data.length>0);
      this.repo.saveOperations("order_cost",{...c,upstreamOrderId:f.upstreamOrderId,nativeAmountMinor:facts.amountMinor,nativeCurrency:facts.currency,
        tradeCandidate:reused?null:candidate,tradeMatchIssue:reused?"trade_already_bound":facts.matchIssue,upstreamCheckedAt:new Date(),version:c.version+1,updatedAt:new Date()});
      this.log(actor,o,"cost.upstream.read");return this.view(actor,id);});
  }
  /** Only newly-created orders with frozen cost terms. Read-only upstream calls; never posts a payment or changes balances. */
  async syncOne() {
    if(!this.autoReadEnabled||Date.now()<this.nextScanAt)return;this.nextScanAt=Date.now()+30_000;
    const now=new Date(),cutoff=new Date(now.getTime()-48*60*60_000),indexed=this.repo.findCostReadCandidate?.(now,cutoff);
    let o=indexed;
    if(!this.repo.findCostReadCandidate){const costs=new Map(this.repo.listOperations("order_cost").map(c=>[c.orderId,c]));
      const records=this.repo.listWorkspaceRecords?.(this.repo.listMerchants().map(m=>m.id));
      const succeeded=records?new Set(records.fulfillments.filter(f=>f.status==="succeeded").map(f=>f.orderId)):null;
      o=this.repo.listOrdersInternal().find(order=>order.costTerms&&order.paymentStatus==="paid"&&now.getTime()-order.createdAt.getTime()<48*60*60_000
        &&!['confirmed','disputed'].includes(costs.get(order.id)?.status??'')&&(!costs.get(order.id)?.nextCheckAt||costs.get(order.id)!.nextCheckAt!.getTime()<=now.getTime())
        &&(succeeded?succeeded.has(order.id):this.repo.listFulfillments(order.merchantId,order.id).some(f=>f.status==="succeeded")));}
    if(!o)return;const actor:Actor={id:"cost-read-worker",role:"platform_admin",merchantId:null};
    try{await this.sync(actor,o.id);}finally{this.repo.transaction(()=>{const c=this.repo.getOperations("order_cost",o.id)??this.initial(o);
      this.repo.saveOperations("order_cost",{...c,nextCheckAt:new Date(Date.now()+15*60_000)});});}
  }
  confirmReceipt(actor:Actor,id:string,input:{version:number;evidence:string;confirmCustomerReceived:true}) {
    if(isPlatform(actor))this.admin(actor);else requirePermission(actor,"wallet.read");
    return this.repo.transaction(()=>{const o=this.order(id);
      if(!isPlatform(actor)&&actor.merchantId!==o.merchantId)throw new AppError(404,"order_not_found","订单不存在");
      const c=this.repo.getOperations("order_cost",id);if(!c||c.version!==input.version)throw new AppError(409,"cost_changed","记录已更新，请刷新");
      const n=calculateCost(c,o.supplyAmountMinor);
      if(c.status!=="confirmed"||c.destination!=="platform_pass_through"||n.due===null||n.due<=0n||c.paidUsdMinor<n.due)throw new AppError(409,"receipt_not_ready","仅全部支付给代理的代退补差可确认客户收款");
      if(!input.confirmCustomerReceived||input.evidence.trim().length<6)throw new AppError(422,"receipt_evidence_required","请填写客户已实际收到补差的凭证说明");
      if(c.customerReceipt!=="confirmed"){this.repo.saveOperations("order_cost",{...c,customerReceipt:"confirmed",customerReceiptEvidence:input.evidence.trim(),version:c.version+1,updatedAt:new Date()});
        this.audit.record({merchantId:o.merchantId,actorId:actor.id,actorType:isPlatform(actor)?"platform_user":"merchant_user",action:"cost.customer_receipt.confirm",targetType:"order",targetId:id,requestId:"receipt:"+Date.now()});}
      return this.view(actor,id);});
  }
  private log(actor:Actor,o:Order,action:string){this.audit.record({merchantId:o.merchantId,actorId:actor.id,actorType:"platform_user",action,targetType:"order",targetId:o.id,requestId:action+":"+Date.now()});}
}
