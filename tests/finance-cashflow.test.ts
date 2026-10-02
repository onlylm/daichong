import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order,Refund} from "../src/domain/model.js";
import type {Actor} from "../src/operations/model.js";
import {financeDrilldown} from "../src/operations/finance-drilldown.js";
import {moneyToMinor} from "../src/domain/money.js";

const admin:Actor={id:"finance-test",merchantId:null,role:"platform_admin"};
const today="2026-10-02",now=new Date(today+"T12:00:00+08:00");

describe.each(["memory","sqlite"] as const)("finance occurrence-day cashflow (%s)",driver=>{
  let runtime:Runtime,base:Order;
  beforeEach(async()=>{
    vi.useFakeTimers();vi.setSystemTime(now);
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    runtime=createRuntime(config);
    const c=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    base=await runtime.orders.create({merchantId:c.merchant.id,appId:c.app.id,keyId:c.key.keyId,partnerId:c.merchant.partnerId},
      {merchantOrderNo:"cashflow-base",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
  });
  afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();runtime.close();});

  function paid(id:string,paidAt:string,extra:Partial<Order>={}):Order{
    const value:Order={...base,id,merchantOrderNo:id,paymentStatus:"paid",paidAt:new Date(paidAt),...extra};
    runtime.repository.insertOrder(value);return value;
  }
  function refund(order:Order,id:string,amountMinor:bigint,type:Refund["type"],at:string|null,status:Refund["status"]="succeeded"){
    const value:Refund={id,merchantId:order.merchantId,orderId:order.id,merchantRefundNo:id,type,amountMinor,status,
      reason:"isolated finance test",failureCode:null,providerRefundNo:"provider-"+id,createdAt:now,refundedAt:at?new Date(at):null};
    runtime.repository.insertRefund(value);return value;
  }
  const q=(metric:"refunds"|"net_receipts",page=1,limit=20)=>({day:today,metric,page,limit});
  const sum=(values:string[])=>values.reduce((total,value)=>total+(value.startsWith("-")?-moneyToMinor(value.slice(1)):moneyToMinor(value)),0n);

  it("attributes cross-day and multiple refund types to refund completion while retaining paid-cohort figures",()=>{
    const previous=paid("previous-day","2026-10-01T10:00:00+08:00",{paymentStatus:"partially_refunded",ordinaryRefundedMinor:1000n,priceAdjustmentRefundedMinor:500n});
    refund(previous,"ordinary-today",1000n,"partial",today+"T09:00:00+08:00");
    refund(previous,"adjustment-today",500n,"price_adjustment",today+"T10:00:00+08:00");
    paid("current-day",today+"T08:00:00+08:00");
    const summary=runtime.wallets.platformFinanceSummary(admin);
    expect(summary.today).toMatchObject({saleAmount:"135.00",refundedAmount:"15.00",netSaleAmount:"120.00",refundTransactions:2,
      ordinaryRefundedAmount:"10.00",priceAdjustmentRefundedAmount:"5.00",paidCohortRefundedAmount:"0.00",paidCohortNetSaleAmount:"135.00"});
    expect(summary.daily.find(d=>d.day==="2026-10-01")).toMatchObject({saleAmount:"135.00",refundedAmount:"0.00",netSaleAmount:"135.00",
      paidCohortRefundedAmount:"15.00",paidCohortNetSaleAmount:"120.00"});
    const refunds=financeDrilldown(runtime.repository,admin,q("refunds")),net=financeDrilldown(runtime.repository,admin,q("net_receipts"));
    expect(refunds.meta.total).toBe(2);expect(net.meta.total).toBe(3);
    expect(sum(refunds.data.map(row=>row.ordinaryRefunded))+sum(refunds.data.map(row=>row.priceAdjustmentRefunded))).toBe(1500n);
    expect(sum(net.data.map(row=>row.netReceipts))).toBe(12000n);
    expect(refunds.data).toEqual(expect.arrayContaining([expect.objectContaining({refundId:"ordinary-today",refundType:"partial",entryType:"refund"}),
      expect.objectContaining({refundId:"adjustment-today",refundType:"price_adjustment",entryType:"refund"})]));
  });

  it("keeps negative refund-only days, excludes unsuccessful/undated refunds, and honors Shanghai day boundaries",()=>{
    const old=paid("outside-window","2026-09-01T12:00:00+08:00",{paymentStatus:"refunded",ordinaryRefundedMinor:13500n});
    refund(old,"midnight-start",100n,"partial","2026-10-01T16:00:00.000Z");
    refund(old,"day-last-ms",13400n,"full","2026-10-02T15:59:59.999Z");
    refund(old,"next-midnight",1n,"price_adjustment","2026-10-02T16:00:00.000Z");
    refund(old,"previous-ms",1n,"partial","2026-10-01T15:59:59.999Z");
    refund(old,"failed",9000n,"partial",today+"T10:00:00+08:00","failed");
    refund(old,"processing",9000n,"partial",today+"T10:00:00+08:00","processing");
    refund(old,"undated",9000n,"partial",null);
    const live=paid("isolated-live-test","2026-09-01T12:00:00+08:00",{liveTest:true});
    refund(live,"live-refund",13500n,"full",today+"T10:00:00+08:00");
    const procurement=paid("balance-purchase","2026-09-01T12:00:00+08:00",{collectionMode:"agent_collect"});
    refund(procurement,"balance-refund",11000n,"full",today+"T10:00:00+08:00");
    const summary=runtime.wallets.platformFinanceSummary(admin);
    expect(summary.today).toMatchObject({saleAmount:"0.00",refundedAmount:"135.00",netSaleAmount:"-135.00",refundTransactions:2});
    const detail=financeDrilldown(runtime.repository,admin,q("net_receipts"));
    expect(detail.meta.total).toBe(2);expect(sum(detail.data.map(row=>row.netReceipts))).toBe(-13500n);
  });

  it("pages more than fifty refund transactions without full-list database fallback or duplicate rows",()=>{
    const old=paid("many-refunds","2026-09-01T12:00:00+08:00",{paymentStatus:"partially_refunded",ordinaryRefundedMinor:12000n});
    runtime.repository.transaction(()=>{for(let i=0;i<120;i++)refund(old,"paged-"+String(i).padStart(3,"0"),100n,"partial",today+"T09:00:00+08:00");});
    const fullList=vi.spyOn(runtime.repository,"listOrdersInternal"),refundLists=vi.spyOn(runtime.repository,"listRefundsForOrder");
    const summary=runtime.wallets.platformFinanceSummary(admin);
    expect(summary.today).toMatchObject({refundedAmount:"120.00",netSaleAmount:"-120.00",refundTransactions:120});
    const rows=[];
    for(let page=1;page<=6;page++){
      const detail=financeDrilldown(runtime.repository,admin,q("refunds",page,20));
      expect(detail.meta).toMatchObject({total:120,page,pages:6});expect(detail.data).toHaveLength(20);rows.push(...detail.data);
    }
    expect(new Set(rows.map(row=>"entryId" in row?row.entryId:row.orderId)).size).toBe(120);
    expect(sum(rows.map(row=>row.ordinaryRefunded))).toBe(12000n);
    if(driver==="sqlite"){expect(fullList).not.toHaveBeenCalled();expect(refundLists).not.toHaveBeenCalled();}
  });

  it("requires platform finance permission and keeps cashflow joins tenant-scoped",()=>{
    const old=paid("scope-order","2026-09-01T12:00:00+08:00");
    refund(old,"own-refund",100n,"partial",today+"T09:00:00+08:00");
    const foreign=runtime.repository.findMerchantByPartner("pt_demo_b")!;
    refund({...old,merchantId:foreign.id},"foreign-order-reference",9900n,"partial",today+"T09:00:00+08:00");
    const agent:Actor={id:"agent",role:"agent_owner",merchantId:old.merchantId};
    expect(()=>runtime.wallets.platformFinanceSummary(agent)).toThrow("仅平台");
    expect(()=>financeDrilldown(runtime.repository,agent,q("refunds"))).toThrow("仅平台");
    expect(()=>financeDrilldown(runtime.repository,{id:"support",role:"platform_support",merchantId:null},q("refunds"))).toThrow("无权");
    expect(runtime.wallets.platformFinanceSummary(admin).today.refundedAmount).toBe("1.00");
    expect(financeDrilldown(runtime.repository,admin,q("refunds")).meta.total).toBe(1);
    if("queryFinanceCashflow" in runtime.repository){
      expect(runtime.repository.queryFinanceCashflow([foreign.id],{from:"2026-10-01T16:00:00.000Z",to:"2026-10-02T16:00:00.000Z",refundsOnly:true,page:1,limit:20}).meta.total).toBe(0);
    }
  });
});
