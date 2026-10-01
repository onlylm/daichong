import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Refund,TenantContext} from "../src/domain/model.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";
import {RefundService,type RefundExecutor} from "../src/modules/refund-service.js";
import type {Actor} from "../src/operations/model.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const admin:Actor={id:"closure-admin",role:"platform_admin",merchantId:null};
type QueryResult=Awaited<ReturnType<NonNullable<RefundExecutor["query"]>>>;
function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function evidence(refund:Refund){
  return {refundRequestNo:refund.id,evidenceReference:"channel-case-"+randomUUID(),
    evidence:"渠道支持已按原退款请求号核实终止且没有向客户退款，凭证存于受限工单附件。",
    reason:"原退款已终止，核验后允许登记人工完成",evidenceAt:new Date(),confirmChannelTerminatedWithoutRefund:true as const};
}
function manualEvidence(){return {completedAt:new Date(),externalOrderRef:"manual-"+randomUUID(),
  evidence:"隔离测试人工充值完成凭证 archive/manual-receipt",reason:"原自动任务明确失败后另行完成充值"};}

for(const driver of ["memory","sqlite"] as const)describe(`failed refund evidence closure (${driver})`,()=>{
  const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent",
    PUBLIC_BASE_URL:"https://tibo.ink",ADMIN_BASE_URL:"https://admin.tibo.ink"});
  let runtime:Runtime;
  afterEach(()=>{vi.restoreAllMocks();runtime?.close();});
  async function setup(changes:Partial<Refund>={}){
    runtime=createRuntime(config);publishTestRechargeProduct(runtime);
    const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const tenant:TenantContext={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
    const created=await runtime.orders.create(tenant,{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    const order=runtime.payment.markPaid(tenant.merchantId,created.id,{providerRef:"test:"+created.id,receivedMinor:created.saleAmountMinor});
    const payment=runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...payment,provider:"alipay_page"});
    const voucher=(await runtime.cdk.issueOne())!;
    const task=runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"isolated-closure-test-session"});
    runtime.fulfillments.applyUpstreamEvent(task.id,{orderId:"synthetic-failed-attempt",lookupToken:null,status:"failed_precharge",stage:"failed_precharge",accountEmail:null,quotedAmountMinor:null,currency:null,message:null});
    const requested=runtime.refunds.request(tenant,order.id,{merchantRefundNo:"closure-"+randomUUID(),type:"full",amount:"135.00",reason:"自动充值失败申请原路退款"});
    const refund:Refund={...requested,status:"failed",failureCode:"original_channel_failure",createdAt:new Date(Date.now()-180_000),
      lastSubmittedAt:new Date(Date.now()-120_000).toISOString(),leaseToken:null,leaseUntil:null,...changes};
    runtime.repository.updateRefund(refund);return {tenant,order,task,refund};
  }
  function service(query?:RefundExecutor["query"]){
    const execute=vi.fn(async()=>"synthetic-adjustment-refund-001");
    const refunds=new RefundService(runtime.repository,runtime.ledger,runtime.webhooks,{providerFor:()=>"alipay_page",execute,...(query?{query}:{})});
    return {refunds,execute};
  }
  function closureAudits(refund:Refund){return runtime.repository.listAudit(refund.merchantId).filter(value=>value.targetId===refund.id);}

  it("preserves evidence and failure history, releases manual completion once and permits only a partial price adjustment",async()=>{
    const {tenant,order,task,refund}=await setup(),proof=evidence(refund);
    const query=vi.fn<NonNullable<RefundExecutor["query"]>>(async()=>({status:"not_confirmed",bindingVerified:true}));
    const {refunds,execute}=service(query);
    expect(()=>runtime.manualCompletions.record(admin,order.id,manualEvidence(),"before-close")).toThrow("待处理退款");
    const ledgerCount=runtime.repository.listLedger(tenant.merchantId).length;
    const closed=await refunds.closeFailedWithEvidence(admin,refund.id,proof,"close-first");
    expect(closed).toMatchObject({status:"cancelled",failureCode:refund.failureCode,refundedAt:null,cancelledReview:{actorId:admin.id,
      refundRequestNo:refund.id,evidenceReference:proof.evidenceReference,evidence:proof.evidence,reason:proof.reason,evidenceAt:proof.evidenceAt.toISOString()}});
    expect(query).toHaveBeenCalledWith(order.id,expect.objectContaining({id:refund.id,amountMinor:13_500n}));
    expect(execute).not.toHaveBeenCalled();expect(runtime.repository.listLedger(tenant.merchantId)).toHaveLength(ledgerCount);
    expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus:"paid",ordinaryRefundedMinor:0n});
    expect(await refunds.closeFailedWithEvidence(admin,refund.id,proof,"close-replay")).toEqual(closed);
    expect(query).toHaveBeenCalledOnce();expect(closureAudits(refund)).toHaveLength(1);
    expect(closureAudits(refund)[0]?.action).toBe("refund.failed_review.cancel");
    await expect(refunds.closeFailedWithEvidence(admin,refund.id,{...proof,evidence:proof.evidence+"变更"},"close-conflict")).rejects.toMatchObject({code:"refund_closure_conflict"});
    expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toEqual(closed);
    await expect(refunds.approve(admin,refund.id)).rejects.toMatchObject({code:"refund_changed"});expect(execute).not.toHaveBeenCalled();
    const completion=manualEvidence();runtime.manualCompletions.record(admin,order.id,completion,"after-close");
    expect(()=>runtime.manualCompletions.record(admin,order.id,completion,"repeat-completion")).toThrow("已登记");
    expect(runtime.repository.findFulfillment(tenant.merchantId,task.id)).toMatchObject({status:"failed",failureCode:"precharge_failed"});
    expect(runtime.repository.listFulfillments(tenant.merchantId,order.id).filter(value=>value.status==="succeeded")).toHaveLength(1);
    expect(runtime.repository.listOperations("wallet_entry",tenant.merchantId).filter(value=>value.kind==="earning_release"&&value.reference===order.id)).toHaveLength(1);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(value=>value.eventType==="fulfillment.succeeded")).toHaveLength(1);
    expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2_500n);
    expect(()=>refunds.requestPriceAdjustment(admin,order.id,{amount:"135.00",reason:"不得借补差全退",requestKey:"full-adjustment"})).toThrow("全额退款不能使用差价退款");
    const adjustment=refunds.requestPriceAdjustment(admin,order.id,{amount:"5.00",reason:"人工完成后的合法价差退款",requestKey:"partial-adjustment"});
    expect(await refunds.approve(admin,adjustment.id)).toMatchObject({status:"succeeded",type:"price_adjustment"});expect(execute).toHaveBeenCalledOnce();
    expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({ordinaryRefundedMinor:0n,priceAdjustmentRefundedMinor:500n});
    runtime.wallets.reconcileMerchantEarnings(tenant.merchantId);expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2_500n);
  });

  it.each(["agent_owner","platform_finance","platform_support","platform_auditor"] as const)("denies %s before querying the channel",async role=>{
    const {tenant,refund}=await setup(),query=vi.fn<NonNullable<RefundExecutor["query"]>>(async()=>({status:"not_confirmed",bindingVerified:true}));
    const actor:Actor={id:"not-admin",role,merchantId:role==="agent_owner"?tenant.merchantId:null};
    await expect(service(query).refunds.closeFailedWithEvidence(actor,refund.id,evidence(refund),"role-denied")).rejects.toMatchObject({code:"permission_denied"});
    expect(query).not.toHaveBeenCalled();expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toEqual(refund);
  });

  it.each(["wrong-request","short-reference","short-evidence","short-reason","future-time","old-evidence","unconfirmed"] as const)("rejects %s evidence without modifying the refund",async invalid=>{
    const {tenant,refund}=await setup(),proof=evidence(refund);
    if(invalid==="wrong-request")proof.refundRequestNo="other-refund-request";
    if(invalid==="short-reference")proof.evidenceReference="short";
    if(invalid==="short-evidence")proof.evidence="证据不足";
    if(invalid==="short-reason")proof.reason="短";
    if(invalid==="future-time")proof.evidenceAt=new Date(Date.now()+60_000);
    if(invalid==="old-evidence")proof.evidenceAt=new Date(Date.parse(refund.lastSubmittedAt!)-1);
    if(invalid==="unconfirmed")Reflect.set(proof,"confirmChannelTerminatedWithoutRefund",false);
    const query=vi.fn<NonNullable<RefundExecutor["query"]>>(async()=>({status:"not_confirmed",bindingVerified:true}));
    await expect(service(query).refunds.closeFailedWithEvidence(admin,refund.id,proof,"invalid-proof")).rejects.toMatchObject({code:
      ["future-time","old-evidence"].includes(invalid)?"refund_closure_time_invalid":"refund_closure_evidence_required"});
    expect(query).not.toHaveBeenCalled();expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toEqual(refund);
  });

  it.each(["processing","requested","active-lease","unknown-lease-expiry","recent-submission"] as const)("keeps %s refunds blocked without querying",async blocked=>{
    const changes:Partial<Refund>={};
    if(blocked==="processing"||blocked==="requested")changes.status=blocked;
    if(blocked==="active-lease"||blocked==="unknown-lease-expiry"){changes.leaseToken="another-worker";changes.leaseUntil=blocked==="active-lease"?new Date(Date.now()+60_000):null;}
    if(blocked==="recent-submission")changes.lastSubmittedAt=new Date(Date.now()-20_000).toISOString();
    const {tenant,refund}=await setup(changes),query=vi.fn<NonNullable<RefundExecutor["query"]>>(async()=>({status:"not_confirmed",bindingVerified:true}));
    await expect(service(query).refunds.closeFailedWithEvidence(admin,refund.id,evidence(refund),"blocked")).rejects.toMatchObject({code:
      ["processing","requested"].includes(blocked)?"refund_changed":"refund_review_in_progress"});
    expect(query).not.toHaveBeenCalled();expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toEqual(refund);
  });

  it.each(["missing-query","missing-binding","false-binding","query-timeout"] as const)("does not unlock completion for %s",async failure=>{
    const {tenant,order,refund}=await setup();
    const query:RefundExecutor["query"]=failure==="missing-query"?undefined:async()=>{
      if(failure==="query-timeout")throw new Error("synthetic channel timeout");
      return {status:"not_confirmed",...(failure==="false-binding"?{bindingVerified:false}:{})};
    };
    const {refunds,execute}=service(query);
    await expect(refunds.closeFailedWithEvidence(admin,refund.id,evidence(refund),"query-blocked")).rejects.toThrow();
    expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toMatchObject({status:"failed",failureCode:refund.failureCode});
    expect(runtime.repository.findRefund(tenant.merchantId,refund.id)?.cancelledReview).toBeUndefined();
    expect(closureAudits(refund)).toHaveLength(0);expect(execute).not.toHaveBeenCalled();
    expect(()=>runtime.manualCompletions.record(admin,order.id,manualEvidence(),"still-blocked")).toThrow("待处理退款");
  });
  it("keeps an independent channel refund discrepancy locked after closing one failed request",async()=>{
    const {tenant,order,refund}=await setup(),now=new Date(),reviewId=refundReconciliationId(order.id);
    runtime.repository.saveOperations("refund_reconciliation",{id:reviewId,merchantId:tenant.merchantId,orderId:order.id,
      provider:"alipay_page",status:"reviewing",reportedMinor:100n,recordedMinor:0n,differenceMinor:100n,
      providerReferenceFingerprint:"isolated-fingerprint",legacyTicketIds:[],version:1,firstDetectedAt:now,lastCheckedAt:now,resolvedAt:null});
    const originalReview=runtime.repository.getOperations("refund_reconciliation",reviewId);
    const {refunds,execute}=service(async()=>({status:"not_confirmed",bindingVerified:true}));
    expect(await refunds.closeFailedWithEvidence(admin,refund.id,evidence(refund),"close-with-discrepancy")).toMatchObject({status:"cancelled"});
    expect(runtime.repository.getOperations("refund_reconciliation",reviewId)).toEqual(originalReview);
    expect(()=>runtime.manualCompletions.record(admin,order.id,manualEvidence(),"discrepancy-still-blocked")).toThrow("退款差异");
    expect(runtime.repository.getOperations("manual_completion",order.id)).toBeNull();
    expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();expect(execute).not.toHaveBeenCalled();
  });

  it("books confirmed channel success against the original refund instead of cancelling it",async()=>{
    const {tenant,order,refund}=await setup();
    const {refunds,execute}=service(async()=>({status:"succeeded",providerRefundNo:"verified-channel-success-001"}));
    expect(await refunds.closeFailedWithEvidence(admin,refund.id,evidence(refund),"found-paid")).toMatchObject({id:refund.id,status:"succeeded",providerRefundNo:"verified-channel-success-001"});
    expect(runtime.repository.listRefundsForOrder(tenant.merchantId,order.id)).toHaveLength(1);
    expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus:"refunded",ordinaryRefundedMinor:13_500n});
    expect(runtime.repository.listLedger(tenant.merchantId).filter(value=>value.type==="ordinary_refund")).toHaveLength(1);
    expect(runtime.repository.listOutbox(tenant.merchantId).filter(value=>value.eventType==="refund.succeeded")).toHaveLength(1);
    expect(closureAudits(refund)[0]?.action).toBe("refund.failed_review.found_refunded");expect(execute).not.toHaveBeenCalled();
    expect(()=>runtime.manualCompletions.record(admin,order.id,manualEvidence(),"already-refunded")).toThrow("退款");
  });

  it("fences a second close and approval while channel verification is pending",async()=>{
    const {tenant,refund}=await setup(),pending=deferred<QueryResult>(),proof=evidence(refund);
    const query=vi.fn(()=>pending.promise),{refunds,execute}=service(query);
    const closing=refunds.closeFailedWithEvidence(admin,refund.id,proof,"first-review");
    try{
      expect(runtime.repository.findRefund(tenant.merchantId,refund.id)?.leaseToken).toBeTruthy();
      await expect(refunds.closeFailedWithEvidence(admin,refund.id,proof,"second-review")).rejects.toMatchObject({code:"refund_review_in_progress"});
      await expect(refunds.approve(admin,refund.id)).rejects.toMatchObject({code:"refund_review_in_progress"});
      expect(query).toHaveBeenCalledOnce();expect(execute).not.toHaveBeenCalled();
    }finally{pending.resolve({status:"not_confirmed",bindingVerified:true});}
    expect(await closing).toMatchObject({status:"cancelled"});expect(closureAudits(refund)).toHaveLength(1);
  });

  it.each(["not-confirmed","query-error"] as const)("does not overwrite newer state after an old %s query returns",async outcome=>{
    const {tenant,refund}=await setup(),pending=deferred<QueryResult>();
    const {refunds,execute}=service(()=>pending.promise),closing=refunds.closeFailedWithEvidence(admin,refund.id,evidence(refund),"old-review");
    const failed=expect(closing).rejects.toThrow();
    const newer={...runtime.repository.findRefund(tenant.merchantId,refund.id)!,status:"processing" as const,
      failureCode:"newer-channel-operation",leaseToken:"new-owner",leaseUntil:new Date(Date.now()+60_000)};
    runtime.repository.updateRefund(newer);
    if(outcome==="query-error")pending.reject(new Error("old query timeout"));else pending.resolve({status:"not_confirmed",bindingVerified:true});
    await failed;expect(runtime.repository.findRefund(tenant.merchantId,refund.id)).toEqual(newer);
    expect(closureAudits(refund)).toHaveLength(0);expect(execute).not.toHaveBeenCalled();
  });

  it("requires an administrator session and CSRF, and hides closure evidence from the agent HTTP view",async()=>{
    const {tenant,order,refund}=await setup(),proof=evidence(refund);
    const query=vi.fn<NonNullable<RefundExecutor["query"]>>(async()=>({status:"not_confirmed",bindingVerified:true})),{refunds,execute}=service(query);
    vi.spyOn(runtime.refunds,"closeFailedWithEvidence").mockImplementation((...args)=>refunds.closeFailedWithEvidence(...args));
    await runtime.accounts.bootstrap("closure-admin-user","test-closure-admin-password");
    const account=runtime.repository.listOperations("account").find(value=>value.role==="platform_admin")!;
    runtime.repository.saveOperations("account",{...account,mustChangePassword:false});
    const owner=await runtime.accounts.registerOwner({username:"closure-agent-user",displayName:"Agent",merchantId:tenant.merchantId,password:"test-closure-agent-password"});
    runtime.repository.saveOperations("account",{...owner,mustChangePassword:false});
    const app=await buildApp(config,runtime);
    try{
      const url=`/workspace/api/refunds/${refund.id}/close-failed`,payload={...proof,evidenceAt:proof.evidenceAt.toISOString()};
      expect((await app.inject({method:"POST",url,payload})).statusCode).toBe(403);
      const login=await loginPlatform(app,"closure-admin-user","test-closure-admin-password","https://admin.tibo.ink");
      const headers={origin:"https://admin.tibo.ink",cookie:String(login.headers["set-cookie"]).split(";")[0]!,"x-csrf-token":login.json().csrf};
      const noCsrf=await app.inject({method:"POST",url,payload,headers:{origin:headers.origin,cookie:headers.cookie}});
      expect(noCsrf.statusCode).toBe(403);expect(noCsrf.json().error.code).toBe("csrf_denied");
      expect((await app.inject({method:"POST",url,payload,headers:{...headers,"x-csrf-token":"invalid"}})).statusCode).toBe(403);
      const agentLogin=await app.inject({method:"POST",url:"/workspace/api/auth/login",headers:{origin:"https://tibo.ink"},payload:{username:"closure-agent-user",password:"test-closure-agent-password"}});
      const agentHeaders={origin:"https://tibo.ink",cookie:String(agentLogin.headers["set-cookie"]).split(";")[0]!,"x-csrf-token":agentLogin.json().csrf};
      const denied=await app.inject({method:"POST",url,payload,headers:agentHeaders});
      expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe("permission_denied");expect(query).not.toHaveBeenCalled();
      const accepted=await app.inject({method:"POST",url,payload,headers});
      expect(accepted.statusCode,accepted.body).toBe(200);expect(accepted.json().data.status).toBe("cancelled");
      expect((await app.inject({method:"POST",url,payload,headers})).statusCode).toBe(200);
      expect(query).toHaveBeenCalledOnce();expect(closureAudits(refund)).toHaveLength(1);expect(execute).not.toHaveBeenCalled();
      const adminDetail=await app.inject({url:`/workspace/api/orders/${order.id}`,headers});
      expect(adminDetail.statusCode).toBe(200);expect(adminDetail.body).toContain(proof.evidenceReference);
      const agentDetail=await app.inject({url:`/workspace/api/orders/${order.id}`,headers:agentHeaders});
      expect(agentDetail.statusCode).toBe(200);
      for(const secret of [proof.evidenceReference,proof.evidence,proof.reason])expect(agentDetail.body).not.toContain(secret);
      expect(agentDetail.json().data.refunds.find((value:{id:string})=>value.id===refund.id).cancelledReview).toBeNull();
    }finally{await app.close();}
  });
});
