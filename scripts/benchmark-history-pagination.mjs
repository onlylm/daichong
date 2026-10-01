import {performance} from "node:perf_hooks";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildApp} from "../dist/app.js";
import {createRuntime} from "../dist/bootstrap.js";
import {loadConfig} from "../dist/config.js";
import {totpCodeAt} from "../dist/operations/accounts.js";

const tiers = [100, 1_000, 5_000];
const limit = 20;
const requestsPerResource = 3;
const concurrentRequestTarget = 40;

async function loginPlatform(app, username, password, origin) {
  const passwordResult = await app.inject({method: "POST", url: "/workspace/api/auth/login", headers: {origin}, payload: {username, password}});
  if (passwordResult.statusCode !== 200) throw new Error("benchmark_login_failed:" + passwordResult.body);
  const challenge = passwordResult.json().mfa;
  const verified = await app.inject({method: "POST", url: "/workspace/api/auth/mfa/verify", headers: {origin},
    payload: {challenge_token: challenge.challenge_token, code: totpCodeAt(challenge.secret)}});
  if (verified.statusCode !== 200) throw new Error("benchmark_mfa_failed:" + verified.body);
  return String(verified.headers["set-cookie"]).split(";")[0];
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0;
}

function seed(runtime, count) {
  const merchant = runtime.repository.listMerchants()[0];
  const app = runtime.repository.listApps(merchant.id)[0];
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  runtime.repository.transaction(() => {
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(6, "0");
      const timestamp = new Date(base + index * 1_000);
      const orderId = `ord_bench_${suffix}`;
      runtime.repository.insertOrder({id:orderId,merchantId:merchant.id,appId:app.id,merchantOrderNo:`ORDER-BENCH-${suffix}`,
        productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmountMinor:13_500n,supplyAmountMinor:11_000n,
        ordinaryRefundedMinor:0n,priceAdjustmentRefundedMinor:0n,currency:"CNY",paymentStatus:"paid",metadata:{benchmark:true},
        paymentProviderRef:`payment-bench-${suffix}`,paymentReceivedMinor:13_500n,paymentFeeMinor:0n,qrPayload:null,qrImageUrl:null,
        collectionMode:"platform_collect",deliveryMode:"cdk",fulfillmentMode:"cdk",upstreamProduct:"gpt",upstreamPlan:"chatgpt_plus_1m",
        fulfillmentUrl:`https://tibo.ink/redeem/${orderId}`,voucherCode:null,settlementId:null,paidAt:timestamp,
        expiresAt:new Date(timestamp.getTime()+30*60_000),createdAt:timestamp,updatedAt:timestamp});
      runtime.repository.insertRefund({id:`refund_customer_bench_${suffix}`,merchantId:merchant.id,orderId,
        merchantRefundNo:`REFUND-CUSTOMER-BENCH-${suffix}`,type:index%2?"partial":"full",amountMinor:100n,status:"requested",
        reason:"客户退款并发基准",failureCode:null,providerRefundNo:null,nextCheckAt:null,recoveryAttempts:0,createdAt:timestamp,refundedAt:null});
      runtime.repository.insertRefund({id:`refund_adjustment_bench_${suffix}`,merchantId:merchant.id,orderId,
        merchantRefundNo:`REFUND-ADJUSTMENT-BENCH-${suffix}`,type:"price_adjustment",amountMinor:50n,status:"failed",
        reason:"补差退款并发基准",failureCode:"benchmark",providerRefundNo:null,nextCheckAt:null,recoveryAttempts:1,createdAt:timestamp,refundedAt:null});
      runtime.repository.saveOperations("wallet_withdrawal",{id:`withdraw_bench_${suffix}`,merchantId:merchant.id,
        amountMinor:1_000n,status:"requested",requestKey:`withdraw-bench-${suffix}`,requestedBy:"benchmark",reviewerId:null,
        payoutReference:null,reason:"提现并发基准",payoutMethod:"alipay",payoutAccount:"benchmark@example.com",payoutName:"基准代理",
        createdAt:timestamp,updatedAt:timestamp},true);
      runtime.repository.saveOperations("refund_reconciliation",{id:`refund-reconciliation:${orderId}`,merchantId:merchant.id,
        orderId,provider:"alipay_page",status:"reviewing",reportedMinor:200n,recordedMinor:0n,differenceMinor:200n,
        providerReferenceFingerprint:`fingerprint-${suffix}`,legacyTicketIds:[],version:1,firstDetectedAt:timestamp,
        lastCheckedAt:timestamp,resolvedAt:null},true);
      runtime.repository.saveOperations("operational_issue",{id:`issue_bench_${suffix}`,merchantId:merchant.id,orderId,
        entityId:orderId,kind:"recharge",status:"open",severity:index%10===0?"urgent":"normal",reason:"履约并发基准",
        retryAllowed:false,attentionKey:`${index%10===0?"0":"1"}:${timestamp.toISOString()}`,dueAt:timestamp,
        firstDetectedAt:timestamp,updatedAt:timestamp,resolvedAt:null,legacyTicketIds:[]},true);
      runtime.repository.saveOperations("ticket", {id: `tk_bench_${suffix}`, merchantId: merchant.id, orderId: null,
        title: `并发基准工单 ${suffix}`, category: "other", status: index % 2 === 0 ? "open" : "resolved",
        assigneeId: null, version: 1, publicVersion: 1, createdBy: "benchmark", createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("invoice_application", {id: `inv_bench_${suffix}`, merchantId: merchant.id,
        orderId: `order_bench_${suffix}`, requestKey: `invoice-bench-${suffix}`, titleType: "enterprise",
        invoiceTitle: `并发基准企业 ${suffix}`, taxIdEncrypted: {ciphertext: null, iv: null, authTag: null, keyVersion: "benchmark", clearedAt: timestamp},
        recipientEmail: `invoice-${suffix}@example.com`, contactName: "基准联系人", contactPhone: null, remark: null,
        invoiceAmountMinor: 10_000n, feeRateBps: 500, feeAmountMinor: 500n, category: "技术服务费",
        status: index % 2 === 0 ? "submitted" : "issued", paymentId: `invpay_bench_${suffix}`,
        providerRef: `provider-bench-${suffix}`, paidAt: timestamp, submittedAt: timestamp, reviewNote: null,
        invoiceNo: null, issuedAt: index % 2 === 0 ? null : timestamp, version: 1, createdBy: "benchmark",
        createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("daily_settlement", {id: `ds_bench_${suffix}`, merchantId: merchant.id,
        businessDate: timestamp.toISOString().slice(0, 10), periodFrom: timestamp, periodTo: timestamp,
        status: index % 2 === 0 ? "pending_payment" : "reconciled", orderIds: [], orderCount: 0,
        supplyAmountMinor: 0n, agentEarningsMinor: 100n, platformCostMinor: 0n, platformProfitMinor: 0n,
        payableMinor: 100n, currency: "CNY", payoutMethod: null, payoutReference: null, payoutEvidence: null,
        note: null, confirmedBy: null, version: 1, generatedAt: timestamp, paidAt: null,
        reconciledAt: index % 2 === 0 ? null : timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("wallet_entry", {id: `went_bench_${suffix}`, merchantId: merchant.id,
        kind: "deposit", procurementDelta: 100n, earningsDelta: 0n, frozenDelta: 0n,
        reference: `wallet-bench-${suffix}`, actorId: "benchmark", createdAt: timestamp}, true);
      runtime.repository.appendAudit({id: `aud_bench_${suffix}`, merchantId: merchant.id, actorType: "system",
        actorId: "benchmark", action: "benchmark.read", targetType: "merchant", targetId: merchant.id,
        requestId: `request-bench-${suffix}`, createdAt: timestamp});
    }
  });
  return merchant;
}

async function runTier(count) {
  const folder = mkdtempSync(join(tmpdir(), "quefa-pagination-benchmark-"));
  let runtime, app;
  try {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: join(folder, "benchmark.sqlite"), LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  runtime = createRuntime(config);
  const username = `benchmark-admin-${count}`;
  const password = `benchmark-password-${count}`;
  await runtime.accounts.bootstrap(username, password);
  const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin");
  runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
  const merchant = seed(runtime, count);
  app = await buildApp(config, runtime);
  const cookie = await loginPlatform(app, username, password, "https://admin.tibo.ink");
  const headers = {origin: "https://admin.tibo.ink", cookie};
  const originalQuery = runtime.repository.queryRecords.bind(runtime.repository);
  const originalOrderQuery = runtime.repository.queryWorkspaceOrders.bind(runtime.repository);
  const queryDurations = new Map();
  let queryCount = 0;
  runtime.repository.queryRecords = (...args) => {
    queryCount++;
    const started=performance.now();
    try{return originalQuery(...args);}
    finally{
      const kind=String(args[0]),values=queryDurations.get(kind)??[];
      values.push(performance.now()-started);queryDurations.set(kind,values);
    }
  };
  runtime.repository.queryWorkspaceOrders = (...args) => {
    queryCount++;
    const started=performance.now();
    try{return originalOrderQuery(...args);}
    finally{
      const values=queryDurations.get("workspace_orders")??[];
      values.push(performance.now()-started);queryDurations.set("workspace_orders",values);
    }
  };
  const fullScanCalls=[];
  for(const method of ["listOperations","listOrdersInternal","listWorkspaceRecords"]){
    if(typeof runtime.repository[method]!=="function")continue;
    const original=runtime.repository[method].bind(runtime.repository);
    runtime.repository[method]=(...args)=>{fullScanCalls.push({method,args:args.slice(0,2)});return original(...args);};
  }
  const resources = [
    {name: "tickets", url: page => `/workspace/api/tickets?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "invoices", url: page => `/workspace/api/invoices?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "settlements", url: page => `/workspace/api/daily-settlements?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "wallet", url: page => `/workspace/api/wallets/${merchant.id}/history?kind=ledger&page=${page}&limit=${limit}`},
    {name: "audit", url: page => `/workspace/api/agents/${merchant.id}/activity?page=${page}&limit=${limit}`},
    {name: "orders", url: page => `/workspace/api/orders?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "withdrawals", url: page => `/workspace/api/withdrawals?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "refund-reconciliations", url: page => `/workspace/api/refund-reconciliations?status=all&page=${page}&limit=${limit}`},
    {name: "tasks", url: page => `/workspace/api/notifications/tasks?page=${page}&limit=${limit}`},
    {name: "customer-refunds", url: page => `/workspace/api/refunds/customer/pending?page=${page}&limit=${limit}`},
    {name: "price-adjustment-refunds", url: page => `/workspace/api/refunds/price-adjustments/pending?page=${page}&limit=${limit}`},
    {name: "action-center", url: () => "/workspace/api/action-center", actionCenter:true},
  ];
  const extraRequests=concurrentRequestTarget-resources.length*requestsPerResource;
  const requests = resources.flatMap((resource,resourceIndex) => Array.from({
    length: requestsPerResource+(resourceIndex<extraRequests?1:0),
  }, (_, index) => ({
    resource: resource.name, url: resource.url(index % 5 + 1), actionCenter:resource.actionCenter===true,
  })));
  const wallStarted = performance.now();
  const samples = await Promise.all(requests.map(async request => {
    const started = performance.now();
    const response = await app.inject({method: "GET", url: request.url, headers});
    const elapsedMs = performance.now() - started;
    const payload = response.json();
    const valid=request.actionCenter
      ? payload.data?.counts?.tasks===count&&payload.data?.counts?.refunds===count*2
        &&payload.data?.counts?.refundReviews===count&&payload.data?.counts?.withdrawals===count
      : Array.isArray(payload.data)&&payload.data.length<=limit&&payload.meta?.total===count;
    if (response.statusCode !== 200 || !valid) {
      throw new Error(`benchmark_response_invalid:${request.url}:${response.statusCode}:${response.body.slice(0, 300)}`);
    }
    return {resource: request.resource, elapsedMs, bytes: Buffer.byteLength(response.body)};
  }));
  const wallMs = performance.now() - wallStarted;
  const simpleRequests=requests.filter(request=>!request.actionCenter).length;
  const actionCenterRequests=requests.length-simpleRequests;
  const maximumExpectedQueries=simpleRequests+actionCenterRequests*16;
  if(queryCount<simpleRequests||queryCount>maximumExpectedQueries){
    throw new Error(`benchmark_query_count_invalid:${queryCount}:${simpleRequests}-${maximumExpectedQueries}`);
  }
  if(fullScanCalls.length)throw new Error(`benchmark_full_scan_detected:${JSON.stringify(fullScanCalls.slice(0,10))}`);
  const perResource=Object.fromEntries(resources.map(resource=>{
    const values=samples.filter(sample=>sample.resource===resource.name).map(sample=>sample.elapsedMs);
    return [resource.name,{p50:Number(percentile(values,.5).toFixed(2)),p95:Number(percentile(values,.95).toFixed(2))}];
  }));
  const queryLatency=Object.fromEntries([...queryDurations].map(([kind,values])=>[kind,{
    p50:Number(percentile(values,.5).toFixed(2)),p95:Number(percentile(values,.95).toFixed(2)),
  }]));
  return {
    rowsPerResource: count,
    concurrentRequests: requests.length,
    pageLimit: limit,
    queryCount,
    maximumExpectedQueries,
    forbiddenFullScanCalls:fullScanCalls.length,
    wallMs: Number(wallMs.toFixed(2)),
    latencyMs: {
      p50: Number(percentile(samples.map(sample => sample.elapsedMs), .5).toFixed(2)),
      p95: Number(percentile(samples.map(sample => sample.elapsedMs), .95).toFixed(2)),
      max: Number(Math.max(...samples.map(sample => sample.elapsedMs)).toFixed(2)),
    },
    responseBytes: {
      p50: percentile(samples.map(sample => sample.bytes), .5),
      max: Math.max(...samples.map(sample => sample.bytes)),
    },
    perResourceLatencyMs: perResource,
    databaseQueryLatencyMs: queryLatency,
    targetP95Under500ms: percentile(samples.map(sample => sample.elapsedMs), .95) < 500,
  };
  } finally {
    if (app) await app.close();
    runtime?.close();
    rmSync(folder, {recursive: true, force: true});
  }
}

const results = [];
for (const count of tiers) results.push(await runTier(count));
process.stdout.write(JSON.stringify({generatedAt: new Date().toISOString(), runtime: "local-sqlite-file-wal", results}, null, 2) + "\n");
if (results.some(result => !result.targetP95Under500ms)) process.exitCode = 1;
