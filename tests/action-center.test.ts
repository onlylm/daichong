import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {WorkerHealthReporter} from "../src/worker/worker-health.js";

describe("platform action center", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    await runtime.accounts.bootstrap("action-admin", "test-action-center-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    runtime.close();
  });

  it("returns executable operational queues to the platform administrator", async () => {
    const login = await loginPlatform(app, "action-admin", "test-action-center-password", "https://admin.tibo.ink");
    const response = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().data).toMatchObject({
      counts: {tasks: 0, refunds: 0, refundReviews: 0, settlements: 0, tickets: 0},
      tasks: [], refunds: [], refundReviews: [], settlements: [], tickets: [],
      worker: {status: "missing", failedLanes: [], stuckLanes: []},
    });

    new WorkerHealthReporter(runtime.repository, ["retail-payment"]).persist();
    const running = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(running.json().data.worker).toMatchObject({status: "healthy", failedLanes: [], stuckLanes: []});
  });

  it("queries only bounded pending queues and excludes system cases from agent tickets", async () => {
    const merchant = runtime.repository.listMerchants()[0]!, now = new Date();
    runtime.repository.saveOperations("ticket", {id: "tk_agent_pending", merchantId: merchant.id, orderId: null, title: "代理售后",
      category: "other", status: "open", assigneeId: null, version: 1, publicVersion: 1, createdBy: "agent-owner", createdAt: now, updatedAt: now}, true);
    runtime.repository.saveOperations("ticket", {id: "case_system_pending", merchantId: merchant.id, orderId: null, title: "系统异常",
      category: "recharge", status: "open", systemCase: {issueKey: "test", entityId: "missing-order"}, assigneeId: null,
      version: 1, publicVersion: 1, createdBy: "system", createdAt: now, updatedAt: now}, true);
    runtime.repository.saveOperations("operational_issue",{id:"issue_pending",merchantId:merchant.id,orderId:"missing-order",
      entityId:"missing-task",kind:"recharge",status:"open",severity:"urgent",reason:"充值任务已超时",retryAllowed:false,
      attentionKey:`0:${now.toISOString()}`,dueAt:now,firstDetectedAt:now,updatedAt:now,resolvedAt:null,legacyTicketIds:[]},true);
    runtime.repository.saveOperations("daily_settlement", {id: "ds_pending", merchantId: merchant.id, businessDate: "2026-10-01",
      periodFrom: now, periodTo: now, status: "pending_payment", orderIds: [], orderCount: 0, supplyAmountMinor: 0n,
      agentEarningsMinor: 100n, platformCostMinor: 0n, platformProfitMinor: 0n, payableMinor: 100n, currency: "CNY",
      payoutMethod: null, payoutReference: null, payoutEvidence: null, note: null, confirmedBy: null, version: 1,
      generatedAt: now, paidAt: null, reconciledAt: null, updatedAt: now}, true);
    runtime.repository.saveOperations("invoice_application", {id: "inv_pending", merchantId: merchant.id, orderId: "missing-order",
      requestKey: "invoice-action-center", titleType: "enterprise", invoiceTitle: "测试企业", taxIdEncrypted: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: now},
      recipientEmail: "invoice@example.com", contactName: "测试联系人", contactPhone: null, remark: null, invoiceAmountMinor: 10000n,
      feeRateBps: 500, feeAmountMinor: 500n, category: "技术服务费", status: "submitted", paymentId: "invpay_test",
      providerRef: "alipay-test", paidAt: now, submittedAt: now, reviewNote: null, invoiceNo: null, issuedAt: null,
      version: 1, createdBy: "agent-owner", createdAt: now, updatedAt: now}, true);
    runtime.repository.insertRefund({id: "rf_pending", merchantId: merchant.id, orderId: "missing-order", merchantRefundNo: "test-refund",
      type: "full", amountMinor: 100n, status: "requested", reason: "测试退款", failureCode: null, providerRefundNo: null,
      createdAt: now, refundedAt: null});
    runtime.repository.saveOperations("refund_reconciliation",{id:"refund-reconciliation:missing-order",merchantId:merchant.id,
      orderId:"missing-order",provider:"alipay_page",status:"reviewing",reportedMinor:500n,recordedMinor:100n,differenceMinor:400n,
      providerReferenceFingerprint:"0123456789abcdef0123456789abcdef",legacyTicketIds:[],version:1,firstDetectedAt:now,
      lastCheckedAt:now,resolvedAt:null},true);

    const login = await loginPlatform(app, "action-admin", "test-action-center-password", "https://admin.tibo.ink");
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const response = await app.inject({method: "GET", url: "/workspace/api/action-center", headers: {
      origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    }});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({counts: {tasks: 1, refunds: 1, refundReviews:1, settlements: 1, tickets: 1, invoices: 1},
      refundReviews:[{orderId:"missing-order",reportedAmount:"5.00",recordedAmount:"1.00",differenceAmount:"4.00",status:"reviewing"}]});
    expect(response.json().data.tickets.map((item: {id: string}) => item.id)).toEqual(["tk_agent_pending"]);
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["operational_issue","refund","refund_reconciliation", "daily_settlement", "ticket", "invoice_application"]));
  });

  it("uses the full server count when more than fifty abnormal records exist",async()=>{
    const merchant=runtime.repository.listMerchants()[0]!,now=new Date();
    for(let index=0;index<55;index++)runtime.repository.saveOperations("operational_issue",{id:`issue_${index}`,merchantId:merchant.id,
      orderId:`order_${index}`,entityId:`task_${index}`,kind:"recharge",status:"open",severity:index<2?"urgent":"normal",
      reason:"测试异常",retryAllowed:false,attentionKey:`${index<2?"0":"1"}:${new Date(now.getTime()+index).toISOString()}`,
      dueAt:now,firstDetectedAt:new Date(now.getTime()+index),updatedAt:now,resolvedAt:null,legacyTicketIds:[]},true);
    const actor=runtime.repository.listOperations("account").find(value=>value.role==="platform_admin")!;
    expect(runtime.notifications.tasksPage({id:actor.id,role:actor.role,merchantId:null},1,50).meta.total).toBe(55);
    const login=await loginPlatform(app,"action-admin","test-action-center-password","https://admin.tibo.ink");
    const response=await app.inject({method:"GET",url:"/workspace/api/action-center",headers:{origin:"https://admin.tibo.ink",
      cookie:String(login.headers["set-cookie"]).split(";")[0]!}});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().data.counts.tasks).toBe(55);
    expect(response.json().data.tasks).toHaveLength(4);
  });

  it("keeps healthy modules available when one action-center query fails",async()=>{
    const repository=runtime.repository as any,original=repository.queryRecords.bind(repository);
    vi.spyOn(repository,"queryRecords").mockImplementation(((kind:string,query:unknown)=>{
      if(kind==="refund")throw new Error("simulated refund storage failure");
      return original(kind,query);
    }) as any);
    const login=await loginPlatform(app,"action-admin","test-action-center-password","https://admin.tibo.ink");
    const response=await app.inject({method:"GET",url:"/workspace/api/action-center",headers:{origin:"https://admin.tibo.ink",
      cookie:String(login.headers["set-cookie"]).split(";")[0]!}});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({counts:{refunds:null,tasks:0,refundReviews:0},
      moduleStatus:{refunds:{available:false,error:"暂时无法读取"},tasks:{available:true,error:null}}});
  });
});
