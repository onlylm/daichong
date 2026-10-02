// Isolated browser acceptance ONLY: no .env, real credentials, orders or network providers.
// Orders and recharge submissions must be created by the actual browser UI.
// The preview endpoints only control a synthetic external provider and real worker methods.
import {loadConfig} from "../../src/config.js";
import {createRuntime} from "../../src/bootstrap.js";
import {buildApp} from "../../src/app.js";
import {AlipayPagePaymentProvider,AlipayPaymentService,type AlipayClient} from "../../src/modules/alipay-payment.js";
import {OrderService} from "../../src/modules/order-service.js";
import {UpstreamRequestError,type UpstreamOrderState} from "../../src/upstream/recharge-provider.js";
import {wire} from "../../src/operations/routes.js";
import {publishTestRechargeProduct} from "./recharge-catalog.js";

globalThis.fetch=async()=>{throw new Error("purchase_preview_external_network_forbidden");};
const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",EXECUTION_MODE:"disabled",PAYMENT_PROVIDER:"mock",
  FULFILLMENT_PROVIDER:"mock",LIVE_TEST_ENABLED:"false",LOG_LEVEL:"silent",DEMO_WEBHOOK_URL:"",
  PUBLIC_BASE_URL:"http://127.0.0.1:3305",ADMIN_BASE_URL:"http://127.0.0.1:3305"});
const runtime=createRuntime(config);
publishTestRechargeProduct(runtime);
const admin=await runtime.accounts.bootstrap("purchase-preview-admin","purchase-preview-admin-password-only");
const merchant=runtime.agents.create(admin,{partnerId:"purchase_preview_agent",name:"新代理 · 本地合成验收"}).merchant;
const owner=await runtime.accounts.registerOwner({username:"purchase-agent",displayName:"合成采购负责人",merchantId:merchant.id,password:"purchase-agent-initial-only"});
await runtime.accounts.changePassword(owner,"purchase-agent-initial-only","purchase-agent-password-only");
runtime.announcements.save(admin,{title:"本地模拟采购验收 · 禁止真实付款",body:"订单、账号、支付宝扫码内容与上游结果全部为隔离合成数据。不得扫描付款或提交真实凭据。",
  status:"published",audience:"all",merchantIds:[],tierCodes:[],pinned:true,startsAt:new Date(),endsAt:null});
let signatureChecks=0,precreateCalls=0,queryCalls=0,submitCalls=0,preflightCalls=0,issueCalls=0;
let outcome:"success"|"failed"|"unknown"="success";
const paymentProvider=new AlipayPagePaymentProvider(config.publicBaseUrl,runtime.portalTokens);
const identity={appId:"synthetic-purchase-app",sellerId:"2088000000000000"};
const client={
  pageExecute:()=>{throw new Error("preview_page_execute_forbidden");},
  checkNotifySignV2:(input:Record<string,string>)=>{signatureChecks++;return input.sign==="synthetic-purchase-signature";},
  exec:async(method:string,input:{bizContent:{out_trade_no:string}})=>{
    const order=runtime.repository.findOrderInternal(input.bizContent.out_trade_no);
    if(!order)throw new Error("preview_unknown_order");
    if(method==="alipay.trade.precreate"){
      precreateCalls++;return {code:"10000",qr_code:"https://qr.alipay.com/preview-do-not-pay-"+order.id};
    }
    if(method==="alipay.trade.query"){
      queryCalls++;return {code:"10000",out_trade_no:order.id,total_amount:(Number(order.saleAmountMinor)/100).toFixed(2),
        trade_status:order.paymentStatus==="paid"?"TRADE_SUCCESS":"WAIT_BUYER_PAY",trade_no:order.paymentProviderRef??"",...{app_id:identity.appId,seller_id:identity.sellerId}};
    }
    throw new Error("preview_unexpected_payment_method_"+method);
  },
} as unknown as AlipayClient;
runtime.orders=new OrderService(runtime.repository,runtime.catalog,paymentProvider,config.publicBaseUrl,runtime.portalTokens,runtime.livePolicy,runtime.wallets);
runtime.alipay=new AlipayPaymentService(runtime.repository,runtime.payment,client,identity,config.publicBaseUrl,paymentProvider);
runtime.paymentSettings.available=()=>["alipay_page"];
// This name enables the real once-only earning rule, but every provider function stays synthetic.
Object.defineProperty(runtime.upstream,"name",{value:"configured_supplier",configurable:true});
const originalIssue=runtime.upstream.issueCdk.bind(runtime.upstream);
runtime.upstream.issueCdk=async input=>{issueCalls++;return originalIssue(input);};
runtime.upstream.preflightCdk=async()=>{preflightCalls++;return {accountEmail:"synthetic-customer@example.test",currentPlan:"free",targetPlan:"plus"};};
runtime.upstream.submitCdk=async input=>{
  submitCalls++;input.onSubmitting?.("synthetic-lookup-"+input.clientRequestId);
  if(outcome==="unknown")throw new UpstreamRequestError("upstream_unavailable",true,"本地模拟：请求已提交但结果未知");
  return state(outcome==="failed"?"failed_precharge":"completed",input.clientRequestId);
};
runtime.upstream.query=async input=>state(outcome==="success"?"completed":"processing",input.clientRequestId??input.orderId);
runtime.upstream.submitDirect=async()=>{throw new Error("preview_direct_submission_not_expected");};
const app=await buildApp(config,runtime);
app.post("/__preview/outcome/:name",async request=>{
  const name=(request.params as {name:string}).name;
  if(!["success","failed","unknown"].includes(name))return {testOnly:true,error:"invalid_outcome"};
  outcome=name as typeof outcome;return {testOnly:true,outcome};
});
app.post("/__preview/worker/issue",async()=>{const item=await runtime.cdk.issueOne();return {testOnly:true,orderId:item?.orderId??null,status:item?.status??null};});
app.post("/__preview/worker/process",async()=>{const item=await runtime.fulfillments.processOne();await runtime.notifications.tick();return {testOnly:true,id:item?.id??null,orderId:item?.orderId??null,status:item?.status??null};});
app.get("/__preview/state",async()=>wire({testOnly:true,storage:"memory",externalFetch:"forbidden",outcome,
  counters:{signatureChecks,precreateCalls,queryCalls,submitCalls,preflightCalls,issueCalls},
  orders:runtime.repository.listOrdersInternal().filter(order=>order.merchantId===merchant.id).map(order=>({id:order.id,merchantOrderNo:order.merchantOrderNo,
    paymentStatus:order.paymentStatus,saleAmountMinor:order.saleAmountMinor,deliveryMode:order.deliveryMode,
    fulfillmentUrl:order.fulfillmentUrl,payUrl:paymentProvider.url(order.id),
    attempts:runtime.repository.listFulfillments(merchant.id,order.id).map(task=>({id:task.id,attemptNo:task.attemptNo,status:task.status,upstreamStatus:task.upstreamStatus})),
    paymentLedgerCount:runtime.repository.listLedger(merchant.id).filter(e=>e.orderId===order.id&&e.type==="user_payment").length,
    earningEntries:runtime.repository.listOperations("wallet_entry",merchant.id).filter(e=>e.reference===order.id&&e.kind==="earning_release").map(e=>({id:e.id,earningsDelta:e.earningsDelta})),
    successEvents:runtime.repository.listOutbox(merchant.id).filter(e=>e.eventType==="fulfillment.succeeded"&&e.payload.order_id===order.id).length,
  }))}));
await app.listen({host:"127.0.0.1",port:3305});
console.log("ISOLATED TEST/MOCK http://127.0.0.1:3305/workspace; purchase-agent / purchase-agent-password-only; initial orders=0");
async function close(){await app.close();runtime.close();}
process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());
setTimeout(()=>void close(),40*60_000).unref();
function state(status:string,id:string):UpstreamOrderState{return {orderId:"synthetic-supplier-"+id,lookupToken:"synthetic-lookup-"+id,status,stage:status,
  accountEmail:"synthetic-customer@example.test",quotedAmountMinor:1576,chargedAmountMinor:status==="completed"?1576:null,currency:"USD",
  message:status==="completed"?"本地模拟充值成功":status==="failed_precharge"?"本地模拟：扣款前明确失败，可核对后重提":"本地模拟：结果待确认，不得重复提交"};}
