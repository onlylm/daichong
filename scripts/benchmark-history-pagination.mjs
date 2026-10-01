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
const requestsPerResource = 8;

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
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  runtime.repository.transaction(() => {
    for (let index = 0; index < count; index++) {
      const suffix = String(index).padStart(6, "0");
      const timestamp = new Date(base + index * 1_000);
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
  const resources = [
    {name: "tickets", url: page => `/workspace/api/tickets?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "invoices", url: page => `/workspace/api/invoices?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "settlements", url: page => `/workspace/api/daily-settlements?merchantId=${merchant.id}&status=all&page=${page}&limit=${limit}`},
    {name: "wallet", url: page => `/workspace/api/wallets/${merchant.id}/history?kind=ledger&page=${page}&limit=${limit}`},
    {name: "audit", url: page => `/workspace/api/agents/${merchant.id}/activity?page=${page}&limit=${limit}`},
  ];
  const requests = resources.flatMap(resource => Array.from({length: requestsPerResource}, (_, index) => ({
    resource: resource.name, url: resource.url(index % 5 + 1),
  })));
  const wallStarted = performance.now();
  const samples = await Promise.all(requests.map(async request => {
    const started = performance.now();
    const response = await app.inject({method: "GET", url: request.url, headers});
    const elapsedMs = performance.now() - started;
    const payload = response.json();
    if (response.statusCode !== 200 || !Array.isArray(payload.data) || payload.data.length > limit || payload.meta?.total !== count) {
      throw new Error(`benchmark_response_invalid:${request.url}:${response.statusCode}:${response.body.slice(0, 300)}`);
    }
    return {resource: request.resource, elapsedMs, bytes: Buffer.byteLength(response.body)};
  }));
  const wallMs = performance.now() - wallStarted;
  if (queryCount !== requests.length) throw new Error(`benchmark_query_count_invalid:${queryCount}:${requests.length}`);
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
