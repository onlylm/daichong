import {randomUUID} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {AlipayPagePaymentProvider, AlipayPaymentService, type AlipayClient} from "../src/modules/alipay-payment.js";
import {RefundService} from "../src/modules/refund-service.js";
import type {Order, TenantContext} from "../src/domain/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";

describe("Alipay payment reconciliation", () => {
  const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent",
    PUBLIC_BASE_URL: "https://tibo.ink", ADMIN_BASE_URL: "https://admin.tibo.ink"});
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tenant: TenantContext;

  beforeEach(async () => {
    runtime = createRuntime(config);
    publishTestRechargeProduct(runtime);
    const bundle = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
    tenant = {merchantId: bundle.merchant.id, partnerId: bundle.merchant.partnerId, appId: bundle.app.id, keyId: bundle.key.keyId};
    app = await buildApp(config, runtime);
  });

  afterEach(async () => {
    await app.close();
    runtime.close();
  });

  async function orderWithAlipayAttempt(): Promise<Order> {
    const order = await runtime.orders.create(tenant, {merchantOrderNo: randomUUID(), productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", deliveryMode: "auto_recharge"});
    const attempt = runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page", providerRef: order.id, qrPayload: null,
      updatedAt: new Date()});
    return order;
  }

  function service(result: Record<string, string>): AlipayPaymentService {
    const client = {
      exec: vi.fn(async () => result),
      pageExecute: vi.fn(async () => ""),
      checkNotifySignV2: vi.fn(() => true),
    } as unknown as AlipayClient;
    const paymentProvider = new AlipayPagePaymentProvider(config.publicBaseUrl, runtime.portalTokens);
    const value = new AlipayPaymentService(runtime.repository, runtime.payment, client,
      {appId: "test-app", sellerId: "2088000000000000"}, config.publicBaseUrl, paymentProvider);
    value.setExternalRefundHandler((orderId, amount, reference) => runtime.refunds.syncProviderRefund(orderId, amount, reference));
    return value;
  }

  it("holds an aggregate provider-side refund for exact-reference review instead of guessing its type", async () => {
    const created = await orderWithAlipayAttempt();
    const tradeNo = "2026100100000001";
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {channel: "alipay_page", providerRef: tradeNo, receivedMinor: created.saleAmountMinor});
    const voucher = (await runtime.cdk.issueOne())!;
    const token = new URL(paid.fulfillmentUrl).searchParams.get("token")!;
    const alipay = service({code: "10000", out_trade_no: paid.id, total_amount: "135.00", trade_no: tradeNo,
      trade_status: "TRADE_SUCCESS", refund_amount: "135.00", seller_id: "2088000000000000", app_id: "test-app"});

    await alipay.reconcile(paid.id);
    const unchanged = runtime.repository.findOrderInternal(paid.id)!;
    expect(unchanged.paymentStatus).toBe("paid");
    expect(unchanged.ordinaryRefundedMinor).toBe(0n);
    expect(runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)).toMatchObject({status: "paid"});
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)).toMatchObject({id: voucher.id, status: "unused"});
    const heldPage=await app.inject({url: `/recharge/${paid.id}?token=${encodeURIComponent(token)}`});
    expect(heldPage.statusCode).toBe(200);
    expect(heldPage.body).toContain("支付宝退款差异正在核对");
    const heldPreview=await app.inject({method:"POST",url:"/public/cdk/preview",payload:{code:voucher.publicCode}});
    expect(heldPreview.statusCode).toBe(409);
    expect(heldPreview.json().error.code).toBe("recharge_result_unconfirmed");
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toHaveLength(0);
    const discrepancy=runtime.repository.getOperations("refund_reconciliation",refundReconciliationId(paid.id))!;
    expect(discrepancy).toMatchObject({status:"reviewing",reportedMinor:13_500n,recordedMinor:0n,differenceMinor:13_500n});
    expect(runtime.repository.listOperations("ticket",paid.merchantId)
      .filter(item=>item.systemCase?.issueKey.startsWith("refund-reconcile:"))).toHaveLength(0);

    expect((await app.inject({method:"POST",url:"/public/cdk/preview",payload:{code:voucher.publicCode}})).statusCode).toBe(409);
    runtime.refunds.syncProviderRefund(paid.id,paid.saleAmountMinor,`alipay-query:${tradeNo}:135.00`);
    expect(runtime.repository.getOperations("refund_reconciliation",discrepancy.id)?.status).toBe("reviewing");

    await alipay.reconcile(paid.id);
    expect(runtime.repository.listOperations("refund_reconciliation",paid.merchantId)).toHaveLength(1);
  });

  it("closes an unpaid order when Alipay reports TRADE_CLOSED without requiring a trade number", async () => {
    const order = await orderWithAlipayAttempt();
    const alipay = service({code: "10000", out_trade_no: order.id, total_amount: "135.00",
      trade_status: "TRADE_CLOSED", seller_id: "2088000000000000", app_id: "test-app"});

    await alipay.reconcile(order.id);
    expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("closed");
    expect(runtime.repository.findPaymentAttemptByOrder(order.merchantId, order.id)?.status).toBe("closed");
  });

  it("migrates legacy refund system cases without deleting their messages", async()=>{
    const created=await orderWithAlipayAttempt(),paid=runtime.payment.markPaid(created.merchantId,created.id,
      {channel:"alipay_page",providerRef:"2026100100000099",receivedMinor:created.saleAmountMinor}),now=new Date();
    const ticketId="case_legacy_refund_review";
    runtime.repository.saveOperations("ticket",{id:ticketId,merchantId:paid.merchantId,orderId:paid.id,category:"refund",
      title:"旧退款差异工单",status:"in_progress",assigneeId:null,version:1,publicVersion:1,createdBy:"system",
      systemCase:{issueKey:`refund-reconcile:${paid.id}:1000`,entityId:`provider-refund:${paid.id}`},priority:"urgent",
      dueAt:new Date(now.getTime()+30_000),createdAt:now,updatedAt:now},true);
    runtime.repository.saveOperations("ticket_message",{id:"legacy-refund-message",merchantId:paid.merchantId,ticketId,
      actorId:"system",author:"platform",internal:false,body:"原有沟通记录必须保留",createdAt:now},true);

    runtime.refundReconciliations.observe({merchantId:paid.merchantId,orderId:paid.id,reportedMinor:1_000n,recordedMinor:0n,
      providerReference:"alipay-query:legacy:10.00"});

    expect(runtime.repository.getOperations("ticket",ticketId)?.status).toBe("resolved");
    const messages=runtime.repository.listOperations("ticket_message",paid.merchantId).filter(item=>item.ticketId===ticketId);
    expect(messages.map(item=>item.body)).toContain("原有沟通记录必须保留");
    expect(messages.some(item=>item.internal&&item.body.includes("独立财务核对记录"))).toBe(true);
    expect(runtime.repository.getOperations("refund_reconciliation",refundReconciliationId(paid.id)))
      .toMatchObject({status:"reviewing",legacyTicketIds:[ticketId]});
  });

  it("deduplicates cumulative discrepancy cases without creating financial entries", async () => {
    const created = await orderWithAlipayAttempt();
    const tradeNo = "2026100100000002";
    const paid = runtime.payment.markPaid(created.merchantId, created.id,
      {channel: "alipay_page", providerRef: tradeNo, receivedMinor: created.saleAmountMinor});
    await runtime.cdk.issueOne();
    const token = new URL(paid.fulfillmentUrl).searchParams.get("token")!;
    const result = (refundAmount: string) => ({code: "10000", out_trade_no: paid.id, total_amount: "135.00", trade_no: tradeNo,
      trade_status: "TRADE_SUCCESS", refund_amount: refundAmount, seller_id: "2088000000000000", app_id: "test-app"});

    await service(result("10.00")).reconcile(paid.id);
    expect(runtime.repository.findOrderInternal(paid.id)).toMatchObject({paymentStatus: "paid", ordinaryRefundedMinor: 0n});
    expect(runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)?.status).toBe("paid");
    const heldPage=await app.inject({url: `/recharge/${paid.id}?token=${encodeURIComponent(token)}`});
    expect(heldPage.statusCode).toBe(200);
    expect(heldPage.body).toContain("支付宝退款差异正在核对");

    const firstAttempt = runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)!;
    runtime.repository.updatePaymentAttempt({...firstAttempt, nextCheckAt: new Date(0)});
    await service(result("25.00")).reconcile(paid.id);
    expect(runtime.repository.findOrderInternal(paid.id)?.ordinaryRefundedMinor).toBe(0n);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toEqual([]);

    const secondAttempt = runtime.repository.findPaymentAttemptByOrder(paid.merchantId, paid.id)!;
    runtime.repository.updatePaymentAttempt({...secondAttempt, nextCheckAt: new Date(0)});
    await service(result("25.00")).reconcile(paid.id);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId, paid.id)).toHaveLength(0);
    const cases=runtime.repository.listOperations("refund_reconciliation",paid.merchantId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({status:"reviewing",reportedMinor:2_500n,recordedMinor:0n,differenceMinor:2_500n});
    const events=runtime.repository.listOperations("refund_reconciliation_event",paid.merchantId)
      .filter(item=>item.orderId===paid.id);
    expect(events.map(item=>item.action)).toEqual(["detected","amount_updated"]);
  });

  it("re-reads local totals inside the transaction when manual posting interleaves with worker reconciliation", async () => {
    const created=await orderWithAlipayAttempt(),tradeNo="2026100100000003";
    const paid=runtime.payment.markPaid(created.merchantId,created.id,
      {channel:"alipay_page",providerRef:tradeNo,receivedMinor:created.saleAmountMinor});
    const repository=runtime.repository,transaction=repository.transaction.bind(repository);
    let injected=false;
    const transactionSpy=vi.spyOn(repository,"transaction").mockImplementation(action=>{
      if(!injected){
        injected=true;
        runtime.refunds.recordExternalCustomerRefund({id:"finance",role:"platform_finance",merchantId:null},paid.id,{
          amount:"20.00",reason:"支付宝已退款，人工补登",requestKey:"manual-refund-interleave",
          providerRefundNo:"2026100100000301",confirmAlreadyRefundedAtChannel:true,
        });
      }
      return transaction(action);
    });

    runtime.refunds.syncProviderRefund(paid.id,2_000n,`alipay-query:${tradeNo}:20.00`);
    transactionSpy.mockRestore();
    const order=runtime.repository.findOrderInternal(paid.id)!;
    expect(order.ordinaryRefundedMinor).toBe(2_000n);
    expect(order.priceAdjustmentRefundedMinor).toBe(0n);
    expect(runtime.repository.listRefundsForOrder(paid.merchantId,paid.id)).toHaveLength(1);
    expect(runtime.repository.getOperations("refund_reconciliation",refundReconciliationId(paid.id))).toBeNull();
  });

  it("serializes the same manual-versus-worker interleave on the SQLite repository", async () => {
    const sqliteConfig=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent",
      PUBLIC_BASE_URL:"https://tibo.ink",ADMIN_BASE_URL:"https://admin.tibo.ink"});
    const sqlite=createRuntime(sqliteConfig);
    try{
      publishTestRechargeProduct(sqlite);
      const bundle=sqlite.repository.findCredential(sqliteConfig.demoPartnerId,sqliteConfig.demoKeyId)!;
      const sqliteTenant={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
      const created=await sqlite.orders.create(sqliteTenant,{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
      const attempt=sqlite.repository.findPaymentAttemptByOrder(created.merchantId,created.id)!;
      sqlite.repository.updatePaymentAttempt({...attempt,provider:"alipay_page",providerRef:created.id,qrPayload:null,updatedAt:new Date()});
      const paid=sqlite.payment.markPaid(created.merchantId,created.id,
        {channel:"alipay_page",providerRef:"2026100100000007",receivedMinor:created.saleAmountMinor});
      const repository=sqlite.repository,transaction=repository.transaction.bind(repository);
      let injected=false;
      const transactionSpy=vi.spyOn(repository,"transaction").mockImplementation(action=>{
        if(!injected){
          injected=true;
          sqlite.refunds.recordExternalCustomerRefund({id:"finance",role:"platform_finance",merchantId:null},paid.id,{
            amount:"20.00",reason:"支付宝已退款，人工补登",requestKey:"sqlite-manual-refund-interleave",
            providerRefundNo:"2026100100000701",confirmAlreadyRefundedAtChannel:true,
          });
        }
        return transaction(action);
      });

      sqlite.refunds.syncProviderRefund(paid.id,2_000n,"alipay-query:2026100100000007:20.00");
      transactionSpy.mockRestore();
      expect(sqlite.repository.findOrderInternal(paid.id)).toMatchObject({ordinaryRefundedMinor:2_000n,priceAdjustmentRefundedMinor:0n});
      expect(sqlite.repository.listRefundsForOrder(paid.merchantId,paid.id)).toHaveLength(1);
      expect(sqlite.repository.getOperations("refund_reconciliation",refundReconciliationId(paid.id))).toBeNull();
    }finally{sqlite.close();}
  });

  it("does not dispatch a queued recharge while provider refund facts are under review", async () => {
    const created=await orderWithAlipayAttempt(),tradeNo="2026100100000005";
    const paid=runtime.payment.markPaid(created.merchantId,created.id,
      {channel:"alipay_page",providerRef:tradeNo,receivedMinor:created.saleAmountMinor});
    const voucher=(await runtime.cdk.issueOne())!;
    const queued=runtime.fulfillments.createCdkPublic(paid,voucher,runtime.cdk.readUpstreamCode(voucher),
      {mode:"session",session:"test-session"});

    runtime.refunds.syncProviderRefund(paid.id,1_000n,`alipay-query:${tradeNo}:10.00`);
    expect(await runtime.fulfillments.processOne()).toBeNull();
    expect(runtime.repository.findFulfillment(paid.merchantId,queued.id)).toMatchObject({status:"queued"});
  });

  it("does not issue a new upstream CDK while provider refund facts are under review", async () => {
    const created=await orderWithAlipayAttempt(),tradeNo="2026100100000006";
    const paid=runtime.payment.markPaid(created.merchantId,created.id,
      {channel:"alipay_page",providerRef:tradeNo,receivedMinor:created.saleAmountMinor});

    runtime.refunds.syncProviderRefund(paid.id,1_000n,`alipay-query:${tradeNo}:10.00`);
    expect(await runtime.cdk.issueOne()).toBeNull();
    expect(runtime.repository.findCdkVoucherByOrder(paid.id)).toBeNull();
  });

  it("never completes a same-amount refund of another type without an exact request number", async () => {
    const created=await orderWithAlipayAttempt(),tradeNo="2026100100000004";
    const paid=runtime.payment.markPaid(created.merchantId,created.id,
      {channel:"alipay_page",providerRef:tradeNo,receivedMinor:created.saleAmountMinor});
    const voucher=(await runtime.cdk.issueOne())!;
    const finance={id:"finance",role:"platform_finance" as const,merchantId:null};
    const adjustment=runtime.refunds.requestPriceAdjustment(finance,paid.id,
      {amount:"10.00",reason:"上游成本补差",requestKey:"same-amount-different-type"});
    const providerReference=`alipay-query:${tradeNo}:10.00`;

    expect(runtime.refunds.syncProviderRefund(paid.id,1_000n,providerReference)).toBeNull();
    expect(runtime.repository.findRefund(paid.merchantId,adjustment.id)).toMatchObject({status:"requested",type:"price_adjustment"});
    expect(runtime.repository.findOrderInternal(paid.id)).toMatchObject({ordinaryRefundedMinor:0n,priceAdjustmentRefundedMinor:0n});
    const issue=runtime.repository.getOperations("refund_reconciliation",refundReconciliationId(paid.id))!;
    expect(issue).toMatchObject({status:"reviewing",reportedMinor:1_000n,recordedMinor:0n,differenceMinor:1_000n});
    expect((await app.inject({method:"POST",url:"/public/cdk/preview",payload:{code:voucher.publicCode}})).statusCode).toBe(410);
    expect(issue.providerReferenceFingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(issue,(_key,value)=>typeof value==="bigint"?value.toString():value)).not.toContain(providerReference);

    const mismatched=service({code:"10000",refund_status:"REFUND_SUCCESS",out_trade_no:paid.id,
      out_request_no:"another-refund-request",refund_amount:"10.00",total_amount:"135.00",trade_no:tradeNo});
    await expect(mismatched.queryRefund(paid.id,adjustment.id,1_000n)).rejects.toMatchObject({code:"refund_binding_mismatch"});
    expect(runtime.repository.findRefund(paid.merchantId,adjustment.id)?.status).toBe("requested");

    const exactQuery=service({code:"10000",refund_status:"REFUND_SUCCESS",out_trade_no:paid.id,
      out_request_no:adjustment.id,refund_amount:"10.00",total_amount:"135.00",trade_no:tradeNo});
    const exactRefunds=new RefundService(runtime.repository,runtime.ledger,runtime.webhooks,{
      providerFor:()=>"alipay_page",
      execute:vi.fn().mockRejectedValue(new Error("result unknown")),
      query:(orderId,refund)=>exactQuery.queryRefund(orderId,refund.id,refund.amountMinor),
    },undefined,{
      discrepancy:input=>runtime.refundReconciliations.observe(input),
      recorded:input=>runtime.refundReconciliations.recorded(input),
    });
    expect(await exactRefunds.approve(finance,adjustment.id)).toMatchObject({status:"processing"});
    const processing=runtime.repository.findRefund(paid.merchantId,adjustment.id)!;
    runtime.repository.updateRefund({...processing,nextCheckAt:new Date(0)});
    await exactRefunds.reconcileOne();
    expect(runtime.repository.findRefund(paid.merchantId,adjustment.id)).toMatchObject({status:"succeeded",type:"price_adjustment"});
    expect(runtime.repository.findOrderInternal(paid.id)).toMatchObject({ordinaryRefundedMinor:0n,priceAdjustmentRefundedMinor:1_000n});
    expect(runtime.repository.getOperations("refund_reconciliation",issue.id)?.status).toBe("resolved");
    expect((await app.inject({method:"POST",url:"/public/cdk/preview",payload:{code:voucher.publicCode}})).statusCode).toBe(200);
  });
});
