import {describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor, OrderCost} from "../src/operations/model.js";
import {applySubscriptionPricing} from "../src/operations/subscription-pricing.js";
import {managedGptProducts} from "../src/modules/gpt-products.js";
import {financeDrilldown} from "../src/operations/finance-drilldown.js";
import {calculateCost} from "../src/operations/cost-accounting.js";
import {NotificationService} from "../src/modules/notifications.js";
import {financeWorkspaceJs} from "../src/operations/finance-ui.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
const admin:Actor={id:"test-admin",role:"platform_admin",merchantId:null};
const config=(driver:"sqlite"|"memory")=>loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});

describe.each(["memory","sqlite"] as const)("subscription release (%s)", driver=>{
  it("sets four procurement prices and separate refund benchmarks, preserving publication and history",()=>{
    const r=createRuntime(config(driver));try{
      publishTestRechargeProduct(r);
      const result=applySubscriptionPricing(r.repository);expect(result.applied).toBe(true);
      const catalog=r.repository.getOperations("global_product_catalog","default")!;
      expect(managedGptProducts).toHaveLength(4);
      expect(catalog.products.filter(p=>managedGptProducts.some(t=>t.productCode===p.productCode)).map(p=>[p.supplyPriceMinor,p.standardCostCnyMinor,p.refundBenchmarkUsdMinor]))
        .toEqual([[11000n,10800n,1576n],[63800n,63000n,9298n],[100000n,96100n,14312n],[320000n,312000n,46544n]]);
      expect(catalog.products.find(p=>p.productCode===managedGptProducts[0]!.productCode)!.available).toBe(true);
      expect(catalog.products.filter(p=>managedGptProducts.some(t=>t.productCode===p.productCode)).every(p=>p.available)).toBe(true);
      expect(applySubscriptionPricing(r.repository).applied).toBe(false);
    }finally{r.close();}
  });
  it("does not overwrite the frozen refund benchmark with a supplier USD quote",async()=>{
    const cfg=config(driver),r=createRuntime(cfg);try{
      publishTestRechargeProduct(r);applySubscriptionPricing(r.repository);
      const mapping=r.repository.findSupplierProductMapping("chatgpt_plus_cdk_1m")!;
      r.repository.replaceSupplierPlanSnapshots(mapping.connectionId,"gpt",[{connectionId:mapping.connectionId,product:"gpt",plan:"plus",accPlanKey:"plus",name:"Plus",
        enabled:true,purchasable:true,serviceFeeUsdMinor:15,checkoutAmountMinor:3000,checkoutCurrency:"USD",quoteUsdMinor:3000,pricingVersion:88,syncedAt:new Date()}]);
      const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!;
      const o=await r.orders.create({merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId},
        {merchantOrderNo:"quote-is-not-benchmark",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      expect(o.costTerms?.refundBenchmarkUsdMinor).toBe(1576n);expect(o.costTerms?.standardUsdMinor).toBe(1576n);expect(o.costTerms?.quoteAmountMinor).toBe(3000);
      expect(o.costTerms?.standardSource).toBe("operator_verified_baseline");
      expect(r.costs.view(admin,o.id)).toMatchObject({actualUsd:null,actualCostCny:null,refundDueUsd:null});
    }finally{r.close();}
  });
  it("drills down the same paid-day finance basis with pagination and suspended agents",async()=>{
    const cfg=config(driver),r=createRuntime(cfg);try{
      publishTestRechargeProduct(r);const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!;
      const o=await r.orders.create({merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId},
        {merchantOrderNo:"finance-page",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      const day="2026-09-30",paidAt=new Date(day+"T12:00:00+08:00");
      r.repository.updateOrder({...o,paymentStatus:"partially_refunded",paidAt,createdAt:new Date(paidAt.getTime()-1),ordinaryRefundedMinor:500n,priceAdjustmentRefundedMinor:1000n});
      r.repository.transaction(()=>{for(let i=0;i<105;i++)r.repository.insertOrder({...o,id:"finance-sample-"+String(i).padStart(3,"0"),merchantOrderNo:"finance-sample-"+i,
        paymentStatus:"paid",paidAt,createdAt:new Date(paidAt.getTime()+i),priceAdjustmentRefundedMinor:1000n});});
      r.repository.saveMerchant({...b.merchant,status:"suspended"});
      const page=financeDrilldown(r.repository,admin,{day,metric:"margin",page:2,limit:20});expect(page.meta).toMatchObject({total:106,page:2,pages:6});expect(page.data).toHaveLength(20);
      const net=financeDrilldown(r.repository,admin,{day,metric:"net_receipts",page:6,limit:20});expect(net.data).toHaveLength(6);
      expect(net.data.find(p=>p.orderId===o.id)).toMatchObject({netReceipts:"120.00",margin:"20.00",recognizedEarning:"0.00"});
      expect(()=>financeDrilldown(r.repository,{...admin,role:"agent_owner",merchantId:b.merchant.id},{day,metric:"margin",page:1,limit:20})).toThrow("仅平台");
      expect(()=>financeDrilldown(r.repository,admin,{day:"2026-02-30",metric:"margin",page:1,limit:20})).toThrow("日期无效");
    }finally{r.close();}
  });
});

it("never treats a refund benchmark as actual CNY cost, even when the USD values happen to match",()=>{
  const now=new Date(),c:OrderCost={id:"cost",merchantId:"test",orderId:"cost",upstreamOrderId:null,standardUsdMinor:1576n,standardCnyMinor:11000n,
    actualUsdMinor:1576n,additionalFeesUsdMinor:0n,retainedUsdMinor:15n,fxRate:null,sourceReference:"settled-evidence",evidence:"mock-isolated-clearing",source:"manual_verified",status:"confirmed",
    destination:"customer_direct",paidUsdMinor:0n,customerReceipt:"pending",nativeAmountMinor:null,nativeCurrency:null,upstreamCheckedAt:null,nextCheckAt:null,
    version:1,createdBy:"test",reviewedBy:"test",createdAt:now,updatedAt:now};
  expect(calculateCost(c,11000n)).toMatchObject({actualCny:null,grossProfit:null,due:0n});
  expect(calculateCost({...c,actualUsdMinor:1400n,fxRate:"7"},11000n)).toMatchObject({actualCny:9800n,due:161n,grossProfit:73n});
});
it("removes SMTP configuration and verification without sending or decrypting credentials",async()=>{
  const r=createRuntime(config("sqlite"));try{
    const sender=vi.fn(),service=new NotificationService(r.repository,null,"","",sender);
    expect(()=>service.settings(admin)).toThrow("邮件功能已移除");expect(()=>service.saveSettings(admin,{})).toThrow("邮件功能已移除");
    await expect(service.verify(admin)).rejects.toThrow("邮件功能已移除");await service.tick();expect(sender).not.toHaveBeenCalled();
  }finally{r.close();}
});
it("provides finance metric dialog pagination and order detail navigation",()=>{
  expect(financeWorkspaceJs).toContain("async function openFinanceMetric");expect(financeWorkspaceJs).toContain("/finance/details?day=");
  expect(financeWorkspaceJs).toContain("paginationBar(result.meta,read)");expect(financeWorkspaceJs).toContain("openOrderDetailModal({id:o.orderId})");
});
