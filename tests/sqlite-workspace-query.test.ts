import type {DatabaseSync} from "node:sqlite";
import {describe,expect,it,vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {listWorkspaceOrders} from "../src/operations/order-view.js";
import {procurementBalanceMinor} from "../src/operations/agents.js";
import {completedTierOrderMetrics} from "../src/operations/tier-upgrade.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";

describe("SQLite workspace batch reads",()=>{
  it("uses bounded scoped count and page queries without per-order scans",async()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      publishTestRechargeProduct(r);
      const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!,tenant={merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId};
      const order=await r.orders.create(tenant,{merchantOrderNo:"BATCH-001",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      r.payment.markPaid(order.merchantId,order.id,{providerRef:"batch-mock",receivedMinor:order.saleAmountMinor});
      const voucher=(await r.cdk.issueOne())!;
      const task=r.fulfillments.createCdkPublic(r.repository.findOrderInternal(order.id)!,voucher,r.cdk.readUpstreamCode(voucher),{mode:"session",session:"isolated-mock-only"});
      r.repository.insertOrder({...order,id:"other-order",merchantId:"other-tenant",merchantOrderNo:"BATCH-OTHER"});
      const db=(r.repository as unknown as {db:DatabaseSync}).db,queries=vi.spyOn(db,"prepare");
      const tasks=vi.spyOn(r.repository,"listFulfillments"),vouchers=vi.spyOn(r.repository,"findCdkVoucherByOrder");
      const result=listWorkspaceOrders(r.repository,{id:"owner",role:"agent_owner",merchantId:order.merchantId},[order.merchantId],new Map([[order.merchantId,"mock merchant"]]),()=>[],{page:1,limit:20});
      expect(result.data.map(o=>o.id)).toEqual([order.id]);expect(result.data[0]?.fulfillmentStatus).toBe("queued");
      expect(result.data[0]?.saleAmount).toBe("135.00");expect(result.data[0]?.createdAt).toBeInstanceOf(Date);
      expect(queries).toHaveBeenCalledTimes(2);expect(tasks).not.toHaveBeenCalled();expect(vouchers).not.toHaveBeenCalled();
      expect(r.repository.listFulfillments(order.merchantId,order.id)[0]?.id).toBe(task.id);
      expect(r.repository.listFulfillments("other-tenant",order.id)).toEqual([]);
      expect(r.repository.findCdkVoucherByOrder(order.id)?.id).toBe(voucher.id);
    }finally{vi.restoreAllMocks();r.close();}
  });

  it("keeps wallet overview and notification queues at a fixed query count",()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      const existing=r.repository.listMerchants(),first=existing[0]!;
      r.repository.saveMerchant({...first,id:"merchant-query-two",partnerId:"PTQUERY0002",name:"第二代理商"});
      r.repository.saveOperations("wallet_entry",{id:"wallet-query-one",merchantId:first.id,kind:"adjustment",procurementDelta:10000n,
        earningsDelta:250n,frozenDelta:0n,reference:"query-check",actorId:"platform",createdAt:new Date()},true);
      const db=(r.repository as unknown as {db:DatabaseSync}).db,prepare=vi.spyOn(db,"prepare");
      const admin={id:"query-admin",role:"platform_admin" as const,merchantId:null};
      const wallets=r.wallets.adminOverview(admin);
      expect(wallets).toHaveLength(existing.length+1);expect(wallets.find(item=>item.merchantId===first.id)?.procurementAvailable).toBe("100.00");
      expect(prepare).toHaveBeenCalledTimes(3);
      prepare.mockClear();
      const fulfillments=vi.spyOn(r.repository,"listFulfillments"),tasks=r.notifications.tasksPage(admin,1,30);
      expect(tasks.meta.total).toBe(0);expect(prepare).toHaveBeenCalledTimes(2);expect(fulfillments).not.toHaveBeenCalled();
      prepare.mockClear();r.costs.list(admin);expect(prepare).toHaveBeenCalledTimes(3);expect(fulfillments).not.toHaveBeenCalled();
    }finally{vi.restoreAllMocks();r.close();}
  });

  it("filters commission entries before pagination",()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      const merchant=r.repository.listMerchants()[0]!,createdAt=new Date("2026-10-01T02:00:00.000Z");
      r.repository.saveOperations("wallet_entry",{id:"commission-release",merchantId:merchant.id,kind:"earning_release",procurementDelta:0n,
        earningsDelta:500n,frozenDelta:0n,reference:"order-commission",actorId:"system",createdAt},true);
      r.repository.saveOperations("wallet_entry",{id:"commission-deposit",merchantId:merchant.id,kind:"deposit",procurementDelta:10_000n,
        earningsDelta:0n,frozenDelta:0n,reference:"deposit-not-commission",actorId:"system",createdAt:new Date(createdAt.getTime()+1_000)},true);
      const result=r.wallets.adminEntries({id:"query-admin",role:"platform_admin",merchantId:null},{merchantId:merchant.id,scope:"commission",page:1,limit:1});
      expect(result.meta.total).toBe(1);expect(result.data.map(item=>item.id)).toEqual(["commission-release"]);
    }finally{r.close();}
  });

  it("loads agent tier totals and procurement balance with bounded aggregate queries",async()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      publishTestRechargeProduct(r);
      const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!,tenant={merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId};
      const funded=fundAndApproveApi(r,cfg.demoPartnerId,"220.00"),profile=r.agents.profile(b.merchant.id);
      r.agents.saveProfile(funded.admin,b.merchant.id,{...profile,collectionModes:["platform_collect","agent_collect"]});
      const paid=await r.orders.create(tenant,{merchantOrderNo:"AGENT-METRICS-001",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00",collectionMode:"agent_collect"});
      const voucher=(await r.cdk.issueOne())!;
      const task=r.fulfillments.createCdkPublic(paid,voucher,r.cdk.readUpstreamCode(voucher),{mode:"session",session:"aggregate-test"});
      r.fulfillments.applyUpstreamEvent(task.id,{orderId:"supplier-metrics",lookupToken:null,status:"completed",stage:"completed",
        accountEmail:null,quotedAmountMinor:null,currency:"USD",message:"completed"});
      const finished=r.repository.findFulfillment(paid.merchantId,task.id)!;
      r.repository.updateFulfillment({...finished,upstreamProvider:"zovocard"});

      const db=(r.repository as unknown as {db:DatabaseSync}).db,prepare=vi.spyOn(db,"prepare");
      expect(completedTierOrderMetrics(r.repository,paid.merchantId)).toEqual({completedOrders:1,completedSupplyMinor:paid.supplyAmountMinor,
        agentCollectSupplyMinor:paid.supplyAmountMinor});
      expect(prepare).toHaveBeenCalledTimes(1);
      prepare.mockClear();
      expect(procurementBalanceMinor(r.repository,paid.merchantId)).toBe(22_000n-paid.supplyAmountMinor);
      expect(prepare).toHaveBeenCalledTimes(1);
    }finally{vi.restoreAllMocks();r.close();}
  });
});
