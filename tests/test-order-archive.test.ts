import {describe,expect,it} from "vitest";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {SqliteRepository} from "../src/infra/sqlite-repository.js";
import type {Repository} from "../src/infra/repository.js";
import type {Order,Fulfillment} from "../src/domain/model.js";
import {archiveConfirmedTestOrders,confirmedTestOrders} from "../src/operations/test-order-archive.js";
import {listWorkspaceOrders} from "../src/operations/order-view.js";
import {financeDrilldown} from "../src/operations/finance-drilldown.js";
import {SupportService} from "../src/operations/support.js";
import {AuditService} from "../src/modules/audit-service.js";
import {NotificationService} from "../src/modules/notifications.js";
import {FulfillmentService} from "../src/modules/fulfillment-service.js";
import type {Actor} from "../src/operations/model.js";
const admin:Actor={id:"admin",role:"platform_admin",merchantId:null};

function seed(repo:Repository) {
  const now=new Date("2026-09-30T12:00:00+08:00");
  repo.saveMerchant({id:"test-merchant",partnerId:"test-partner",name:"测试代理",status:"active"});
  for (const {ticketId,orderId} of confirmedTestOrders) {
    const o:Order={id:orderId,merchantId:"test-merchant",appId:"app",merchantOrderNo:orderId,productCode:"chatgpt_plus_cdk_1m",quantity:1,
      saleAmountMinor:13500n,supplyAmountMinor:11000n,ordinaryRefundedMinor:0n,priceAdjustmentRefundedMinor:0n,currency:"CNY",metadata:{},
      paymentStatus:"paid",paymentProviderRef:"isolated-test-payment",paymentReceivedMinor:13500n,paymentFeeMinor:0n,
      qrPayload:null,qrImageUrl:null,fulfillmentMode:"direct",upstreamProduct:"gpt",upstreamPlan:"plus",fulfillmentUrl:"https://test.invalid/recharge",
      voucherCode:null,settlementId:null,paidAt:now,expiresAt:now,createdAt:now,updatedAt:now};
    repo.insertOrder(o);
    const f:Fulfillment={id:"failed-"+orderId,merchantId:o.merchantId,orderId,attemptNo:1,status:"failed",failureCode:"session_invalid",message:null,
      accountEmailMasked:null,sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:now},mode:"direct",voucherId:null,
      upstreamProvider:"zovocard",upstreamOrderId:null,upstreamClientRequestId:orderId,upstreamLookupToken:null,upstreamStatus:"submission_pending",
      upstreamStage:null,upstreamQuoteMinor:null,upstreamCurrency:null,nextCheckAt:now,createdAt:now,finishedAt:now};
    repo.insertFulfillment(f);
    repo.saveOperations("ticket",{id:ticketId,merchantId:o.merchantId,orderId,category:"recharge",title:"测试异常",status:"in_progress",assigneeId:null,
      version:1,publicVersion:1,createdBy:"system",systemCase:{issueKey:"task:"+f.id,entityId:f.id},createdAt:now,updatedAt:now},true);
  }
  const base=repo.findOrderInternal(confirmedTestOrders[0].orderId)!;
  repo.insertOrder({...base,id:"unselected-order",merchantOrderNo:"unselected"});
  repo.saveOperations("wallet_entry",{id:"retain-wallet",merchantId:base.merchantId,kind:"deposit",procurementDelta:15000n,earningsDelta:5000n,
    frozenDelta:0n,reference:"isolated-evidence",actorId:"test",createdAt:now},true);
}

describe.each(["memory","sqlite"] as const)("confirmed test cleanup (%s)",driver=>{
  const open=()=>{const repo:Repository=driver==="sqlite"?new SqliteRepository(":memory:"):new MemoryRepository();seed(repo);return repo;};
  it("archives exactly the confirmed seven, retaining financial evidence and remaining orders",async()=>{
    const repo=open();try {
      const wallet=repo.listOperations("wallet_entry"),orders=confirmedTestOrders.map(x=>repo.findOrderInternal(x.orderId)!);
      expect(archiveConfirmedTestOrders(repo)).toMatchObject({ordersArchived:7,ticketsArchived:7,financialRecordsChanged:false});
      const support=new SupportService(repo,new AuditService(repo)),notifications=new NotificationService(repo);
      expect(support.list(admin)).toEqual([]);expect(notifications.tasksPage(admin).meta.total).toBe(0);
      expect(()=>support.get(admin,confirmedTestOrders[0].ticketId)).toThrow("已归档");
      await notifications.tick();
      expect(support.list(admin)).toEqual([]);expect(repo.listOperations("ticket")).toHaveLength(7);
      expect(listWorkspaceOrders(repo,admin,["test-merchant"],new Map(),()=>[],{page:1,limit:20}).data.map(o=>o.id)).toEqual(["unselected-order"]);
      expect(financeDrilldown(repo,admin,{day:"2026-09-30",metric:"receipts",page:1,limit:20}).meta.total).toBe(8);
      expect(repo.listOperations("wallet_entry")).toEqual(wallet);
      for (const o of orders) {
        const next=repo.findOrderInternal(o.id)!;
        expect(next.archivedAt).toBeInstanceOf(Date);
        for (const key of ["paymentStatus","saleAmountMinor","supplyAmountMinor","ordinaryRefundedMinor","priceAdjustmentRefundedMinor","paymentReceivedMinor","paidAt"] as const)
          expect(next[key]).toEqual(o[key]);
        expect(repo.listFulfillments(o.merchantId,o.id)[0]?.status).toBe("failed");
      }
      expect(archiveConfirmedTestOrders(repo)).toMatchObject({ordersArchived:0,ticketsArchived:0});
      expect(repo.listAudit("test-merchant")).toHaveLength(14);
    }finally{repo.close?.();}
  });
  it("aborts the entire selection when any order is still processing or has succeeded",()=>{
    const repo=open();try {
      const o=repo.findOrderInternal(confirmedTestOrders[6].orderId)!,task=repo.listFulfillments(o.merchantId,o.id)[0]!;
      repo.updateFulfillment({...task,status:"running"});
      expect(()=>archiveConfirmedTestOrders(repo)).toThrow("nonterminal_or_successful");
      expect(confirmedTestOrders.every(x=>!repo.findOrderInternal(x.orderId)?.archivedAt)).toBe(true);
      expect(repo.listAudit("test-merchant")).toHaveLength(0);
    }finally{repo.close?.();}
  });
  it("rejects mismatched or unconfirmed ticket associations",()=>{
    const repo=open();try {
      const t=repo.getOperations("ticket",confirmedTestOrders[6].ticketId)!;
      repo.saveOperations("ticket",{...t,orderId:"unselected-order"});
      expect(()=>archiveConfirmedTestOrders(repo)).toThrow("scope_mismatch");
      expect(confirmedTestOrders.every(x=>!repo.findOrderInternal(x.orderId)?.archivedAt)).toBe(true);
    }finally{repo.close?.();}
  });
  it("blocks a fresh recharge on an archived order before touching upstream services",async()=>{
    const repo=open();try {
      archiveConfirmedTestOrders(repo);
      // The guards run before cipher/webhook/provider access, so no external client is needed.
      const service=Object.create(FulfillmentService.prototype) as FulfillmentService;
      Object.defineProperty(service,"repository",{value:repo});
      const order=repo.findOrderInternal(confirmedTestOrders[0].orderId)!;
      expect(()=>service.createDirectPublic(order,{mode:"session",session:"isolated-test"})).toThrow("已归档");
      await expect(service.preflightPublic(order,{mode:"session",session:"isolated-test"})).rejects.toThrow("已归档");
    }finally{repo.close?.();}
  });
});
