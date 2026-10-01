import {afterEach,describe,expect,it,vi} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";
import {WalletAlipayService} from "../src/modules/wallet-alipay.js";
import {DujiaoPaymentService} from "../src/modules/dujiaopay-payment.js";
import {AlipayPagePaymentProvider} from "../src/modules/alipay-payment.js";
import {ManagedAlipayService} from "../src/modules/managed-payment.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import type {Repository} from "../src/infra/repository.js";

describe("bounded payment worker queues",()=>{
  let runtime:Runtime|null=null;
  afterEach(()=>{vi.restoreAllMocks();runtime?.close();runtime=null;});

  it("selects only due invoice, wallet and crypto payments without full operation scans",async()=>{
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
      {merchantOrderNo:"CRYPTO-DUE-ORDER",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
    const attempt=runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page",nextCheckAt:past});
    runtime.repository.saveOperations("crypto_payment",{id:order.id,merchantId:order.merchantId,orderId:order.id,revisionId:"revision-test",
      providerOrderId:null,state:"pending",address:null,payableAmount:null,chain:"tron",tokenId:"usdt",expiresAt:future,nextCheckAt:past,
      leaseUntil:null,leaseToken:null,createdAt:past,updatedAt:past,failureCode:null},true);
    runtime.repository.insertRefund({id:"refund-due",merchantId:order.merchantId,orderId:order.id,merchantRefundNo:"refund-due-no",type:"full",amountMinor:100n,
      status:"processing",reason:"队列测试",failureCode:"refund_result_unknown",providerRefundNo:null,nextCheckAt:past,recoveryAttempts:0,createdAt:past,refundedAt:null});

    const invoice=new InvoiceAlipayService(runtime.repository,runtime.paymentSettings,runtime.invoices,"https://pay.example.com",runtime.portalTokens);
    const wallet=new WalletAlipayService(runtime.repository,runtime.paymentSettings,runtime.wallets,"https://pay.example.com",runtime.portalTokens);
    const crypto=new DujiaoPaymentService(runtime.repository,runtime.paymentSettings,runtime.payment);
    const alipay=new ManagedAlipayService(runtime.repository,runtime.paymentSettings,runtime.payment,"https://pay.example.com",
      new AlipayPagePaymentProvider("https://pay.example.com",runtime.portalTokens));
    const invoiceRun=vi.spyOn(invoice,"reconcile").mockResolvedValue(),walletRun=vi.spyOn(wallet,"reconcile").mockResolvedValue(),cryptoRun=vi.spyOn(crypto,"reconcile").mockResolvedValue(),alipayRun=vi.spyOn(alipay,"reconcile").mockResolvedValue();
    const query=vi.spyOn(runtime.repository as unknown as {queryRecords:(...args:unknown[])=>unknown},"queryRecords"),full=vi.spyOn(runtime.repository,"listOperations");

    await invoice.reconcileOne();await wallet.reconcileOne();await crypto.reconcileOne();await alipay.reconcileOne();

    expect(invoiceRun).toHaveBeenCalledWith("invoice-due");expect(walletRun).toHaveBeenCalledWith("wallet-due");expect(cryptoRun).toHaveBeenCalledWith(order.id);expect(alipayRun).toHaveBeenCalledWith(order.id);
    expect(query.mock.calls.map(call=>call[0])).toEqual(["invoice_fee_payment","wallet_deposit","crypto_payment"]);
    expect(query.mock.calls.every(call=>(call[1] as {count?:boolean}).count===false)).toBe(true);
    const repository=runtime.repository as Repository;
    expect(repository.findDueRefund?.("alipay_page",now)?.id).toBe("refund-due");
    expect(repository.findRefundInternal?.("refund-due")?.orderId).toBe(order.id);
    expect(full).not.toHaveBeenCalled();
  });
});
