import {afterEach,describe,expect,it,vi} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";
import {WalletAlipayService} from "../src/modules/wallet-alipay.js";
import {AlipayPagePaymentProvider} from "../src/modules/alipay-payment.js";
import {ManagedAlipayService} from "../src/modules/managed-payment.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import type {Repository} from "../src/infra/repository.js";

describe("bounded payment worker queues",()=>{
  let runtime:Runtime|null=null;
  afterEach(()=>{vi.restoreAllMocks();runtime?.close();runtime=null;});

  it("selects only due invoice and wallet payments without full operation scans",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    runtime=createRuntime(config);publishTestRechargeProduct(runtime);
    const merchant=runtime.repository.listMerchants()[0]!,now=new Date(),future=new Date(now.getTime()+60_000),past=new Date(now.getTime()-60_000);
    runtime.repository.saveOperations("invoice_fee_payment",{id:"invoice-future",merchantId:merchant.id,applicationId:"application-future",amountMinor:500n,
      status:"pending",paymentConfigId:null,qrPayload:null,providerRef:null,expiresAt:future,nextCheckAt:future,paidAt:null,createdAt:past,updatedAt:past},true);
    runtime.repository.saveOperations("invoice_fee_payment",{id:"invoice-due",merchantId:merchant.id,applicationId:"application-due",amountMinor:500n,
      status:"pending",paymentConfigId:null,qrPayload:null,providerRef:null,expiresAt:future,nextCheckAt:null,paidAt:null,createdAt:now,updatedAt:now},true);
    runtime.repository.saveOperations("wallet_deposit",{id:"wallet-future",merchantId:merchant.id,amountMinor:10_000n,status:"requested",requestKey:"wallet-future-key",
      payerReference:"支付宝在线充值",verifiedReference:null,reviewerId:null,paymentProvider:"alipay_page",paymentConfigId:null,providerRef:null,
      expiresAt:future,paidAt:null,nextCheckAt:future,createdAt:past,updatedAt:past},true);
    runtime.repository.saveOperations("wallet_deposit",{id:"wallet-due",merchantId:merchant.id,amountMinor:10_000n,status:"requested",requestKey:"wallet-due-key",
      payerReference:"支付宝在线充值",verifiedReference:null,reviewerId:null,paymentProvider:"alipay_page",paymentConfigId:null,providerRef:null,
      expiresAt:future,paidAt:null,nextCheckAt:null,createdAt:now,updatedAt:now},true);
    const credential=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const order=await runtime.orders.create({merchantId:credential.merchant.id,appId:credential.app.id,keyId:credential.key.keyId,partnerId:credential.merchant.partnerId},
      {merchantOrderNo:"ALIPAY-DUE-ORDER",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
    const attempt=runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page",nextCheckAt:past});
    runtime.repository.insertRefund({id:"refund-due",merchantId:order.merchantId,orderId:order.id,merchantRefundNo:"refund-due-no",type:"full",amountMinor:100n,
      status:"processing",reason:"队列测试",failureCode:"refund_result_unknown",providerRefundNo:null,nextCheckAt:past,recoveryAttempts:0,createdAt:past,refundedAt:null});

    const invoice=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,"https://pay.example.com",runtime.portalTokens);
    const wallet=new WalletAlipayService(runtime.repository,runtime.paymentSettings,runtime.wallets,"https://pay.example.com",runtime.portalTokens);
    const alipay=new ManagedAlipayService(runtime.repository,runtime.paymentSettings,runtime.payment,"https://pay.example.com",
      new AlipayPagePaymentProvider("https://pay.example.com",runtime.portalTokens));
    const invoiceRun=vi.spyOn(invoice,"reconcile").mockResolvedValue(),walletRun=vi.spyOn(wallet,"reconcile").mockResolvedValue(),alipayRun=vi.spyOn(alipay,"reconcile").mockResolvedValue();
    const query=vi.spyOn(runtime.repository as unknown as {queryRecords:(...args:unknown[])=>unknown},"queryRecords"),full=vi.spyOn(runtime.repository,"listOperations");

    await invoice.reconcileOne();await wallet.reconcileOne();await alipay.reconcileOne();

    expect(invoiceRun).toHaveBeenCalledWith("invoice-due");expect(walletRun).toHaveBeenCalledWith("wallet-due");expect(alipayRun).toHaveBeenCalledWith(order.id);
    expect(query.mock.calls.map(call=>call[0])).toEqual(["invoice_fee_payment","wallet_deposit"]);
    expect(query.mock.calls.every(call=>(call[1] as {count?:boolean}).count===false)).toBe(true);
    const repository=runtime.repository as Repository;
    expect(repository.findDueRefund?.("alipay_page",now)?.id).toBe("refund-due");
    expect(repository.findRefundInternal?.("refund-due")?.orderId).toBe(order.id);
    runtime.payment.markPaid(order.merchantId,order.id,{channel:"alipay_page",providerRef:"2026100100000099",receivedMinor:order.saleAmountMinor});
    const paidAttempt=runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...paidAttempt,nextCheckAt:past});
    expect(repository.findDuePaymentOrder?.("alipay_page",now)).toMatchObject({id:order.id,paymentStatus:"paid"});
    expect(full).not.toHaveBeenCalled();
  });
});
