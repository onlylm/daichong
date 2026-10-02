// Synthetic local finance UI acceptance. No env file, real data, money or network.
import {loadConfig} from "../../src/config.js";
import {createRuntime} from "../../src/bootstrap.js";
import {buildApp} from "../../src/app.js";
import {RefundService} from "../../src/modules/refund-service.js";
import {wire} from "../../src/operations/routes.js";
import {publishTestRechargeProduct} from "./recharge-catalog.js";

globalThis.fetch=async()=>{throw new Error("finance_preview_external_network_forbidden");};
const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",EXECUTION_MODE:"disabled",PAYMENT_PROVIDER:"mock",
  FULFILLMENT_PROVIDER:"mock",LIVE_TEST_ENABLED:"false",LOG_LEVEL:"silent",PUBLIC_BASE_URL:"http://127.0.0.1:3306",
  ADMIN_BASE_URL:"http://127.0.0.1:3306",DEMO_WEBHOOK_URL:""});
const runtime=createRuntime(config);publishTestRechargeProduct(runtime);
const admin=await runtime.accounts.bootstrap("finance-admin","finance-admin-initial-only");
await runtime.accounts.changePassword(admin,"finance-admin-initial-only","finance-admin-password-only");
const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
const tenant={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
const owner=await runtime.accounts.registerOwner({username:"finance-agent",displayName:"退款差异合成验收代理",merchantId:tenant.merchantId,password:"finance-agent-initial-only"});
await runtime.accounts.changePassword(owner,"finance-agent-initial-only","finance-agent-password-only");
runtime.announcements.save(admin,{title:"隔离财务验收 · 不是真实渠道凭证",body:"QF0000000001：普通客户部分退款，渠道累计20元，凭证SYNTH-PARTIAL-10-A与SYNTH-PARTIAL-10-B各10元；不是补差。QF0000000002：普通全额退款135元，凭证SYNTH-FULL-135。全部为memory/mock合成事实，禁止真实资料。",status:"published",audience:"all",merchantIds:[],tierCodes:[],pinned:true,startsAt:new Date(),endsAt:null});
let refundExecuteCalls=0;
runtime.refunds=new RefundService(runtime.repository,runtime.ledger,runtime.webhooks,{
  providerFor:()=>"alipay_page",execute:async()=>{refundExecuteCalls++;throw new Error("finance_preview_refund_execution_forbidden");},
  query:async()=>({status:"not_confirmed",bindingVerified:true}),
},undefined,{discrepancy:input=>runtime.refundReconciliations.observe(input),recorded:input=>runtime.refundReconciliations.recorded(input)});
const fixtures:Array<{kind:string;orderId:string;customerUrl:string}>=[];
for(const kind of ["ordinary-partial-20","ordinary-full-135"]){
  const order=await runtime.orders.create(tenant,{merchantOrderNo:"synthetic-finance-"+kind,productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
  const paid=runtime.payment.markPaid(tenant.merchantId,order.id,{providerRef:"synthetic-payment-"+kind,receivedMinor:order.saleAmountMinor});
  const attempt=runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id)!;
  runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page"});
  const voucher=(await runtime.cdk.issueOne())!;
  const task=runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"synthetic-finance-not-real-session"});
  runtime.fulfillments.applyUpstreamEvent(task.id,{orderId:"synthetic-upstream-"+kind,lookupToken:null,status:"completed",stage:"completed",accountEmail:null,quotedAmountMinor:1576,currency:"USD",message:"合成历史履约已完成，非真实上游响应"});
  const finished=runtime.repository.findFulfillment(tenant.merchantId,task.id)!;
  runtime.repository.updateFulfillment({...finished,upstreamProvider:"configured_supplier"});
  runtime.wallets.reconcileMerchantEarnings(tenant.merchantId);
  runtime.refunds.syncProviderRefund(order.id,kind==="ordinary-partial-20"?2000n:13500n,"synthetic-provider-total-"+kind);
  fixtures.push({kind,orderId:order.id,customerUrl:order.fulfillmentUrl});
}
const app=await buildApp(config,runtime);
// Read-only corroboration endpoint; browser actions must use the real workspace UI.
app.get("/__preview/state",async()=>wire({testOnly:true,storage:"memory",refundExecuteCalls,fixtures,
  reviews:runtime.repository.listOperations("refund_reconciliation",tenant.merchantId),
  refunds:fixtures.flatMap(value=>runtime.repository.listRefundsForOrder(tenant.merchantId,value.orderId)),
  wallet:runtime.wallets.summary(owner,tenant.merchantId),walletEntries:runtime.repository.listOperations("wallet_entry",tenant.merchantId)}));
await app.listen({host:"127.0.0.1",port:3306});
console.log("ISOLATED MEMORY/MOCK http://127.0.0.1:3306/workspace | finance-admin / finance-admin-password-only | finance-agent / finance-agent-password-only");
let closing=false;async function close(){if(closing)return;closing=true;await app.close();runtime.close();}
process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());setTimeout(()=>void close(),30*60_000).unref();
