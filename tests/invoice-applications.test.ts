import {afterEach, beforeEach, describe, expect, it,vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor, InvoiceFeePayment} from "../src/operations/model.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";

const admin: Actor = {id: "admin", role: "platform_admin", merchantId: null};

describe("order invoice applications", () => {
  let runtime: Runtime;
  let owner: Actor;
  let orderId: string;

  beforeEach(async () => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    owner = {id: "owner", role: "agent_owner", merchantId: credential.merchant.id};
    const order = await runtime.orders.create({merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.appId, keyId: credential.key.keyId}, {merchantOrderNo: "invoice-order", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    runtime.repository.updateOrder({...order, paymentStatus: "paid", paidAt: new Date(), paymentReceivedMinor: order.saleAmountMinor,
      paymentProviderRef: "ali-order-paid", updatedAt: new Date()});
    orderId = order.id;
  });

  afterEach(() => {vi.restoreAllMocks();runtime.close();});

  it("requires company name and tax id, then calculates a separate five-percent difference", () => {
    expect(() => runtime.invoices.create(owner, orderId, {
      invoiceTitle: "测试科技有限公司", taxId: "", recipientEmail: "finance@example.com", contactName: "财务人员",
      invoiceAmount: "1000.00", requestKey: "invoice-invalid-tax",
    })).toThrow("税号");

    const application = runtime.invoices.create(owner, orderId, {
      invoiceTitle: "测试科技有限公司", taxId: "91310000MA12345678", recipientEmail: "finance@example.com",
      contactName: "财务人员", contactPhone: "13800138000", invoiceAmount: "1000.00", requestKey: "invoice-request-001",
    });
    expect(application).toMatchObject({status: "awaiting_payment", category: "技术服务费", invoiceAmountMinor: 100_000n, feeAmountMinor: 5_000n});
    expect(runtime.invoices.get(owner, application.id)).toMatchObject({invoiceAmount: "1000.00", feeAmount: "50.00", taxId: "91310000MA12345678"});
  });

  it("replays identical order applications but rejects different invoice details", () => {
    const input={invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",recipientEmail:"finance@example.com",
      contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-order-first"};
    const first=runtime.invoices.create(owner,orderId,input);
    expect(runtime.invoices.create(owner,orderId,{...input,requestKey:"invoice-order-same"}).id).toBe(first.id);
    expect(()=>runtime.invoices.create(owner,orderId,{...input,invoiceAmount:"1200.00",requestKey:"invoice-order-conflict"}))
      .toThrow("该订单已有不同资料的开票申请");
    expect(runtime.repository.listOperations("invoice_application",owner.merchantId!)).toHaveLength(1);
  });

  it("rechecks the order payment state inside the invoice creation transaction", () => {
    const repository=runtime.repository,transaction=repository.transaction.bind(repository),order=repository.findOrder(owner.merchantId!,orderId)!;
    vi.spyOn(repository,"transaction").mockImplementationOnce(action=>{
      repository.updateOrder({...order,paymentStatus:"refunded",ordinaryRefundedMinor:order.saleAmountMinor,updatedAt:new Date()});
      return transaction(action);
    });
    expect(()=>runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-refund-race"}))
      .toThrow("只有已付款且未全额退款的订单可以申请开票");
    expect(repository.listOperations("invoice_application",owner.merchantId!)).toHaveLength(0);
  });

  it("submits only after verified payment and supports manual processing without a second review", () => {
    const application = runtime.invoices.create(owner, orderId, {
      invoiceTitle: "测试科技有限公司", taxId: "91310000MA12345678", recipientEmail: "finance@example.com",
      contactName: "财务人员", invoiceAmount: "1000.00", requestKey: "invoice-request-002",
    });
    const now = new Date(), payment: InvoiceFeePayment = {id: "invpay_test", merchantId: owner.merchantId!,
      applicationId: application.id, amountMinor: application.feeAmountMinor, status: "pending", paymentConfigId: null,
      qrPayload: null, providerRef: null, expiresAt: new Date(Date.now() + 60_000), nextCheckAt: null, paidAt: null,
      createdAt: now, updatedAt: now};
    runtime.repository.saveOperations("invoice_fee_payment", payment, true);
    runtime.invoices.attachPayment(application.id, payment.id);
    expect(runtime.invoices.markPaid(payment.id, "2026100100000001", 5_000n).status).toBe("submitted");

    const submitted = runtime.invoices.get(admin, application.id);
    const processing = runtime.invoices.review(admin, application.id, {action: "processing", version: submitted.version, note: "资料已核对"});
    const issued = runtime.invoices.review(admin, application.id, {action: "issued", version: processing.version, invoiceNo: "INV-2026-0001", note: "电子发票已发送"});
    expect(issued).toMatchObject({status: "issued", invoiceNo: "INV-2026-0001"});
  });

  it("rejects an administrator review when the application changes after the request read",()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-review-race"});
    const now=new Date(),payment:InvoiceFeePayment={id:"invpay_review_race",merchantId:owner.merchantId!,applicationId:application.id,
      amountMinor:application.feeAmountMinor,status:"pending",paymentConfigId:null,qrPayload:null,providerRef:null,
      expiresAt:new Date(Date.now()+60_000),nextCheckAt:null,paidAt:null,createdAt:now,updatedAt:now};
    runtime.repository.saveOperations("invoice_fee_payment",payment,true);
    runtime.invoices.attachPayment(application.id,payment.id);
    const submitted=runtime.invoices.markPaid(payment.id,"2026100100000991",payment.amountMinor),repository=runtime.repository,
      transaction=repository.transaction.bind(repository);
    vi.spyOn(repository,"transaction").mockImplementationOnce(action=>{
      const current=repository.getOperations("invoice_application",application.id)!;
      repository.saveOperations("invoice_application",{...current,reviewNote:"另一请求已经更新",version:current.version+1,updatedAt:new Date()});
      return transaction(action);
    });
    expect(()=>runtime.invoices.review(admin,application.id,{action:"processing",version:submitted.version,note:"开始处理"}))
      .toThrow("开票申请已变化");
    expect(repository.getOperations("invoice_application",application.id)).toMatchObject({status:"submitted",reviewNote:"另一请求已经更新"});
  });

  it("allows paid applications to be returned for correction without charging again", () => {
    const application = runtime.invoices.create(owner, orderId, {
      invoiceTitle: "旧公司名称", taxId: "91310000MA12345678", recipientEmail: "old@example.com",
      contactName: "财务人员", invoiceAmount: "1000.00", requestKey: "invoice-request-003",
    });
    const now = new Date(), payment: InvoiceFeePayment = {id: "invpay_correction", merchantId: owner.merchantId!,
      applicationId: application.id, amountMinor: application.feeAmountMinor, status: "pending", paymentConfigId: null,
      qrPayload: null, providerRef: null, expiresAt: new Date(Date.now() + 60_000), nextCheckAt: null, paidAt: null,
      createdAt: now, updatedAt: now};
    runtime.repository.saveOperations("invoice_fee_payment", payment, true);
    runtime.invoices.attachPayment(application.id, payment.id);
    const submitted = runtime.invoices.markPaid(payment.id, "2026100100000002", 5_000n);
    const correction = runtime.invoices.review(admin, application.id, {action: "needs_correction", version: submitted.version, note: "公司名称不完整"});
    const resubmitted = runtime.invoices.revise(owner, application.id, {version: correction.version,
      invoiceTitle: "新公司完整名称有限公司", taxId: "91310000MA12345678", recipientEmail: "new@example.com", contactName: "财务人员"});
    expect(resubmitted).toMatchObject({status: "submitted", invoiceTitle: "新公司完整名称有限公司", feeAmount: "50.00"});
    expect(runtime.repository.listOperations("invoice_fee_payment", owner.merchantId!).length).toBe(1);
  });

  it("uses an independent Alipay trade labelled as an order difference", async () => {
    const application = runtime.invoices.create(owner, orderId, {
      invoiceTitle: "测试科技有限公司", taxId: "91310000MA12345678", recipientEmail: "finance@example.com",
      contactName: "财务人员", invoiceAmount: "1000.00", requestKey: "invoice-request-004",
    });
    let precreate: Record<string, unknown> | null = null;
    const client = {
      pageExecute: () => "",
      exec: async (_method: string, input: Record<string, unknown>) => {precreate = input; return {code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/test-invoice"};},
      checkNotifySignV2: () => true,
    };
    const gateway = new InvoiceAlipayService(runtime.repository, runtime.paymentSettings, runtime.invoices,
      "https://pay.example.com", runtime.portalTokens, {client, identity: {appId: "2026000000000000", sellerId: "2088000000000000"}});
    const {payment} = gateway.ensurePayment(owner, application.id);
    await gateway.precreate(payment.id);
    expect(precreate).toMatchObject({bizContent: {out_trade_no: payment.id, total_amount: "50.00", subject: "订单补差价"}});
    gateway.handleNotification({out_trade_no: payment.id, total_amount: "50.00", trade_no: "2026100100000003",
      trade_status: "TRADE_SUCCESS", sign_type: "RSA2", app_id: "2026000000000000", seller_id: "2088000000000000"});
    expect(runtime.invoices.get(owner, application.id).status).toBe("submitted");
  });

  it("expires an unstarted difference payment without querying Alipay and accepts one verified late payment",async()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-timeout-late"});
    const exec=vi.fn(),client={pageExecute:()=>"",exec,checkNotifySignV2:()=>true},identity={appId:"2026000000000000",sellerId:"2088000000000000"};
    const gateway=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,
      "https://pay.example.com",runtime.portalTokens,{client,identity});
    const {payment}=gateway.ensurePayment(owner,application.id);
    runtime.repository.saveOperations("invoice_fee_payment",{...payment,expiresAt:new Date(Date.now()-1_000),updatedAt:new Date()});
    await gateway.reconcile(payment.id);
    expect(exec).not.toHaveBeenCalled();
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)?.status).toBe("expired");
    const notice={out_trade_no:payment.id,total_amount:"50.00",trade_no:"2026100100002881",trade_status:"TRADE_SUCCESS",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId};
    gateway.handleNotification(notice);gateway.handleNotification(notice);
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)?.status).toBe("paid");
    expect(runtime.invoices.get(owner,application.id)).toMatchObject({status:"submitted",providerRef:"2026100100002881"});
  });

  it("keeps an Alipay-closed difference payment terminal",()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-provider-closed"});
    const client={pageExecute:()=>"",exec:vi.fn(),checkNotifySignV2:()=>true},identity={appId:"2026000000000000",sellerId:"2088000000000000"};
    const gateway=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,
      "https://pay.example.com",runtime.portalTokens,{client,identity}),{payment}=gateway.ensurePayment(owner,application.id);
    gateway.handleNotification({out_trade_no:payment.id,total_amount:"50.00",trade_status:"TRADE_CLOSED",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId});
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)?.status).toBe("closed");
    expect(()=>gateway.handleNotification({out_trade_no:payment.id,total_amount:"50.00",trade_no:"2026100100002882",
      trade_status:"TRADE_SUCCESS",sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId})).toThrow("明确关闭");
    expect(runtime.invoices.get(owner,application.id).status).toBe("awaiting_payment");
  });

  it("does not let a stale closed result overwrite an interleaved paid invoice fee",()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-close-race"});
    const client={pageExecute:()=>"",exec:vi.fn(),checkNotifySignV2:()=>true},identity={appId:"2026000000000000",sellerId:"2088000000000000"};
    const gateway=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,
      "https://pay.example.com",runtime.portalTokens,{client,identity}),{payment}=gateway.ensurePayment(owner,application.id),
      repository=runtime.repository,transaction=repository.transaction.bind(repository);
    let injected=false;
    const transactionSpy=vi.spyOn(repository,"transaction").mockImplementation(action=>{
      if(!injected){injected=true;runtime.invoices.markPaid(payment.id,"2026100100002883",payment.amountMinor);}
      return transaction(action);
    });
    gateway.handleNotification({out_trade_no:payment.id,total_amount:"50.00",trade_status:"TRADE_CLOSED",
      sign_type:"RSA2",sign:"verified",app_id:identity.appId,seller_id:identity.sellerId});
    transactionSpy.mockRestore();
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)?.status).toBe("paid");
    expect(runtime.invoices.get(owner,application.id).status).toBe("submitted");
  });

  it("coalesces invoice payment-code creation and rejects an active database lease",async()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-precreate-race"});
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),code="https://qr.alipay.com/invoice-once";
    const exec=vi.fn(async()=>{await gate;return {code:"10000",msg:"Success",qr_code:code};}),client={pageExecute:()=>"",exec,checkNotifySignV2:()=>true},
      identity={appId:"2026000000000000",sellerId:"2088000000000000"},gateway=new InvoiceAlipayService(runtime.repository,
        runtime.paymentSettings,runtime.invoices,"https://pay.example.com",runtime.portalTokens,{client,identity}),{payment}=gateway.ensurePayment(owner,application.id);
    const first=gateway.precreate(payment.id),second=gateway.precreate(payment.id);await Promise.resolve();release();
    await expect(Promise.all([first,second])).resolves.toEqual([code,code]);expect(exec).toHaveBeenCalledTimes(1);
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)).toMatchObject({qrPayload:code,
      precreateLeaseToken:null,precreateLeaseUntil:null});

    const application2={...application,id:"inv_second_precreate",requestKey:"invoice-precreate-race-2",paymentId:null,createdAt:new Date(),updatedAt:new Date()};
    runtime.repository.saveOperations("invoice_application",application2,true);
    const secondPayment=gateway.ensurePayment(owner,application2.id).payment;
    runtime.repository.saveOperations("invoice_fee_payment",{...secondPayment,precreateLeaseToken:"other-worker",
      precreateLeaseUntil:new Date(Date.now()+30_000),updatedAt:new Date()});
    await expect(gateway.precreate(secondPayment.id)).rejects.toMatchObject({code:"payment_code_generating",retryable:true});
  });

  it("releases a failed invoice payment-code lease so it can retry",async()=>{
    const application=runtime.invoices.create(owner,orderId,{invoiceTitle:"测试科技有限公司",taxId:"91310000MA12345678",
      recipientEmail:"finance@example.com",contactName:"财务人员",invoiceAmount:"1000.00",requestKey:"invoice-precreate-retry"}),
      exec=vi.fn().mockResolvedValueOnce({code:"40004",msg:"failed"})
        .mockResolvedValueOnce({code:"10000",msg:"Success",qr_code:"https://qr.alipay.com/invoice-retry"}),
      client={pageExecute:()=>"",exec,checkNotifySignV2:()=>true},identity={appId:"2026000000000000",sellerId:"2088000000000000"},
      gateway=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,
        "https://pay.example.com",runtime.portalTokens,{client,identity}),{payment}=gateway.ensurePayment(owner,application.id);
    await expect(gateway.precreate(payment.id)).rejects.toMatchObject({code:"payment_provider_unavailable"});
    expect(runtime.repository.getOperations("invoice_fee_payment",payment.id)).toMatchObject({precreateLeaseToken:null,precreateLeaseUntil:null});
    await expect(gateway.precreate(payment.id)).resolves.toBe("https://qr.alipay.com/invoice-retry");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
