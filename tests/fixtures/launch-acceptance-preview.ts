// Local UI acceptance fixture only. Never use --env-file or production data.
// All three servers bind loopback, use memory/mock providers, and forbid external fetch.
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadConfig} from "../../src/config.js";
import {createRuntime} from "../../src/bootstrap.js";
import {buildApp} from "../../src/app.js";
import {RefundService} from "../../src/modules/refund-service.js";
import {WorkerHealthReporter} from "../../src/worker/worker-health.js";
import {wire} from "../../src/operations/routes.js";
import {totpCodeAt} from "../../src/operations/accounts.js";
import {SensitivePayloadCipher} from "../../src/infra/crypto.js";
import {publishTestRechargeProduct} from "./recharge-catalog.js";

// Public, fixed synthetic authenticator seed for this memory-only fixture.
// Read its current six-digit code without starting a server:
// node --import tsx tests/fixtures/launch-acceptance-preview.ts --totp
const previewMfaSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
if (process.argv.includes("--totp")) {
  console.log(totpCodeAt(previewMfaSecret));
  process.exit(0);
}

globalThis.fetch = async () => { throw new Error("launch_preview_external_network_forbidden"); };
const temp = mkdtempSync(join(tmpdir(), "quefa-launch-ui-mock-"));
const backupReport = join(temp, "synthetic-display-state.json");
writeFileSync(backupReport, JSON.stringify({status:"ok",verifiedAt:new Date().toISOString(),transferredPages:3,
  inspection:{integrity:"ok",recordCount:0,schemaSha256:"c".repeat(64),logicalSha256:"c".repeat(64)}}));
const closeAll: Array<() => Promise<void>> = [];

for (const port of [3302, 3303, 3304]) {
  const config = loadConfig({NODE_ENV:"test", STORAGE_DRIVER:"memory", EXECUTION_MODE:"disabled",
    PAYMENT_PROVIDER:"mock", FULFILLMENT_PROVIDER:"mock", LIVE_TEST_ENABLED:"false", LOG_LEVEL:"silent",
    PUBLIC_BASE_URL:`http://127.0.0.1:${port}`,ADMIN_BASE_URL:`http://127.0.0.1:${port}`,DEMO_WEBHOOK_URL:"",
    BACKUP_HEALTH_REPORT_PATH:backupReport});
  if (config.nodeEnv !== "test" || config.storageDriver !== "memory" || config.executionMode !== "disabled"
      || config.paymentProvider !== "mock" || config.fulfillmentProvider !== "mock") {
    throw new Error("launch_preview_requires_test_memory_mock");
  }
  const runtime = createRuntime(config);
  publishTestRechargeProduct(runtime);
  const admin = await runtime.accounts.bootstrap("launch-admin", "launch-admin-initial-only");
  await runtime.accounts.changePassword(admin,"launch-admin-initial-only","launch-admin-password-only");
  // Seed a synthetic already-enrolled account; normal password + TOTP login,
  // expiry, replay protection and MFA verification remain unchanged.
  const previewAdmin = runtime.repository.getOperations("account", admin.id)!;
  const previewCipher = new SensitivePayloadCipher(config.dataEncryptionKey, config.keyEncryptionKeyId);
  runtime.repository.saveOperations("account", {...previewAdmin, mfaEnabled: true,
    mfaSecret: previewCipher.encrypt(previewMfaSecret, "mfa-account:" + admin.id),
    mfaRecoveryCodeHashes: [], mfaLastUsedStep: null, updatedAt: new Date()});
  const bundle = runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
  const tenant = {merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
  const owner = await runtime.accounts.registerOwner({username:"launch-agent",displayName:"本地合成验收代理",
    merchantId:tenant.merchantId,password:"launch-agent-initial-only"});
  await runtime.accounts.changePassword(owner,"launch-agent-initial-only","launch-agent-password-only");
  runtime.announcements.save(admin,{title:"本地模拟验收 · 禁止真实资料",body:"全部订单、渠道、健康报告及账号为隔离测试数据。此页面不证明生产环境就绪。",
    status:"published",audience:"all",merchantIds:[],tierCodes:[],pinned:true,startsAt:new Date(),endsAt:null});
  // Display-ready signals are synthetic, not real channel probes or a real restore drill.
  runtime.paymentSettings.available = () => ["alipay_page"];
  const originalConnection = runtime.supplierManagement.getConnection.bind(runtime.supplierManagement);
  runtime.supplierManagement.getConnection = () => ({...originalConnection(),enabled:true,last_test_status:"succeeded",
    last_test_at:new Date().toISOString(),last_plan_sync_at:new Date().toISOString()});
  let refundExecutions = 0, scenario = "normal";
  runtime.refunds = new RefundService(runtime.repository,runtime.ledger,runtime.webhooks,{
    providerFor:()=>"alipay_page",execute:async(_orderId,refund)=>{refundExecutions++;return "mock-channel-refund-"+refund.id;},
    query:async()=>({status:"not_confirmed",bindingVerified:true}),
  });
  const orders: Array<{kind:string;id:string;merchantOrderNo:string;url:string}> = [];
  if (port !== 3304) {
    for (const kind of ["manual-complete","refund-full","unknown","normal-processing","backlog-1","backlog-2","backlog-3","backlog-4","settlement-completed"]) {
      const order = await runtime.orders.create(tenant,{merchantOrderNo:"launch-"+kind,productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
      const paid = runtime.payment.markPaid(tenant.merchantId,order.id,{providerRef:"mock-paid-"+kind,receivedMinor:order.saleAmountMinor});
      const attempt = runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id)!;
      runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page"});
      const voucher = (await runtime.cdk.issueOne())!;
      const task = runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),
        {mode:"session",session:"synthetic-ui-only-not-real-session"});
      if (kind === "unknown" || kind === "normal-processing") {
        runtime.repository.updateFulfillment({...task,status:"running",upstreamStatus:"processing",upstreamStage:"processing",
          upstreamOrderId:"mock-upstream-"+kind,createdAt:new Date(Date.now()-(kind==="unknown"?20:1)*60_000)});
      } else if (kind === "settlement-completed") {
        const at = new Date("2026-09-30T12:00:00.000Z");
        runtime.repository.updateOrder({...runtime.repository.findOrder(tenant.merchantId,order.id)!,createdAt:at,updatedAt:at,paidAt:at});
        runtime.repository.updatePaymentAttempt({...runtime.repository.findPaymentAttemptByOrder(tenant.merchantId,order.id)!,createdAt:at,updatedAt:at,paidAt:at});
        runtime.repository.updateFulfillment({...task,status:"succeeded",message:"本地模拟：历史已完成订单（非真实上游响应）",upstreamProvider:"zovocard",upstreamOrderId:"mock-historical-completed",
          upstreamStatus:"completed",upstreamStage:"completed",createdAt:at,finishedAt:at,sessionPayload:{...task.sessionPayload,clearedAt:at}});
        runtime.repository.saveOperations("wallet_credit",{id:order.id,merchantId:tenant.merchantId,orderId:order.id,recognizedMinor:2500n,createdAt:at},true);
        runtime.repository.saveOperations("wallet_entry",{id:"earning:"+order.id,merchantId:tenant.merchantId,kind:"earning_release",
          procurementDelta:0n,earningsDelta:2500n,frozenDelta:0n,reference:order.id,actorId:"system",createdAt:at},true);
      } else {
        runtime.fulfillments.applyUpstreamEvent(task.id,{orderId:"mock-upstream-"+kind,lookupToken:null,status:"failed_precharge",
          stage:"failed_precharge",accountEmail:null,quotedAmountMinor:null,currency:null,message:"本地模拟：充值明确失败"});
      }
      if (kind === "refund-full") runtime.refunds.request(tenant,order.id,{merchantRefundNo:"launch-refund-full-request",
        type:"full",amount:"135.00",reason:"本地模拟退款申请，未调用真实渠道"});
      orders.push({kind,id:order.id,merchantOrderNo:order.merchantOrderNo,url:order.fulfillmentUrl});
    }
    runtime.dailySettlements.generate("2026-09-30");
    await runtime.notifications.tick();
  }
  const lanes = ["retail-payment","wallet-payment","invoice-payment","cdk-issuance","cdk-refund-cleanup","fulfillment",
    "refund-recovery","webhook","notifications","cost-readback","supplier-quotes","daily-settlement"];
  const reporter = new WorkerHealthReporter(runtime.repository,lanes);
  for (const lane of lanes) {reporter.start(lane);reporter.succeed(lane);}
  reporter.persist();
  const heartbeat = setInterval(()=>reporter.persist(),5000);
  const notificationTick = setInterval(()=>void runtime.notifications.tick(),11000);
  const pendingRefunds = runtime.refunds.pendingPage.bind(runtime.refunds);
  runtime.refunds.pendingPage = (...args) => {if (scenario === "partial") throw new Error("synthetic_refund_read_failure");return pendingRefunds(...args);};
  const app = await buildApp(config,runtime);
  app.addHook("onRequest",async(request,reply)=>{
    if(scenario==="partial"&&request.url.startsWith("/workspace/api/finance/summary")) return reply.code(503).send({error:{code:"synthetic_partial_failure",message:"本地模拟经营数据暂时不可用"}});
  });
  app.get("/__preview/scenario/:name",async request=>{
    const name=(request.params as {name:string}).name;
    if(!["normal","single-fault","partial"].includes(name)) return {error:"unknown_synthetic_scenario"};
    scenario=name;
    if(name==="single-fault") reporter.fail("refund-recovery"); else reporter.succeed("refund-recovery");
    reporter.persist();return {testOnly:true,scenario};
  });
  app.get("/__preview/state",async()=>wire({testOnly:true,storage:"memory",externalFetch:"forbidden",port,scenario,refundExecutions,orders,
    refunds:runtime.repository.listRefundsForOrder(tenant.merchantId,orders.find(x=>x.kind==="refund-full")?.id??"").map(r=>({id:r.id,status:r.status,providerRef:r.providerRefundNo})),
    manualCompletions:runtime.repository.listOperations("manual_completion",tenant.merchantId),
    settlements:runtime.dailySettlements.list(admin),
    walletEntries:runtime.repository.listOperations("wallet_entry",tenant.merchantId).map(e=>({kind:e.kind,reference:e.reference,earningsDelta:String(e.earningsDelta)})),
    issueStates:runtime.repository.listOperations("operational_issue",tenant.merchantId).map(i=>({orderId:i.orderId,status:i.status}))}));
  await app.listen({host:"127.0.0.1",port});
  closeAll.push(async()=>{clearInterval(heartbeat);clearInterval(notificationTick);await app.close();runtime.close();});
  console.log(`ISOLATED TEST/MOCK ONLY http://127.0.0.1:${port}/workspace (launch-admin / launch-admin-password-only; launch-agent / launch-agent-password-only)`);
}
let closing=false;
async function close(){if(closing)return;closing=true;await Promise.all(closeAll.map(fn=>fn()));rmSync(backupReport);rmSync(temp);}
process.on("SIGINT",()=>void close());
process.on("SIGTERM",()=>void close());
setTimeout(()=>void close(),40*60_000).unref();
