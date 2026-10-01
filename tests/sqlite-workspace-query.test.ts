import type {DatabaseSync} from "node:sqlite";
import {describe,expect,it,vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {listWorkspaceOrders} from "../src/operations/order-view.js";
import {procurementBalanceMinor} from "../src/operations/agents.js";
import {completedTierOrderMetrics,evaluateTierUpgradeEligibility} from "../src/operations/tier-upgrade.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import {fundAndApproveApi} from "./fixtures/funded-api.js";
import {queryRecords} from "../src/infra/record-query.js";
import type {Repository} from "../src/infra/repository.js";

describe("SQLite workspace batch reads",()=>{
  it("uses tenant update and active-ticket indexes for paginated workspace histories",()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      const db=(r.repository as unknown as {db:DatabaseSync}).db;
      const plan=(sql:string)=>db.prepare("EXPLAIN QUERY PLAN "+sql).all("ops_ticket","merchant-demo-a")
        .map(row=>String((row as {detail:unknown}).detail)).join("\n");
      const tickets=plan(`SELECT payload FROM sandbox_records WHERE kind=? AND merchant_id=?
        AND json_extract(payload,'$.archivedAt') IS NULL
        ORDER BY json_extract(payload,'$.updatedAt') DESC,id DESC LIMIT 20 OFFSET 0`);
      expect(tickets).toContain("records_tenant_archived_updated_idx");

      const updated=plan(`SELECT payload FROM sandbox_records WHERE kind=? AND merchant_id=?
        ORDER BY json_extract(payload,'$.updatedAt') DESC,id DESC LIMIT 20 OFFSET 0`);
      expect(updated).toContain("records_tenant_updated_idx");
    }finally{r.close();}
  });

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
      const names=new Map([[order.merchantId,"mock merchant"]]);
      expect(listWorkspaceOrders(r.repository,{id:"owner",role:"agent_owner",merchantId:order.merchantId},[order.merchantId],names,()=>[],
        {page:1,limit:20,search:voucher.upstreamCdkId!}).data).toEqual([]);
      expect(listWorkspaceOrders(r.repository,{id:"admin",role:"platform_admin",merchantId:null},[order.merchantId],names,()=>[],
        {page:1,limit:20,search:voucher.upstreamCdkId!}).data.map(item=>item.id)).toEqual([order.id]);
      const db=(r.repository as unknown as {db:DatabaseSync}).db,queries=vi.spyOn(db,"prepare");
      const tasks=vi.spyOn(r.repository,"listFulfillments"),vouchers=vi.spyOn(r.repository,"findCdkVoucherByOrder");
      const result=listWorkspaceOrders(r.repository,{id:"owner",role:"agent_owner",merchantId:order.merchantId},[order.merchantId],names,()=>[],{page:1,limit:20});
      expect(result.data.map(o=>o.id)).toEqual([order.id]);expect(result.data[0]?.fulfillmentStatus).toBe("queued");
      expect(result.data[0]?.saleAmount).toBe("135.00");expect(result.data[0]?.createdAt).toBeInstanceOf(Date);
      expect(queries).toHaveBeenCalledTimes(2);expect(tasks).not.toHaveBeenCalled();expect(vouchers).not.toHaveBeenCalled();
      expect(r.repository.listFulfillments(order.merchantId,order.id)[0]?.id).toBe(task.id);
      expect(r.repository.listFulfillments("other-tenant",order.id)).toEqual([]);
      expect(r.repository.findCdkVoucherByOrder(order.id)?.id).toBe(voucher.id);
    }finally{vi.restoreAllMocks();r.close();}
  });

  it("filters workspace orders by independent Shanghai created and paid date ranges",async()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      publishTestRechargeProduct(r);
      const binding=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!,tenant={merchantId:binding.merchant.id,
        appId:binding.app.id,keyId:binding.key.keyId,partnerId:binding.merchant.partnerId};
      const base=await r.orders.create(tenant,{merchantOrderNo:"DATE-BASE",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      r.repository.updateOrder({...base,createdAt:new Date("2026-09-28T00:00:00.000Z")});
      const first={...base,id:"date-order-first",merchantOrderNo:"DATE-FIRST",paymentStatus:"paid" as const,
        createdAt:new Date("2026-09-29T16:00:00.000Z"),paidAt:new Date("2026-09-30T03:00:00.000Z")};
      const second={...base,id:"date-order-second",merchantOrderNo:"DATE-SECOND",paymentStatus:"paid" as const,
        createdAt:new Date("2026-09-30T16:00:00.000Z"),paidAt:new Date("2026-10-01T03:00:00.000Z")};
      r.repository.insertOrder(first);r.repository.insertOrder(second);
      const names=new Map([[base.merchantId,"测试代理"]]),actor={id:"owner",role:"agent_owner" as const,merchantId:base.merchantId};
      const created=listWorkspaceOrders(r.repository,actor,[base.merchantId],names,()=>[],{page:1,limit:20,
        createdFrom:"2026-09-30T16:00:00.000Z",createdTo:"2026-10-01T16:00:00.000Z"});
      const paid=listWorkspaceOrders(r.repository,actor,[base.merchantId],names,()=>[],{page:1,limit:20,
        paidFrom:"2026-09-29T16:00:00.000Z",paidTo:"2026-09-30T16:00:00.000Z"});
      expect(created.data.map(item=>item.id)).toEqual(["date-order-second"]);
      expect(paid.data.map(item=>item.id)).toEqual(["date-order-first"]);
    }finally{r.close();}
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

  it("uses exact indexed lookups for upstream callbacks and operation references",async()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      publishTestRechargeProduct(r);
      const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!,tenant={merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId};
      const order=await r.orders.create(tenant,{merchantOrderNo:"EXACT-LOOKUP-001",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      r.payment.markPaid(order.merchantId,order.id,{providerRef:"exact-lookup-payment",receivedMinor:order.saleAmountMinor});
      const voucher=(await r.cdk.issueOne())!,task=r.fulfillments.createCdkPublic(r.repository.findOrderInternal(order.id)!,voucher,
        r.cdk.readUpstreamCode(voucher),{mode:"session",session:"exact-lookup-session"});
      const db=(r.repository as unknown as {db:DatabaseSync}).db,prepare=vi.spyOn(db,"prepare");
      expect(r.repository.findFulfillmentByUpstreamClientRequestId(task.upstreamClientRequestId)?.id).toBe(task.id);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(String(prepare.mock.calls[0]?.[0])).toContain("upstreamClientRequestId");

      const now=new Date();
      r.repository.saveOperations("wallet_deposit",{id:"lookup-deposit-a",merchantId:order.merchantId,amountMinor:100n,status:"credited",
        requestKey:"lookup-request-a",payerReference:"支付宝在线充值",verifiedReference:"lookup-provider-reference",reviewerId:"payment:alipay",
        paymentProvider:"alipay_page",paymentConfigId:null,providerRef:"lookup-provider-a",expiresAt:null,paidAt:now,nextCheckAt:null,createdAt:now,updatedAt:now},true);
      r.repository.saveOperations("wallet_deposit",{id:"lookup-deposit-b",merchantId:order.merchantId,amountMinor:100n,status:"credited",
        requestKey:"lookup-request-b",payerReference:"支付宝在线充值",verifiedReference:"lookup-provider-reference-b",reviewerId:"payment:alipay",
        paymentProvider:"alipay_page",paymentConfigId:null,providerRef:"lookup-provider-b",expiresAt:null,paidAt:now,nextCheckAt:null,createdAt:now,updatedAt:now},true);
      prepare.mockClear();
      const match=queryRecords(r.repository,"wallet_deposit",{filters:[{field:"verifiedReference",value:"lookup-provider-reference"},
        {field:"id",op:"ne",value:"lookup-deposit-b"},{field:"paidAt",op:"not_null"}],limit:1,count:false}).data;
      expect(match.map(item=>item.id)).toEqual(["lookup-deposit-a"]);
      expect(prepare).toHaveBeenCalledTimes(1);
    }finally{vi.restoreAllMocks();r.close();}
  });

  it("reconciles released earnings and pending-refund guards without historical scans",async()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      publishTestRechargeProduct(r);
      const b=r.repository.findCredential(cfg.demoPartnerId,cfg.demoKeyId)!,tenant={merchantId:b.merchant.id,appId:b.app.id,keyId:b.key.keyId,partnerId:b.merchant.partnerId};
      const created=await r.orders.create(tenant,{merchantOrderNo:"EARNING-RECONCILE-SQL",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      const attempt=r.repository.findPaymentAttemptByOrder(created.merchantId,created.id)!;
      r.repository.updatePaymentAttempt({...attempt,provider:"alipay_page"});
      const paid=r.payment.markPaid(created.merchantId,created.id,{channel:"alipay_page",providerRef:"earning-reconcile-payment",receivedMinor:created.saleAmountMinor});
      const now=new Date();
      r.repository.insertFulfillment({id:"ful_earning_reconcile",merchantId:paid.merchantId,orderId:paid.id,attemptNo:1,status:"succeeded",failureCode:null,
        message:null,accountEmailMasked:null,sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:null},mode:"cdk",voucherId:null,
        upstreamProvider:"zovocard",upstreamOrderId:"up_earning_reconcile",upstreamClientRequestId:"req_earning_reconcile",upstreamLookupToken:null,
        upstreamStatus:"completed",upstreamStage:"completed",upstreamQuoteMinor:1576,upstreamCurrency:"USD",nextCheckAt:now,createdAt:now,finishedAt:now});
      r.repository.saveOperations("wallet_credit",{id:paid.id,merchantId:paid.merchantId,orderId:paid.id,recognizedMinor:2_500n,createdAt:now},true);
      r.repository.saveOperations("wallet_entry",{id:"earning:"+paid.id,merchantId:paid.merchantId,kind:"earning_release",procurementDelta:0n,
        earningsDelta:2_500n,frozenDelta:0n,reference:paid.id,actorId:"system",createdAt:now},true);
      r.repository.updateOrder({...paid,paymentStatus:"partially_refunded",ordinaryRefundedMinor:1_000n,updatedAt:now});

      const fullOperations=vi.spyOn(r.repository,"listOperations"),orders=vi.spyOn(r.repository,"findOrder"),
        payments=vi.spyOn(r.repository,"findPaymentAttemptByOrder"),fulfillments=vi.spyOn(r.repository,"listFulfillments"),refundLists=vi.spyOn(r.repository,"listRefundsForOrder");
      r.wallets.reconcileMerchantEarnings(paid.merchantId);
      expect(r.repository.getOperations("wallet_credit",paid.id)?.recognizedMinor).toBe(1_500n);
      expect((r.repository as Repository).walletTotals?.(paid.merchantId).earnings).toBe(1_500n);
      r.repository.insertRefund({id:"refund_earning_pending",merchantId:paid.merchantId,orderId:paid.id,merchantRefundNo:"earning-pending",
        type:"partial",amountMinor:100n,status:"requested",reason:"pending refund",failureCode:null,createdAt:now,refundedAt:null});
      expect(()=>r.wallets.requestWithdrawal({id:"owner",role:"agent_owner",merchantId:paid.merchantId},paid.merchantId,"1.00","pending-guard",
        {method:"alipay",account:"test@example.com",name:"测试代理"})).toThrow("有退款待确认");
      expect(fullOperations).not.toHaveBeenCalled();expect(orders).not.toHaveBeenCalled();expect(payments).not.toHaveBeenCalled();
      expect(fulfillments).not.toHaveBeenCalled();expect(refundLists).not.toHaveBeenCalled();
    }finally{vi.restoreAllMocks();r.close();}
  });

  it("aggregates API access overview and deposit eligibility without per-agent scans",()=>{
    const cfg=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"}),r=createRuntime(cfg);
    try{
      const funded=fundAndApproveApi(r,cfg.demoPartnerId,"220.00"),merchant=r.repository.findMerchantByPartner(cfg.demoPartnerId)!;
      const rules=r.agents.rules(),merchants=vi.spyOn(r.repository,"listMerchants"),operations=vi.spyOn(r.repository,"listOperations"),
        apps=vi.spyOn(r.repository,"listApps"),webhooks=vi.spyOn(r.repository,"listWebhookEndpoints");
      const overview=r.apiAccess.adminOverview({id:"admin",role:"platform_admin",merchantId:null});
      expect(overview.agents.find(item=>item.merchantId===merchant.id)).toMatchObject({apiEnabled:true,procurementBalanceMinor:"22000"});
      expect(merchants).not.toHaveBeenCalled();expect(operations).not.toHaveBeenCalled();expect(apps).not.toHaveBeenCalled();expect(webhooks).not.toHaveBeenCalled();
      operations.mockClear();
      const summary=r.apiAccess.summary(funded.owner,merchant.id);
      expect(summary).toMatchObject({hasVerifiedDeposit:true,procurementBalanceMinor:"22000"});expect(operations).not.toHaveBeenCalled();
      const eligibility=evaluateTierUpgradeEligibility(r.repository,merchant.id,"preferred",rules);
      expect(eligibility.metrics.creditedDepositMinor).toBe(22_000n);expect(operations).not.toHaveBeenCalled();
    }finally{vi.restoreAllMocks();r.close();}
  });
});
