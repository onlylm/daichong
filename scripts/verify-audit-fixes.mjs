import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRuntime} from "../dist/bootstrap.js";
import {loadConfig} from "../dist/config.js";
import {managedGptProducts} from "../dist/modules/gpt-products.js";
import {saveGlobalWorkspaceProduct, listGlobalWorkspaceProducts} from "../dist/operations/global-product-catalog.js";
import {listWorkspaceOrders} from "../dist/operations/order-view.js";
import {canResubmitFulfillment} from "../dist/domain/recharge-policy.js";
import {isPublicAddress, validateWebhookUrl} from "../dist/infra/safe-webhook.js";
import {SqliteRepository} from "../dist/infra/sqlite-repository.js";
import {RepositoryNonceStore} from "../dist/auth/authenticator.js";
import {UpstreamRequestError} from "../dist/upstream/recharge-provider.js";
import {RefundService} from "../dist/modules/refund-service.js";
import {AlipayPaymentService} from "../dist/modules/alipay-payment.js";
import {NotificationService} from "../dist/modules/notifications.js";
import {SensitivePayloadCipher} from "../dist/infra/crypto.js";
import {createPublicCdkCode} from "../dist/modules/cdk-code.js";
import {buildApp} from "../dist/app.js";

const config = loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent",PUBLIC_BASE_URL:"https://example.test"});
const runtime=createRuntime(config), repo=runtime.repository;
const admin={id:"audit-admin",role:"platform_admin",merchantId:null};
const credential=repo.findCredential(config.demoPartnerId,config.demoKeyId);
const merchantId=credential.merchant.id;
const tenant={merchantId,partnerId:credential.merchant.partnerId,appId:credential.app.id,keyId:credential.key.keyId};
const agent={id:"audit-agent",role:"agent_owner",merchantId};
let checks=0;
function check(name,fn){fn();checks++;console.log("PASS "+name);}
async function checkAsync(name,fn){await fn();checks++;console.log("PASS "+name);}
function publish(code,amount=11000n,name){
  const current=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code===code);
  const mapping=repo.findSupplierProductMapping(code);
  repo.saveSupplierProductMapping({...mapping,enabled:true});
  return saveGlobalWorkspaceProduct(repo,code,{name:name??current.name,supplyPriceMinor:amount,available:true,priceVersion:current.priceVersion});
}
const plus="chatgpt_plus_cdk_1m";
check("new catalogue has 12 unpublished products",()=>{const all=listGlobalWorkspaceProducts(repo,runtime.catalog);assert.equal(all.length,12);assert(all.every(p=>!p.configuredAvailable));});
check("all six Codex denominations are manageable drafts",()=>assert.equal(managedGptProducts.filter(p=>p.productCode.includes("codex")).length,6));
check("Go name price and enabled mapping survive seed",()=>{publish("chatgpt_go_cdk_1m",3800n,"Go 管理员名称");runtime.supplierManagement.seed(config);assert(repo.findSupplierProductMapping("chatgpt_go_cdk_1m").enabled);assert.equal(runtime.catalog.listConfigured(merchantId).find(p=>p.productCode==="chatgpt_go_cdk_1m").name,"Go 管理员名称");});
check("global settings win over stale tenant copies",()=>{publish(plus);const grant=repo.findProductGrant(merchantId,plus);repo.saveProductGrant({...grant,supplyPriceMinor:1n,name:"stale",available:false});assert.equal(runtime.catalog.requireGrant(merchantId,plus).supplyPriceMinor,11000n);});
check("draft accepts zero price",()=>{const code="chatgpt_codex_250_cdk",p=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code===code);saveGlobalWorkspaceProduct(repo,code,{name:p.name,supplyPriceMinor:0n,available:false,priceVersion:p.priceVersion});});
check("publishing a zero-price product is rejected",()=>{const p=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code==="chatgpt_codex_250_cdk");assert.throws(()=>saveGlobalWorkspaceProduct(repo,p.code,{name:p.name,supplyPriceMinor:0n,available:true,priceVersion:p.priceVersion}));});
check("mapping version conflicts are rejected",()=>assert.throws(()=>runtime.supplierManagement.saveMapping({productCode:plus,fulfillmentMode:"cdk",supplierProduct:"gpt",supplierPlan:"plus",enabled:true,expectedVersion:999})));
check("admin adjustment is idempotent and fully recorded",()=>{const input={account:"procurement",direction:"credit",amount:"500.00",reason:"隔离验证初始资金",requestKey:"adjust-seed-01",expectedBalance:"0.00"};const first=runtime.wallets.adjustBalance(admin,merchantId,input);runtime.wallets.adjustBalance(admin,merchantId,input);assert.equal(first.beforeMinor,0n);assert.equal(first.afterMinor,50000n);assert.equal(runtime.wallets.summary(admin,merchantId).procurementAvailable,"500.00");});
check("agents cannot manually adjust funds",()=>assert.throws(()=>runtime.wallets.adjustBalance(agent,merchantId,{account:"procurement",direction:"credit",amount:"1.00",reason:"禁止代理调账",requestKey:"reject-agent",expectedBalance:"500.00"})));
check("stale balance and overdraft are rejected",()=>{assert.throws(()=>runtime.wallets.adjustBalance(admin,merchantId,{account:"procurement",direction:"debit",amount:"1.00",reason:"过期余额拦截",requestKey:"stale-balance",expectedBalance:"0.00"}));assert.throws(()=>runtime.wallets.adjustBalance(admin,merchantId,{account:"procurement",direction:"debit",amount:"501.00",reason:"超额扣减拦截",requestKey:"overdraw-balance",expectedBalance:"500.00"}));});
check("negative earnings balance can be corrected without allowing further overdraft",()=>{
  const isolated=createRuntime(config), db=isolated.repository;
  try {
    const mid=db.findCredential(config.demoPartnerId,config.demoKeyId).merchant.id;
    db.saveOperations("wallet_entry",{id:"debt-fixture",merchantId:mid,kind:"earning_reversal",procurementDelta:0n,earningsDelta:-1000n,frozenDelta:0n,reference:"fixture",actorId:"system",createdAt:new Date()},true);
    const input={account:"earnings",direction:"credit",amount:"4.00",reason:"修正隔离测试负债",requestKey:"debt-credit",expectedBalance:"-10.00"};
    const entry=isolated.wallets.adjustBalance(admin,mid,input);
    assert.equal(entry.beforeMinor,-1000n);assert.equal(entry.afterMinor,-600n);
    assert.equal(isolated.wallets.adjustBalance(admin,mid,input).id,entry.id);
    assert.equal(isolated.wallets.summary(admin,mid).earningsDebt,"6.00");
    assert.throws(()=>isolated.wallets.adjustBalance(admin,mid,{...input,requestKey:"stale-debt"}),e=>e.code==="wallet_balance_changed");
    assert.throws(()=>isolated.wallets.adjustBalance(admin,mid,{...input,requestKey:"further-debit",direction:"debit",expectedBalance:"-6.00"}),e=>e.code==="wallet_balance_insufficient");
    isolated.wallets.adjustBalance(admin,mid,{...input,requestKey:"clear-debt",amount:"6.00",expectedBalance:"-6.00"});
    assert.equal(isolated.wallets.summary(admin,mid).earningsDebt,"0.00");
    assert.equal(db.listOperations("wallet_entry",mid).length,3);
  } finally {isolated.close();}
});
const profile=runtime.agents.profile(merchantId);
repo.saveOperations("agent_profile",{...profile,collectionModes:["platform_collect","agent_collect"]});
const purchase={merchantOrderNo:"stable-purchase-01",productCode:plus,quantity:1,saleAmount:"110.00",collectionMode:"agent_collect",deliveryMode:"auto_recharge"};
let paid;
await checkAsync("replaying procurement creates one order and one debit",async()=>{paid=await runtime.orders.create(tenant,purchase);assert.equal((await runtime.orders.create(tenant,purchase)).id,paid.id);assert.equal(runtime.wallets.summary(admin,merchantId).procurementAvailable,"390.00");assert.equal(repo.listOperations("wallet_entry",merchantId).filter(e=>e.kind==="purchase").length,1);});
await checkAsync("unpublishing preserves paid order snapshot and idempotent retry",async()=>{const p=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code===plus);saveGlobalWorkspaceProduct(repo,plus,{name:p.name,supplyPriceMinor:12000n,available:false,priceVersion:p.priceVersion});assert.equal((await runtime.orders.create(tenant,purchase)).id,paid.id);assert.equal(repo.findOrderInternal(paid.id).supplyAmountMinor,11000n);publish(plus);});
const issue=runtime.upstream.issueCdk.bind(runtime.upstream);
await checkAsync("configuration failure pauses issuance instead of final failure",async()=>{runtime.upstream.issueCdk=async()=>{throw new UpstreamRequestError("upstream_configuration_error",false);};await runtime.cdk.issueOne();const v=repo.findCdkVoucherByOrder(paid.id);assert.equal(v.status,"issuing");repo.updateCdkVoucher({...v,nextAttemptAt:new Date(0)});runtime.upstream.issueCdk=issue;await runtime.cdk.issueOne();assert.equal(repo.findCdkVoucherByOrder(paid.id).status,"unused");});
const voucher=repo.findCdkVoucherByOrder(paid.id);
const task=runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"isolated-fixture-only"});
check("active task cancellation is forbidden without state changes",()=>{assert.throws(()=>runtime.fulfillments.cancelActiveForResubmit(merchantId,paid.id));assert.equal(repo.findFulfillment(merchantId,task.id).status,"queued");assert.equal(repo.findCdkVoucherByOrder(paid.id).status,"reserved");});
check("local failed label alone does not permit retry",()=>{assert.equal(canResubmitFulfillment({...task,status:"failed",failureCode:"agent_cancelled"}),false);assert.equal(canResubmitFulfillment({...task,status:"failed",upstreamStatus:"declined"}),true);});
runtime.upstream.submitCdk=async()=>({orderId:"fixture-upstream",lookupToken:null,status:"failed_precharge",stage:null,quotedAmountMinor:null,currency:null,accountEmail:null,message:"明确未扣款"});
await checkAsync("explicit upstream failure releases retry on original order",async()=>{await runtime.fulfillments.processOne();assert(canResubmitFulfillment(repo.findFulfillment(merchantId,task.id)));assert.equal(repo.findCdkVoucherByOrder(paid.id).status,"unused");assert.equal(repo.findOrderInternal(paid.id).fallbackRechargeAvailable,true);});
const retail=await runtime.orders.create(tenant,{merchantOrderNo:"retail-commission",productCode:plus,quantity:1,saleAmount:"135.00",collectionMode:"platform_collect",deliveryMode:"cdk"});
runtime.payment.markPaid(merchantId,retail.id,{providerRef:"fixture-payment",receivedMinor:13500n});
repo.updatePaymentAttempt({...repo.findPaymentAttemptByOrder(merchantId,retail.id),provider:"alipay_page"});
repo.insertFulfillment({...task,id:"fixture-success",orderId:retail.id,status:"succeeded",upstreamProvider:"fixture",upstreamStatus:"completed"});
check("wallet GET does not create earnings entries",()=>{const count=repo.listOperations("wallet_entry",merchantId).length;runtime.wallets.summary(admin,merchantId);runtime.wallets.adminOverview(admin);assert.equal(repo.listOperations("wallet_entry",merchantId).length,count);});
check("ordinary partial refund only reverses corresponding margin",()=>{runtime.wallets.reconcileOrderEarnings(retail.id);assert.equal(repo.getOperations("wallet_credit",retail.id).recognizedMinor,2500n);const current=repo.findOrderInternal(retail.id);repo.updateOrder({...current,ordinaryRefundedMinor:1000n,paymentStatus:"partially_refunded"});runtime.wallets.reconcileOrderEarnings(retail.id);assert.equal(repo.getOperations("wallet_credit",retail.id).recognizedMinor,1500n);});
check("platform compensation including fully refunded status preserves margin",()=>{const current=repo.findOrderInternal(retail.id);repo.updateOrder({...current,priceAdjustmentRefundedMinor:12500n,paymentStatus:"refunded"});runtime.wallets.reconcileOrderEarnings(retail.id);assert.equal(repo.getOperations("wallet_credit",retail.id).recognizedMinor,1500n);});
for(let i=0;i<17;i++)await runtime.orders.create(tenant,{merchantOrderNo:"page-"+i,productCode:plus,quantity:1,saleAmount:"135.00"});
check("failure filtering happens before pagination and aggregate counts",()=>{const rows=listWorkspaceOrders(repo,admin,[merchantId],new Map([[merchantId,"fixture"]]),()=>[],{page:1,limit:1,status:"failed"});assert.equal(rows.meta.total,1);assert.equal(rows.data[0].id,paid.id);});
check("tier-issued API access is accepted",()=>{repo.saveOperations("api_access",{id:merchantId,merchantId,enabled:true,depositId:"tier:gold",ticketId:"",version:1,updatedAt:new Date()});assert(runtime.authenticator.apiAccessGranted(merchantId));});
await checkAsync("order notify URL routes only to the requested endpoint",async()=>{for(const id of ["one","two"])repo.saveWebhookEndpoint({id,merchantId,url:"https://"+id+".example.com/hook",secret:"fixture-webhook-secret",status:"active",subscribedEvents:["*"]});const order=await runtime.orders.create(tenant,{merchantOrderNo:"webhook-route",productCode:plus,quantity:1,saleAmount:"135.00",notifyUrl:"https://two.example.com/hook"});runtime.webhooks.emit(merchantId,"fixture-routed","order.test",order.id,{order_id:order.id});const event=repo.listOutbox(merchantId).find(e=>e.eventKey==="fixture-routed");const deliveries=repo.claimWebhookDeliveries(100,new Date(Date.now()+60000)).map(x=>x.delivery).filter(d=>d.outboxEventId===event.id);assert.equal(deliveries.length,1);assert.equal(deliveries[0].endpointId,"two");});
check("unsafe webhook addresses are rejected",()=>{for(const address of ["127.0.0.1","10.0.0.1","169.254.169.254","::1","::ffff:127.0.0.1"])assert.equal(isPublicAddress(address),false);assert(isPublicAddress("8.8.8.8"));assert.throws(()=>validateWebhookUrl("https://127.0.0.1/hook"));assert.throws(()=>validateWebhookUrl("https://name:password@example.com"));});
check("agent owner may set only their own CDK prefix",()=>{const p=runtime.agents.profile(merchantId);runtime.agents.saveCdkSettings(agent,merchantId,{cdkCodePrefix:"TIBO",version:p.version});assert.match(createPublicCdkCode(runtime.cdk.cdkPrefix(merchantId)),/^TIBO-(?:[0-9A-F]{5}-){3}[0-9A-F]{5}$/);assert.throws(()=>runtime.agents.saveCdkSettings({...agent,role:"agent_staff"},merchantId,{cdkCodePrefix:"BAD",version:p.version+1}));assert.throws(()=>runtime.agents.saveCdkSettings({...agent,merchantId:"other"},merchantId,{cdkCodePrefix:"BAD",version:p.version+1}));});
const refundOrder=await runtime.orders.create(tenant,{merchantOrderNo:"refund-recovery",productCode:plus,quantity:1,saleAmount:"135.00"});
runtime.payment.markPaid(merchantId,refundOrder.id,{providerRef:"fixture-refund-payment",receivedMinor:13500n});
repo.updatePaymentAttempt({...repo.findPaymentAttemptByOrder(merchantId,refundOrder.id),provider:"alipay_page"});
let refundWrites=0;
const refunds=new RefundService(repo,runtime.ledger,runtime.webhooks,{providerFor:()=>"alipay_page",execute:async()=>{refundWrites++;throw new Error("fixture-lost-response");},query:async()=>({status:"succeeded",providerRefundNo:"fixture-refund-confirmed"})});
let pendingRefund;
await checkAsync("unknown refund keeps original reservation and approval is idempotent",async()=>{pendingRefund=refunds.requestCustomerRefund(admin,refundOrder.id,{reason:"隔离测试退款",requestKey:"refund-original-key"});const result=await refunds.approve(admin,pendingRefund.id);assert.equal(result.status,"processing");await refunds.approve(admin,pendingRefund.id);assert.equal(refundWrites,1);assert.equal(refunds.requestCustomerRefund(admin,refundOrder.id,{reason:"隔离测试退款",requestKey:"refund-original-key"}).id,pendingRefund.id);assert.throws(()=>refunds.requestCustomerRefund(admin,refundOrder.id,{reason:"不应再次退",requestKey:"refund-another-key"}));});
await checkAsync("refund recovery queries then books original refund exactly once",async()=>{repo.updateRefund({...refunds.get(merchantId,pendingRefund.id),nextCheckAt:new Date(0)});await refunds.reconcileOne();assert.equal(refunds.get(merchantId,pendingRefund.id).status,"succeeded");assert.equal(refundWrites,1);assert.equal(repo.findOrderInternal(refundOrder.id).ordinaryRefundedMinor,13500n);await refunds.reconcileOne();assert.equal(repo.findOrderInternal(refundOrder.id).ordinaryRefundedMinor,13500n);});
await checkAsync("Alipay query requires REFUND_SUCCESS and matching amount",async()=>{let result={code:"10000",out_trade_no:refundOrder.id,out_request_no:pendingRefund.id,total_amount:"135.00",refund_amount:"135.00",trade_no:"2026093012345678"};const client={exec:async(method,params,options)=>{assert.equal(method,"alipay.trade.fastpay.refund.query");assert.equal(params.bizContent.out_request_no,pendingRefund.id);assert.equal(options.validateSign,true);return result;}};const service=new AlipayPaymentService(repo,runtime.payment,client,{appId:"fixture",sellerId:"fixture"},"https://example.test",null);assert.equal((await service.queryRefund(refundOrder.id,pendingRefund.id,13500n)).status,"not_confirmed");result={...result,refund_status:"REFUND_SUCCESS"};assert.equal((await service.queryRefund(refundOrder.id,pendingRefund.id,13500n)).status,"succeeded");await assert.rejects(service.queryRefund(refundOrder.id,pendingRefund.id,1n));});
const cipher=new SensitivePayloadCipher(config.dataEncryptionKey,config.keyEncryptionKeyId), sent=[];
const makeNotifications=()=>new NotificationService(repo,cipher,"https://admin.example.test","https://example.test",async(_s,_password,j)=>{sent.push(j);});
let notices=makeNotifications();
check("SMTP credentials are encrypted and inaccessible to agents",()=>{const result=notices.saveSettings(admin,{enabled:false,host:"smtp.qiye.aliyun.com",username:"sender@example.test",adminEmail:"admin@example.test",password:"fixture-client-secret",version:0});assert.equal(result.hasPassword,true);assert(!JSON.stringify(result).includes("fixture-client-secret"));assert(!JSON.stringify(repo.getOperations("mail_settings","default")).includes("fixture-client-secret"));assert.throws(()=>notices.settings(agent));assert.throws(()=>notices.saveSettings(admin,{enabled:true,host:"smtp.qiye.aliyun.com",username:"sender@example.test",adminEmail:"admin@example.test",version:1}));});
// Fake verification only in this isolated database. No SMTP connection or message is made.
repo.saveOperations("mail_settings",{...repo.getOperations("mail_settings","default"),enabled:true,verifiedAt:new Date(),activatedAt:new Date(0)});
notices.savePreference(agent,{email:"agent@example.test",enabled:true,version:0});
repo.saveOperations("mail_preference",{...repo.getOperations("mail_preference",merchantId),updatedAt:new Date(0)});
const now=new Date();repo.saveOperations("ticket",{id:"fixture-mail-ticket",merchantId,orderId:paid.id,category:"recharge",title:"private fixture body must not be mailed",status:"in_progress",assigneeId:null,version:1,publicVersion:1,createdBy:"system",createdAt:now,updatedAt:now});
await checkAsync("notifications use separate recipients and deduplicate persisted events",async()=>{await notices.tick();await makeNotifications().tick();const jobs=repo.listOperations("mail_job");assert.equal(jobs.length,2);assert.equal(sent.length,2);assert(jobs.every(j=>j.status==="sent"));assert(!JSON.stringify(sent).includes("private fixture"));await makeNotifications().tick();assert.equal(repo.listOperations("mail_job").length,2);assert.equal(sent.length,2);});
await checkAsync("new recharge anomalies create one case without cancelling task",async()=>{repo.saveOperations("service_checkpoint",{id:"case-system",merchantId:null,createdAt:new Date(0)});await makeNotifications().tick();await makeNotifications().tick();assert.equal(repo.listOperations("ticket",merchantId).filter(t=>t.orderId===paid.id&&t.createdBy==="system"&&t.id.startsWith("case_")).length,1);assert.equal(repo.findFulfillment(merchantId,task.id).status,"failed");});
const app=await buildApp(config,runtime);
try{
await checkAsync("published integration and white-label guides are current and reachable",async()=>{
  for(const url of ["/developers/redemption.md","/developers/partner-guide.md"]){
    const response=await app.inject({url});
    assert.equal(response.statusCode,200);assert(response.body.includes("版本：2026-09-30"));assert(response.body.includes("retry_allowed"));assert(response.body.includes("2–8 位品牌前缀"));assert(!response.body.includes("明确失败或取消后"));
  }
  const integration=await app.inject({url:"/developers/integration.md"});assert.equal(integration.statusCode,200);assert(integration.body.includes("https://tibo.ink/developers/partner-guide.md"));
});
await checkAsync("HTTP denies agents upstream CDK endpoint and supports prefix settings",async()=>{const owner=runtime.accounts.registerOwnerWithHash({username:"audit-owner@example.test",displayName:"隔离代理",merchantId},await runtime.accounts.hashPassword("fixture-password-long-enough"));const login=await app.inject({method:"POST",url:"/workspace/api/auth/login",headers:{origin:"https://example.test"},payload:{username:owner.username,password:"fixture-password-long-enough"}});assert.equal(login.statusCode,200);const cookie=String(login.headers["set-cookie"]).split(";")[0],csrf=login.json().csrf;const denied=await app.inject({url:"/workspace/api/orders/"+paid.id+"/platform-trace",headers:{cookie}});assert.equal(denied.statusCode,403);const listed=await app.inject({url:"/workspace/api/orders?merchantId="+merchantId,headers:{cookie}});assert.equal(listed.statusCode,200);assert(listed.json().data.every(o=>!o.trace.upstreamCdkCode&&!o.trace.upstreamCdkId));const p=runtime.agents.profile(merchantId);const changed=await app.inject({method:"PATCH",url:"/workspace/api/agents/"+merchantId+"/cdk-settings",headers:{cookie,origin:"https://example.test","x-csrf-token":csrf},payload:{cdkCodePrefix:"BRAND",version:p.version}});assert.equal(changed.statusCode,200);assert.equal(runtime.cdk.cdkPrefix(merchantId),"BRAND");});}finally{await app.close();}
const folder=mkdtempSync(join(tmpdir(),"quefa-isolated-"));
try {await checkAsync("nonce replay is rejected across repository instances and restart",async()=>{let a=new SqliteRepository(join(folder,"nonce.sqlite")),b=new SqliteRepository(join(folder,"nonce.sqlite"));assert(await new RepositoryNonceStore(a).consume("key","nonce-value-one",600));assert.equal(await new RepositoryNonceStore(b).consume("key","nonce-value-one",600),false);a.close();b.close();a=new SqliteRepository(join(folder,"nonce.sqlite"));assert.equal(await new RepositoryNonceStore(a).consume("key","nonce-value-one",600),false);a.close();});}
finally {rmSync(folder,{recursive:true,force:true});runtime.close();}
console.log(JSON.stringify({passed:checks,network:"disabled by container",database:"memory plus isolated temporary SQLite",productionWrites:false}));
