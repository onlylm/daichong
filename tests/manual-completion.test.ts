import {randomUUID} from "node:crypto";
import {afterEach, describe, expect, it} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor} from "../src/operations/model.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {workspaceOrderDetail} from "../src/operations/order-view.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const admin:Actor={id:"manual-admin",role:"platform_admin",merchantId:null};
const state=(status:string)=>({orderId:"provider-attempt-1",lookupToken:null,status,stage:status,
  accountEmail:null,quotedAmountMinor:null,currency:null,message:null});

for(const driver of ["memory","sqlite"] as const)describe(`manual recharge completion (${driver})`,()=>{
  const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent",
    PUBLIC_BASE_URL:"https://tibo.ink",ADMIN_BASE_URL:"https://admin.tibo.ink"});
  let runtime:Runtime;
  afterEach(()=>runtime?.close());
  async function setup(){
    runtime=createRuntime(config);publishTestRechargeProduct(runtime);
    const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const tenant:TenantContext={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
    const order=await runtime.orders.create(tenant,{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
      quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    const paid=runtime.payment.markPaid(tenant.merchantId,order.id,{providerRef:"test:"+order.id,receivedMinor:order.saleAmountMinor});
    const payment=runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...payment,provider:"alipay_page"});
    const voucher=(await runtime.cdk.issueOne())!;
    const task=runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),
      {mode:"session",session:"secret-never-persist-in-manual-record"});
    return {tenant,order:paid,task,voucher};
  }
  function input(ref=randomUUID().replaceAll("-","")){
    return {completedAt:new Date(),externalOrderRef:"manual-"+ref,evidence:"平台外真实充值凭证 archive/receipt-123",
      reason:"自动任务明确失败后由管理员核实完成",requestKey:randomUUID()};
  }

  it("preserves the failed attempt, creates one success/commission/notification and leaves real cost pending",async()=>{
    const {tenant,order,task,voucher}=await setup();
    runtime.fulfillments.applyUpstreamEvent(task.id,state("failed_precharge"));
    const proof=input(),completed=runtime.manualCompletions.record(admin,order.id,proof,"req-1");
    expect(completed.fulfillmentId).not.toBe(task.id);
    const attempts=runtime.repository.listFulfillments(tenant.merchantId,order.id);
    expect(attempts.map(value=>value.status)).toEqual(["failed","succeeded"]);
    expect(attempts[0]?.failureCode).toBe("precharge_failed");
    expect(attempts[1]).toMatchObject({completionSource:"manual",upstreamProvider:"manual_verified",upstreamOrderId:proof.externalOrderRef});
    expect(runtime.repository.getOperations("order_cost",order.id)).toMatchObject({status:"pending_review",actualUsdMinor:null});
    expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2500n);
    const events=runtime.repository.listOutbox(tenant.merchantId).filter(value=>value.eventType==="fulfillment.succeeded");
    expect(events).toHaveLength(1);expect(events[0]?.payload).toMatchObject({completion_source:"manual",status:"succeeded"});
    expect(JSON.stringify(events)).not.toContain(proof.evidence);
    expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-1")).toThrow("已登记");
    expect(runtime.repository.listOperations("wallet_entry",tenant.merchantId).filter(value=>value.kind==="earning_release"&&value.reference===order.id)).toHaveLength(1);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(value=>value.eventType==="fulfillment.succeeded")).toHaveLength(1);
    expect(runtime.fulfillments.canResubmit(attempts[0]!)).toBe(false);
    expect(()=>runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"repeat"})).toThrow();
    expect(await runtime.fulfillments.processOne()).toBeNull();
    expect(await runtime.cdk.issueOne()).toBeNull();
    const detail=workspaceOrderDetail(runtime.repository,admin,order.id,[],"Agent");
    expect(detail).toMatchObject({fulfillmentStatus:"succeeded",completionSource:"manual",canRecordManualCompletion:false});
    expect((detail as {manualCompletion:{evidence:string}}).manualCompletion.evidence).toBe(proof.evidence);
    const agentDetail=workspaceOrderDetail(runtime.repository,{id:"agent",role:"agent_owner",merchantId:tenant.merchantId},order.id,[],"Agent");
    expect(JSON.stringify(agentDetail)).not.toContain(proof.evidence);
    expect(JSON.stringify(agentDetail)).not.toContain(proof.externalOrderRef);
    const optedIn=workspaceOrderDetail(runtime.repository,{id:"agent",role:"agent_owner",merchantId:tenant.merchantId},order.id,["upstream_order_id"],"Agent");
    expect(JSON.stringify(optedIn)).not.toContain(proof.externalOrderRef);
  });

  it("refuses queued, running, uncertain, refund-conflicted and non-admin registration",async()=>{
    const {tenant,order,task}=await setup(),proof=input();
    expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-2")).toThrow("排队");
    runtime.fulfillments.applyUpstreamEvent(task.id,state("review"));
    expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-2")).toThrow("排队");
    const uncertain=runtime.repository.findFulfillment(tenant.merchantId,task.id)!;
    runtime.repository.updateFulfillment({...uncertain,status:"failed",retryAllowed:true,leaseToken:null});
    expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-2")).toThrow("明确失败");
    runtime.repository.updateFulfillment(uncertain);
    runtime.fulfillments.applyUpstreamEvent(task.id,state("declined"));
    expect(()=>runtime.manualCompletions.record({id:"agent",role:"agent_owner",merchantId:tenant.merchantId},order.id,proof,"req-2")).toThrow("管理员");
    runtime.repository.insertRefund({id:"refund-pending",merchantId:tenant.merchantId,orderId:order.id,merchantRefundNo:"pending",
      type:"partial",amountMinor:100n,status:"requested",reason:"refund pending",failureCode:null,createdAt:new Date(),refundedAt:null});
    expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-2")).toThrow("退款");
    expect(runtime.repository.listFulfillments(tenant.merchantId,order.id)).toHaveLength(1);
    expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();
  });

  it("blocks channel refund discrepancies and reused external proof across orders",async()=>{
    const {tenant,order,task}=await setup();
    runtime.fulfillments.applyUpstreamEvent(task.id,state("declined"));
    const now=new Date(),reviewId=refundReconciliationId(order.id);
    runtime.repository.saveOperations("refund_reconciliation",{id:reviewId,merchantId:tenant.merchantId,orderId:order.id,
      provider:"alipay_page",status:"reviewing",reportedMinor:100n,recordedMinor:0n,differenceMinor:100n,
      providerReferenceFingerprint:"fingerprint",legacyTicketIds:[],version:1,firstDetectedAt:now,lastCheckedAt:now,resolvedAt:null});
    const proof=input();expect(()=>runtime.manualCompletions.record(admin,order.id,proof,"req-review")).toThrow("退款");
    runtime.repository.saveOperations("refund_reconciliation",{...runtime.repository.getOperations("refund_reconciliation",reviewId)!,status:"resolved",resolvedAt:new Date()});
    runtime.manualCompletions.record(admin,order.id,proof,"req-first");
    const second=await runtime.orders.create(tenant,{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
      quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    const paid=runtime.payment.markPaid(tenant.merchantId,second.id,{providerRef:"test:"+second.id,receivedMinor:second.saleAmountMinor});
    const voucher=(await runtime.cdk.issueOne())!;
    const attempt=runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),
      {mode:"session",session:"second-secret"});
    runtime.fulfillments.applyUpstreamEvent(attempt.id,state("failed_precharge"));
    expect(()=>runtime.manualCompletions.record(admin,second.id,{...input(),externalOrderRef:proof.externalOrderRef},"req-second"))
      .toThrow("其他订单");
    expect(runtime.repository.listFulfillments(tenant.merchantId,second.id)).toHaveLength(1);
  });

  it("confirms actual cost only with evidence and rolls back the entire success on invalid cost",async()=>{
    const {tenant,order,task}=await setup();
    runtime.fulfillments.applyUpstreamEvent(task.id,state("failed_precharge"));
    const refreshed=runtime.repository.findOrderInternal(order.id)!;
    runtime.repository.updateOrder({...refreshed,costTerms:{standardUsdMinor:1576n,refundBenchmarkUsdMinor:1576n,
      standardCnyMinor:10800n,retainedUsdMinor:15n,productVersion:1}});
    const proof=input(),bad={...proof,cost:{actualUsd:"0.00",fxRate:"7.200000",sourceReference:"clearing-001",
      evidence:"真实清算流水截图已核对",destination:"customer_direct" as const}};
    expect(()=>runtime.manualCompletions.record(admin,order.id,bad,"req-3")).toThrow();
    expect(runtime.repository.getOperations("manual_completion",order.id)).toBeNull();
    expect(runtime.repository.listFulfillments(tenant.merchantId,order.id)).toHaveLength(1);
    expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();
    const good={...proof,cost:{...bad.cost,actualUsd:"15.00"}};
    runtime.manualCompletions.record(admin,order.id,good,"req-4");
    expect(runtime.repository.getOperations("order_cost",order.id)).toMatchObject({status:"confirmed",actualUsdMinor:1500n,
      sourceReference:"clearing-001",evidence:"真实清算流水截图已核对"});
  });

  it("requires an authenticated platform administrator through the workspace endpoint",async()=>{
    const {tenant,order,task}=await setup();
    runtime.fulfillments.applyUpstreamEvent(task.id,state("failed_precharge"));
    await runtime.accounts.bootstrap("manual-admin-user","test-manual-admin-password");
    const account=runtime.repository.listOperations("account").find(value=>value.role==="platform_admin")!;
    runtime.repository.saveOperations("account",{...account,mustChangePassword:false});
    const owner=await runtime.accounts.registerOwner({username:"manual-agent-user",displayName:"Agent",
      merchantId:tenant.merchantId,password:"test-manual-agent-password"});
    runtime.repository.saveOperations("account",{...owner,mustChangePassword:false});
    const app=await buildApp(config,runtime);
    try{
      const login=await loginPlatform(app,"manual-admin-user","test-manual-admin-password","https://admin.tibo.ink");
      const headers={origin:"https://admin.tibo.ink",cookie:String(login.headers["set-cookie"]).split(";")[0]!,"x-csrf-token":login.json().csrf};
      const proof=input();
      const payload={...proof,completedAt:proof.completedAt.toISOString(),confirmAlreadyCompleted:true};
      const denied=await app.inject({method:"POST",url:`/workspace/api/orders/${order.id}/manual-completion`,payload});
      expect(denied.statusCode).toBe(403);
      const agentLogin=await app.inject({method:"POST",url:"/workspace/api/auth/login",headers:{origin:"https://tibo.ink"},
        payload:{username:"manual-agent-user",password:"test-manual-agent-password"}});
      const agentHeaders={origin:"https://tibo.ink",cookie:String(agentLogin.headers["set-cookie"]).split(";")[0]!,
        "x-csrf-token":agentLogin.json().csrf};
      expect((await app.inject({method:"POST",url:`/workspace/api/orders/${order.id}/manual-completion`,headers:agentHeaders,payload})).statusCode).toBe(403);
      const accepted=await app.inject({method:"POST",url:`/workspace/api/orders/${order.id}/manual-completion`,headers,payload});
      expect(accepted.statusCode).toBe(200);
      const replay=await app.inject({method:"POST",url:`/workspace/api/orders/${order.id}/manual-completion`,headers,payload});
      expect(replay.statusCode).toBe(200);
      expect(runtime.repository.listFulfillments(tenant.merchantId,order.id)).toHaveLength(2);
      expect(runtime.repository.listAudit(tenant.merchantId).filter(value=>value.action==="order.manual_completion.record")).toHaveLength(1);
    }finally{await app.close();}
  });
});
