import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {merchantMargin} from "../src/domain/money.js";
import {calculateCost,convertUsd} from "../src/operations/cost-accounting.js";
import type {Actor} from "../src/operations/model.js";
import {matchOrderTrades} from "../src/upstream/cost-facts.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
const admin:Actor={id:"admin",role:"platform_admin",merchantId:null};
describe("separate cost and saving liabilities",()=>{
  let r:Runtime,orderId:string,owner:Actor;
  beforeEach(async()=>{const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent"});r=createRuntime(cfg);
    publishTestRechargeProduct(r);const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!;owner={id:"owner",merchantId:b.merchant.id,role:"agent_owner"};
    const o=await r.orders.create({merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId},{merchantOrderNo:"COST-001",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});orderId=o.id;
    r.payment.markPaid(o.merchantId,o.id,{providerRef:"mock-cost",receivedMinor:o.saleAmountMinor});
    r.repository.updateOrder({...r.repository.findOrderInternal(o.id)!,fulfillmentMode:"direct",costTerms:{standardUsdMinor:2000n,standardCnyMinor:14000n,retainedUsdMinor:15n,productVersion:1}});
    const f=r.fulfillments.createDirectPublic(r.repository.findOrderInternal(o.id)!,{mode:"session",session:"mock-test-only"});
    await r.fulfillments.processOne();r.repository.updateFulfillment({...r.repository.findFulfillment(o.merchantId,f.id)!,status:"succeeded",upstreamProvider:"configured_supplier",upstreamOrderId:"313313"});
  });
  afterEach(()=>r.close());
  const verify=(version=0)=>({version,actualUsd:"15.76",feesUsd:"0.00",retainedUsd:"0.15",fxRate:"7",sourceReference:"unique-trade-001",evidence:"已人工核实清算及本单关联",confirmEvidence:true as const,destination:"platform_pass_through" as const});
  it("freezes the canonical product cost even when an older product alias is used",async()=>{
    const catalog=r.repository.getOperations("global_product_catalog","default")!;
    r.repository.saveOperations("global_product_catalog",{...catalog,products:catalog.products.map(p=>p.productCode==="chatgpt_plus_cdk_1m"?{...p,refundBenchmarkUsdMinor:2000n,standardCostCnyMinor:14000n,retainedFeeUsdMinor:15n}:p)});
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent"}),b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!;
    const order=await r.orders.create({merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId},{merchantOrderNo:"COST-ALIAS-002",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
    expect(order.costTerms).toMatchObject({standardUsdMinor:2000n,standardCnyMinor:14000n,retainedUsdMinor:15n});
    r.repository.saveOperations("global_product_catalog",{...catalog,products:catalog.products.map(p=>p.productCode==="chatgpt_plus_cdk_1m"?{...p,refundBenchmarkUsdMinor:2100n}:p)});
    expect(r.repository.findOrderInternal(order.id)?.costTerms?.standardUsdMinor).toBe(2000n);
  });
  it("calculates USD savings without deducting the retained fee twice or reversing commission",()=>{
    const c=r.costs.verify(admin,orderId,verify());expect(c).toMatchObject({refundDueUsd:"4.09",grossSavingUsd:"4.24",retainedAppliedUsd:"0.15",grossProfitCny:"-28.95",actualCostCny:"110.32"});
    expect(merchantMargin(r.repository.findOrderInternal(orderId)!)).toBe(2500n);
    expect(r.repository.listOperations("wallet_entry")).toHaveLength(0);
  });
  it("does not invent CNY profit or require payment when USD cost is unknown",()=>{
    expect(r.costs.view(admin,orderId)).toMatchObject({actualUsd:null,grossProfitCny:null,refundDueUsd:null});
    const input=verify();delete (input as {fxRate?:string}).fxRate;
    expect(r.costs.verify(admin,orderId,input)).toMatchObject({refundDueUsd:"4.09",grossProfitCny:null});
  });
  it("hides internal costs and upstream trade identities from an agent and protects tenant scope",()=>{
    r.costs.verify(admin,orderId,verify());const view=r.costs.view(owner,orderId);expect(view).not.toHaveProperty("actualUsd");expect(view).not.toHaveProperty("sourceReference");
    expect(()=>r.costs.view({...owner,merchantId:"other"},orderId)).toThrow("订单不存在");expect(()=>r.costs.verify(owner,orderId,verify())).toThrow();
  });
  it("does not confuse actual cost above the refund benchmark with unverified cost",()=>{
    expect(()=>r.costs.verify(admin,orderId,{...verify(),standardUsd:"21.00"})).toThrow("冻结");
    expect(()=>r.costs.verify(admin,orderId,{...verify(),actualUsd:"0.00"})).toThrow("零成本");
    expect(()=>r.costs.verify(admin,orderId,{...verify(),retainedUsd:"0.20"})).toThrow("冻结");
    expect(r.costs.verify(admin,orderId,{...verify(),actualUsd:"21.00"})).toMatchObject({status:"confirmed",refundDueUsd:"0.00",anomaly:true});
  });
  it("records actual payments once and cannot switch recipients, overpay or pretend customer receipt",()=>{
    r.costs.verify(admin,orderId,verify());const p={version:1,usd:"4.09",currency:"USD" as const,amount:"4.09",method:"manual-transfer",reference:"payout-unique-001",evidence:"已支付至代理账户凭证",requestKey:"payment-key-001",confirmActualPayout:true as const};
    expect(r.costs.recordPayment(admin,orderId,p)).toMatchObject({payoutState:"paid",customerReceipt:"pending"});
    r.costs.recordPayment(admin,orderId,p);expect(r.repository.listOperations("cost_saving_payment")).toHaveLength(1);
    expect(()=>r.costs.recordPayment(admin,orderId,{...p,evidence:"改变付款凭证内容"})).toThrow("不同内容");
    expect(()=>r.costs.recordPayment(admin,orderId,{...p,version:2,requestKey:"payment-key-002"})).toThrow();
    expect(()=>r.costs.verify(admin,orderId,{...verify(2),destination:"customer_direct"})).toThrow("已有补差");
    expect(r.costs.confirmReceipt(owner,orderId,{version:2,evidence:"代理已向客户真实付款",confirmCustomerReceived:true})).toMatchObject({customerReceipt:"confirmed"});
    expect(merchantMargin(r.repository.findOrderInternal(orderId)!)).toBe(2500n);
  });
  it("cannot run both the legacy difference refund and cost payment path",()=>{
    r.costs.verify(admin,orderId,verify());expect(()=>r.refunds.requestPriceAdjustment(admin,orderId,{amount:"1.00",reason:"旧路径",requestKey:"old-path-001"})).toThrow("补差");
  });
  it("reads a matched USD candidate without turning a completed authorization projection into confirmed clearing",async()=>{
    vi.spyOn(r.supplierManagement,"costFacts").mockResolvedValue({amountMinor:98214,currency:"PHP",candidates:[{reference:"auth-unique-001",usdMinor:1576,state:"completed_projection",matchedBy:"card_amount_window"}],matchIssue:null});
    const view=await r.costs.sync(admin,orderId);expect(view).toMatchObject({nativeCurrency:"PHP",tradeCandidate:{usd:"15.76"},status:"pending_review",actualUsd:null});
    expect(r.repository.listOperations("cost_saving_payment")).toHaveLength(0);
  });
  it("uses integer FX rounding, including negative values",()=>{expect(convertUsd(409n,"7")).toBe(2863n);expect(convertUsd(-1n,"7.125")).toBe(-7n);expect(()=>convertUsd(1n,"0")).toThrow();const c=r.repository.getOperations("order_cost",orderId);expect(c).toBeNull();});
});
describe("upstream order to USD transaction matching",()=>{
  const order={order_id:313313,card_id:417115,status:"completed",final_amount_minor:98214,currency:"PHP",created_at:"2026-09-30T07:59:21.557Z",completed_at:"2026-09-30T07:59:48.885Z"};
  const trade={auth_id:"trans-001",auth_time:"2026-09-30 15:59:48",auth_currency:"PHP",auth_amount:982.14,settle_currency:"USD",settle_amount:15.76,status:"COMPLETE",type:"Settlement",merchant_name:"OPENAI* CHATGPT SUBSCR"};
  it("matches the used card's unique native amount and order interval, deduplicating an auth/settlement pair",()=>{expect(matchOrderTrades(order,[{...trade,type:"Authorization"},trade,{...trade,auth_id:"older",auth_time:"2026-09-30 15:58:07"}])).toEqual([{reference:"trans-001",usdMinor:1576,state:"settled",matchedBy:"card_amount_window"}]);});
  it("rejects pending, reversals, unrelated amounts, wrong currencies and conflicted duplicate records",()=>{for(const change of [{status:"PENDING"},{type:"Reversal"},{auth_amount:1},{auth_currency:"USD"},{settle_currency:"PHP"},{order_id:1},{auth_time:"2026-09-30 16:00:00"}])expect(matchOrderTrades(order,[{...trade,...change}])).toHaveLength(0);expect(matchOrderTrades(order,[trade,{...trade,settle_amount:16}])).toHaveLength(0);});
  it("does not resolve multiple matching auth IDs by choosing whichever is nearest",()=>{expect(matchOrderTrades(order,[trade,{...trade,auth_id:"trans-002"}])).toHaveLength(2);});
});
