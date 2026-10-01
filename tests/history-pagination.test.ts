import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("workspace history pagination", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: ":memory:", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    runtime = createRuntime(config);
    await runtime.accounts.bootstrap("history-admin", "test-history-password");
    const admin = runtime.repository.listOperations("account").find(value => value.role === "platform_admin")!;
    runtime.repository.saveOperations("account", {...admin, mustChangePassword: false});
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    runtime.close();
  });

  it("pages tickets, invoices and daily settlements in SQLite instead of loading full history", async () => {
    const merchant = runtime.repository.listMerchants()[0]!, base = Date.parse("2026-10-01T00:00:00.000Z");
    for (let index = 0; index < 13; index++) {
      const timestamp = new Date(base + index * 60_000);
      runtime.repository.saveOperations("ticket", {id: `tk_page_${index}`, merchantId: merchant.id, orderId: null,
        title: `分页工单 ${index}`, category: "other", status: index % 2 === 0 ? "open" : "resolved",
        assigneeId: null, version: 1, publicVersion: 1, createdBy: "agent-owner", createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("invoice_application", {id: `inv_page_${index}`, merchantId: merchant.id,
        orderId: `order_page_${index}`, requestKey: `invoice-page-${index}`, titleType: "enterprise",
        invoiceTitle: `分页企业 ${index}`, taxIdEncrypted: {ciphertext: null, iv: null, authTag: null, keyVersion: "test", clearedAt: timestamp},
        recipientEmail: `invoice-${index}@example.com`, contactName: "测试联系人", contactPhone: null, remark: null,
        invoiceAmountMinor: 10_000n, feeRateBps: 500, feeAmountMinor: 500n, category: "技术服务费",
        status: index % 2 === 0 ? "submitted" : "issued", paymentId: `invpay_${index}`, providerRef: `alipay-${index}`,
        paidAt: timestamp, submittedAt: timestamp, reviewNote: null, invoiceNo: null, issuedAt: index % 2 ? timestamp : null,
        version: 1, createdBy: "agent-owner", createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("daily_settlement", {id: `ds_page_${index}`, merchantId: merchant.id,
        businessDate: `2026-09-${String(index + 1).padStart(2, "0")}`, periodFrom: timestamp, periodTo: timestamp,
        status: index % 2 === 0 ? "pending_payment" : "reconciled", orderIds: [], orderCount: 0,
        supplyAmountMinor: 0n, agentEarningsMinor: 100n, platformCostMinor: 0n, platformProfitMinor: 0n,
        payableMinor: 100n, currency: "CNY", payoutMethod: null, payoutReference: null, payoutEvidence: null,
        note: null, confirmedBy: null, version: 1, generatedAt: timestamp, paidAt: null,
        reconciledAt: index % 2 ? timestamp : null, updatedAt: timestamp}, true);
      runtime.repository.appendAudit({id: `aud_page_${index}`, merchantId: merchant.id, actorType: "platform_user",
        actorId: "history-admin", action: "history.pagination.test", targetType: "merchant", targetId: merchant.id,
        requestId: `request-page-${index}`, createdAt: timestamp});
    }
    runtime.repository.saveOperations("ticket", {id: "tk_archived", merchantId: merchant.id, orderId: null,
      title: "已归档工单", category: "other", status: "open", archivedAt: new Date(), archiveReason: "测试清理",
      archivedBy: "history-admin", assigneeId: null, version: 1, publicVersion: 1, createdBy: "system",
      createdAt: new Date(), updatedAt: new Date()}, true);

    const login = await loginPlatform(app, "history-admin", "test-history-password", "https://admin.tibo.ink");
    const headers = {origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!};
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const [tickets, invoices, settlements, activity] = await Promise.all([
      app.inject({method: "GET", url: `/workspace/api/tickets?merchantId=${merchant.id}&status=open&page=2&limit=3`, headers}),
      app.inject({method: "GET", url: `/workspace/api/invoices?merchantId=${merchant.id}&status=submitted&page=2&limit=3`, headers}),
      app.inject({method: "GET", url: `/workspace/api/daily-settlements?merchantId=${merchant.id}&status=pending_payment&page=2&limit=3`, headers}),
      app.inject({method: "GET", url: `/workspace/api/agents/${merchant.id}/activity?page=2&limit=3`, headers}),
    ]);

    expect([tickets.statusCode, invoices.statusCode, settlements.statusCode, activity.statusCode]).toEqual([200, 200, 200, 200]);
    expect(tickets.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(invoices.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(settlements.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(activity.json()).toMatchObject({meta: {total: 13, page: 2, limit: 3, pages: 5}});
    expect(tickets.json().data).toHaveLength(3);
    expect(tickets.json().data.every((item: {status: string; merchantId: string}) => item.status === "open" && item.merchantId === merchant.id)).toBe(true);
    expect(tickets.json().data.some((item: {id: string}) => item.id === "tk_archived")).toBe(false);
    expect(invoices.json().data.every((item: {status: string}) => item.status === "submitted")).toBe(true);
    expect(settlements.json().data.every((item: {status: string}) => item.status === "pending_payment")).toBe(true);
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["ticket", "invoice_application", "daily_settlement", "audit"]));
    expect(query.mock.calls.every(call => (call[1] as {limit: number}).limit === 3)).toBe(true);
  });

  it("keeps order polling lightweight and loads the selected order audit only on demand", async () => {
    publishTestRechargeProduct(runtime);
    const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    const tenant = {merchantId: credential.merchant.id, appId: credential.app.id, keyId: credential.key.keyId,
      partnerId: credential.merchant.partnerId};
    const order = await runtime.orders.create(tenant, {merchantOrderNo: "AUDIT-LAZY-ORDER", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00"});
    const base = Date.parse("2026-10-01T10:00:00.000Z");
    for (let index = 0; index < 45; index++) runtime.repository.appendAudit({id: `order_audit_${String(index).padStart(2, "0")}`,
      merchantId: order.merchantId, actorType: "platform_user", actorId: "history-admin", action: `order.audit.${index}`,
      targetType: "order", targetId: order.id, requestId: `order-audit-request-${index}`, createdAt: new Date(base + index * 1_000)});
    for (let index = 0; index < 8; index++) runtime.repository.appendAudit({id: `unrelated_audit_${index}`,
      merchantId: order.merchantId, actorType: "platform_user", actorId: "history-admin", action: "order.audit.unrelated",
      targetType: "order", targetId: `other-order-${index}`, requestId: `unrelated-request-${index}`, createdAt: new Date(base)});

    const login = await loginPlatform(app, "history-admin", "test-history-password", "https://admin.tibo.ink");
    const headers = {origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!};
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const fullAudit = vi.spyOn(runtime.repository, "listAudit");
    const detail = await app.inject({method: "GET", url: `/workspace/api/orders/${order.id}`, headers});
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).not.toHaveProperty("audit");
    expect(fullAudit).not.toHaveBeenCalled();

    const audit = await app.inject({method: "GET", url: `/workspace/api/orders/${order.id}/audit?page=2&limit=20`, headers});
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({meta: {total: 45, page: 2, limit: 20, pages: 3}});
    expect(audit.json().data).toHaveLength(20);
    expect(audit.json().data.every((item: {targetId: string}) => item.targetId === order.id)).toBe(true);
    expect(query).toHaveBeenCalledWith("audit", expect.objectContaining({merchantId: order.merchantId, page: 2, limit: 20}));
    expect(fullAudit).not.toHaveBeenCalled();
  });

  it("loads only the selected ticket conversation and preserves internal-note visibility", () => {
    const merchant=runtime.repository.listMerchants()[0]!,base=Date.parse("2026-10-01T09:00:00.000Z");
    for(const [offset,ticketId] of [[0,"tk_detail_target"],[1,"tk_detail_other"]] as const){
      const at=new Date(base+offset*60_000);
      runtime.repository.saveOperations("ticket",{id:ticketId,merchantId:merchant.id,orderId:null,title:"详情查询",category:"other",status:"open",
        assigneeId:null,version:3,publicVersion:2,createdBy:"agent-owner",createdAt:at,updatedAt:at},true);
      for(let index=0;index<4;index++)runtime.repository.saveOperations("ticket_message",{id:`${ticketId}_message_${index}`,merchantId:merchant.id,
        ticketId,actorId:index===2?"history-admin":"agent-owner",author:index===2?"platform":"agent",internal:index===2,
        body:`${ticketId}-${index}`,createdAt:new Date(at.getTime()+index*1_000)},true);
    }
    const allOperations=vi.spyOn(runtime.repository,"listOperations"),exact=vi.spyOn(runtime.repository as unknown as {listTicketMessages:(...args:unknown[])=>unknown},"listTicketMessages");
    const platform=runtime.support.get({id:"history-admin",role:"platform_admin",merchantId:null},"tk_detail_target");
    const agent=runtime.support.get({id:"agent-owner",role:"agent_owner",merchantId:merchant.id},"tk_detail_target");
    expect(platform.messages.map(item=>item.body)).toEqual(["tk_detail_target-0","tk_detail_target-1","tk_detail_target-2","tk_detail_target-3"]);
    expect(agent.messages.map(item=>item.body)).toEqual(["tk_detail_target-0","tk_detail_target-1","tk_detail_target-3"]);
    expect(exact).toHaveBeenCalledTimes(2);
    expect(allOperations).not.toHaveBeenCalled();
  });

  it("loads only the selected wallet history tab and keeps the balance endpoint compact", async () => {
    const merchant = runtime.repository.listMerchants()[0]!, base = Date.parse("2026-10-01T08:00:00.000Z");
    for (let index = 0; index < 7; index++) {
      const timestamp = new Date(base + index * 60_000);
      runtime.repository.saveOperations("wallet_deposit", {id: `wdep_page_${index}`, merchantId: merchant.id,
        amountMinor: BigInt((index + 1) * 100), status: "credited", requestKey: `deposit-page-${index}`,
        payerReference: "支付宝在线充值", verifiedReference: `alipay-page-${index}`, reviewerId: "payment:alipay",
        paymentProvider: "alipay_page", paymentConfigId: null, providerRef: `provider-${index}`,
        expiresAt: null, paidAt: timestamp, nextCheckAt: null, createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("wallet_withdrawal", {id: `wwd_page_${index}`, merchantId: merchant.id,
        amountMinor: BigInt((index + 1) * 50), status: "requested", requestKey: `withdraw-page-${index}`,
        requestedBy: "agent-owner", reviewerId: null, payoutReference: null, reason: "分页测试",
        payoutMethod: "alipay", payoutAccount: "agent@example.com", payoutName: "测试代理",
        createdAt: timestamp, updatedAt: timestamp}, true);
      runtime.repository.saveOperations("wallet_entry", {id: `went_page_${index}`, merchantId: merchant.id, kind: "deposit",
        procurementDelta: BigInt((index + 1) * 100), earningsDelta: 0n, frozenDelta: 0n,
        reference: `wallet-page-${index}`, actorId: "payment:alipay", createdAt: timestamp}, true);
    }

    const login = await loginPlatform(app, "history-admin", "test-history-password", "https://admin.tibo.ink");
    const headers = {origin: "https://admin.tibo.ink", cookie: String(login.headers["set-cookie"]).split(";")[0]!};
    const query = vi.spyOn(runtime.repository as unknown as {queryRecords: (...args: unknown[]) => unknown}, "queryRecords");
    const summary = await app.inject({method: "GET", url: `/workspace/api/wallets/${merchant.id}`, headers});
    const deposits = await app.inject({method: "GET", url: `/workspace/api/wallets/${merchant.id}/history?kind=deposits&page=2&limit=3`, headers});
    const withdrawals = await app.inject({method: "GET", url: `/workspace/api/wallets/${merchant.id}/history?kind=withdrawals&page=1&limit=2`, headers});
    const globalWithdrawals = await app.inject({method: "GET", url: "/workspace/api/withdrawals?status=actionable&page=2&limit=3", headers});
    const ledger = await app.inject({method: "GET", url: `/workspace/api/wallets/${merchant.id}/history?kind=ledger&page=1&limit=2`, headers});

    expect([summary.statusCode, deposits.statusCode, withdrawals.statusCode, globalWithdrawals.statusCode, ledger.statusCode]).toEqual([200, 200, 200, 200, 200]);
    expect(summary.json()).toHaveProperty("data.procurementAvailable");
    expect(summary.json()).not.toHaveProperty("entries");
    expect(summary.json()).not.toHaveProperty("deposits");
    expect(summary.json()).not.toHaveProperty("withdrawals");
    expect(deposits.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(deposits.json().data).toHaveLength(3);
    expect(withdrawals.json()).toMatchObject({meta: {total: 7, page: 1, limit: 2, pages: 4}});
    expect(globalWithdrawals.json()).toMatchObject({meta: {total: 7, page: 2, limit: 3, pages: 3}});
    expect(globalWithdrawals.json().data[0]).toMatchObject({merchantId: merchant.id, merchantName: merchant.name, amount: expect.any(String), status: "requested"});
    expect(ledger.json().data[0]).toMatchObject({procurementDelta: "7.00", earningsDelta: "0.00", frozenDelta: "0.00"});
    expect(query.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(["wallet_deposit", "wallet_withdrawal", "wallet_entry"]));
  });

  it("pages and searches cost accounting records before loading their finance details", async () => {
    publishTestRechargeProduct(runtime);
    const credential=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const tenant={merchantId:credential.merchant.id,appId:credential.app.id,keyId:credential.key.keyId,partnerId:credential.merchant.partnerId};
    const admin={id:"history-admin",role:"platform_admin" as const,merchantId:null};
    for(let index=0;index<7;index++){
      const order=await runtime.orders.create(tenant,{merchantOrderNo:`COST-PAGE-${index}`,productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      runtime.payment.markPaid(order.merchantId,order.id,{providerRef:`cost-page-payment-${index}`,receivedMinor:order.saleAmountMinor});
      const voucher=(await runtime.cdk.issueOne())!;
      const task=runtime.fulfillments.createCdkPublic(runtime.repository.findOrderInternal(order.id)!,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:`cost-page-session-${index}`});
      runtime.repository.updateFulfillment({...runtime.repository.findFulfillment(order.merchantId,task.id)!,status:"succeeded",upstreamProvider:"configured_supplier",upstreamOrderId:`upstream-cost-${index}`,finishedAt:new Date()});
      if(index%2===1)runtime.costs.verify(admin,order.id,{version:0,actualUsd:"15.00",feesUsd:"0.00",retainedUsd:"0.15",fxRate:"7",
        sourceReference:`settled-cost-page-${index}`,evidence:"已核实测试清算和订单关联",confirmEvidence:true,destination:"platform_pass_through"});
    }
    const login=await loginPlatform(app,"history-admin","test-history-password","https://admin.tibo.ink");
    const headers={origin:"https://admin.tibo.ink",cookie:String(login.headers["set-cookie"]).split(";")[0]!};
    const query=vi.spyOn(runtime.repository as unknown as {queryCostAccountingOrders:(...args:unknown[])=>unknown},"queryCostAccountingOrders");
    const pending=await app.inject({method:"GET",url:"/workspace/api/finance/costs?status=pending_review&page=2&limit=2",headers});
    const search=await app.inject({method:"GET",url:"/workspace/api/finance/costs?search=COST-PAGE-3&page=1&limit=20",headers});

    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({meta:{total:4,page:2,limit:2,pages:2}});
    expect(pending.json().data).toHaveLength(2);
    expect(pending.json().data.every((item:{status:string})=>item.status==="pending_review")).toBe(true);
    expect(search.json()).toMatchObject({meta:{total:1,page:1,limit:20,pages:1}});
    expect(search.json().data[0]).toMatchObject({status:"confirmed",merchantName:credential.merchant.name});
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toMatchObject({status:"pending_review",page:2,limit:2});
  });
});
