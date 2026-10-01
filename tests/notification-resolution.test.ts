import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it,vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import type {Actor, Ticket} from "../src/operations/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("notification case resolution", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"});
  const admin: Actor = {id: "notification-admin", role: "platform_admin", merchantId: null};
  let runtime: Runtime;
  let tenant: TenantContext;

  beforeEach(() => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
  });

  afterEach(() => {vi.useRealTimers();runtime.close();});

  async function cancelledOrder(): Promise<{order: Order; taskId: string}> {
    const draft = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const order = runtime.payment.markPaid(tenant.merchantId, draft.id, {providerRef: "test:" + draft.id, receivedMinor: draft.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const queued = runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), {mode: "session", session: "test"});
    const cancelled = runtime.fulfillments.prepareRecovery(tenant.merchantId, queued.id, "retry", "明确取消");
    expect(cancelled.status).toBe("cancelled");
    return {order, taskId: queued.id};
  }

  it("does not create a manual review case for an explicitly cancelled fulfillment", async () => {
    await cancelledOrder();
    await runtime.notifications.tick();
    expect(runtime.notifications.tasksPage(admin, 1, 30).data).toHaveLength(0);
  });

  it("resolves legacy system cases without systemCase metadata when the order is clearly cancelled", async () => {
    const {order} = await cancelledOrder();
    const now = new Date();
    const legacy: Ticket = {id: "case_legacy_cancelled", merchantId: tenant.merchantId, orderId: order.id,
      category: "recharge", title: "充值结果尚未确认，请等待平台核对，不要重复下单", status: "in_progress",
      assigneeId: null, version: 1, publicVersion: 1, createdBy: "system", createdAt: now, updatedAt: now};
    runtime.repository.saveOperations("ticket", legacy, true);
    runtime.repository.saveOperations("service_checkpoint", {id:"legacy-system-cases-v2",merchantId:null,createdAt:now,afterId:null,completed:false});
    await runtime.notifications.tick();
    expect(runtime.repository.getOperations("ticket", legacy.id)?.status).toBe("resolved");
    expect(runtime.notifications.tasksPage(admin, 1, 30).data).toHaveLength(0);
  });

  it("classifies the ten-minute boundary as abnormal while keeping a newer task in normal processing",async()=>{
    vi.useFakeTimers();const now=new Date("2026-10-01T12:00:00.000Z");vi.setSystemTime(now);
    const make=async(suffix:string,ageMs:number)=>{
      const draft=await runtime.orders.create(tenant,{merchantOrderNo:`timeout-${suffix}`,productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
      const order=runtime.payment.markPaid(tenant.merchantId,draft.id,{providerRef:`test:${suffix}`,receivedMinor:draft.saleAmountMinor});
      const voucher=(await runtime.cdk.issueOne())!;
      const task=runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:`test-${suffix}`});
      runtime.repository.updateFulfillment({...task,createdAt:new Date(now.getTime()-ageMs)});
      return task;
    };
    const boundary=await make("boundary",600_000),normal=await make("normal",599_999);
    await runtime.notifications.tick();
    const tasks=runtime.notifications.tasksPage(admin,1,30).data;
    expect(tasks.map(item=>item.orderId)).toEqual([boundary.orderId]);
    expect(tasks.some(item=>item.orderId===normal.orderId)).toBe(false);
  });

  it("updates an existing timeout issue when the upstream later confirms a retryable failure",async()=>{
    vi.useFakeTimers();const now=new Date("2026-10-01T12:00:00.000Z");vi.setSystemTime(now);
    const draft=await runtime.orders.create(tenant,{merchantOrderNo:"timeout-to-retryable",productCode:"chatgpt_plus_cdk_1m",
      quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    const order=runtime.payment.markPaid(tenant.merchantId,draft.id,{providerRef:"timeout-to-retryable",receivedMinor:draft.saleAmountMinor});
    const voucher=(await runtime.cdk.issueOne())!;
    const task=runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"test"});
    runtime.repository.updateFulfillment({...task,createdAt:new Date(now.getTime()-600_000)});
    await runtime.notifications.tick();
    expect(runtime.notifications.tasksPage(admin).data[0]).toMatchObject({retryAllowed:false,message:"充值结果尚未确认，请等待平台核对，不要重复下单"});

    runtime.fulfillments.applyUpstreamEvent(task.id,{orderId:"supplier-failed",lookupToken:null,status:"failed_precharge",stage:"failed",
      accountEmail:null,quotedAmountMinor:null,currency:null,message:"凭据校验失败"});
    vi.advanceTimersByTime(10_001);await runtime.notifications.tick();
    expect(runtime.notifications.tasksPage(admin).data[0]).toMatchObject({retryAllowed:true,message:"充值已明确失败，请核对资料后在原订单重新提交"});
  });

  it("migrates historical system tickets in bounded pages and stops after completion",async()=>{
    runtime.close();
    const sqliteConfig=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    runtime=createRuntime(sqliteConfig);
    const merchant=runtime.repository.listMerchants()[0]!,now=new Date("2026-10-01T12:00:00.000Z");
    vi.useFakeTimers();vi.setSystemTime(now);
    for(let index=0;index<205;index++){
      const ticket:Ticket={id:`case_bulk_${String(index).padStart(3,"0")}`,merchantId:merchant.id,orderId:null,
        category:"recharge",title:"历史系统异常",status:"open",assigneeId:null,version:1,publicVersion:1,
        createdBy:"system",createdAt:now,updatedAt:now};
      runtime.repository.saveOperations("ticket",ticket,true);
    }
    runtime.repository.saveOperations("service_checkpoint", {id:"legacy-system-cases-v2",merchantId:null,createdAt:now,afterId:null,completed:false});
    const query=vi.spyOn(runtime.repository as unknown as {queryRecords:(...args:unknown[])=>unknown},"queryRecords");
    for(let pass=0;pass<3;pass++){await runtime.notifications.tick();vi.advanceTimersByTime(10_001);}
    expect(runtime.repository.getOperations("service_checkpoint","legacy-system-cases-v2")).toMatchObject({completed:true,afterId:null});
    expect(query.mock.calls.filter(call=>call[0]==="ticket").map(call=>(call[1] as {limit:number}).limit)).toEqual([100,100,100]);
    expect(runtime.repository.listOperations("ticket",merchant.id).every(item=>item.status==="resolved")).toBe(true);
    query.mockClear();
    await runtime.notifications.tick();
    expect(query.mock.calls.some(call=>call[0]==="ticket")).toBe(false);
  });
});
