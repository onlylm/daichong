import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {hasConfirmedOrderPayment} from "../src/domain/payment-confirmation.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

for (const driver of ["memory","sqlite"] as const) describe(`wallet collection evidence (${driver})`,()=>{
  it("does not overwrite an existing refunded or conflicting payment attempt when first marking an order paid",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    const runtime=createRuntime(config);
    try {
      publishTestRechargeProduct(runtime);
      const binding=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!,merchantId=binding.merchant.id;
      const order=await runtime.orders.create({merchantId,partnerId:binding.merchant.partnerId,
        appId:binding.app.id,keyId:binding.key.keyId},{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00"});
      const draft=runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)!;
      const confirmation={channel:"alipay_page" as const,providerRef:"2026100200000003",receivedMinor:order.saleAmountMinor};
      runtime.repository.updatePaymentAttempt({...draft,provider:"alipay_page",status:"refunded"});
      expect(()=>runtime.payment.markPaid(merchantId,order.id,confirmation)).toThrow("支付尝试记录与已确认的渠道流水冲突");
      runtime.repository.updatePaymentAttempt({...draft,provider:"alipay_page",status:"paid",providerRef:"different-trade",
        receivedMinor:order.saleAmountMinor});
      expect(()=>runtime.payment.markPaid(merchantId,order.id,confirmation)).toThrow("支付尝试记录与已确认的渠道流水冲突");
      expect(runtime.repository.findOrderInternal(order.id)?.paymentStatus).toBe("pending");
      runtime.repository.updatePaymentAttempt({...draft,provider:"alipay_page",providerRef:order.id});
      expect(runtime.payment.markPaid(merchantId,order.id,confirmation).paymentStatus).toBe("paid");
    } finally {runtime.close();}
  });

  it("repairs a stale payment attempt on trusted replay without replaying ledger, webhook or commission",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    const runtime=createRuntime(config);
    try {
      publishTestRechargeProduct(runtime);
      const binding=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!,merchantId=binding.merchant.id;
      const order=await runtime.orders.create({merchantId,partnerId:binding.merchant.partnerId,
        appId:binding.app.id,keyId:binding.key.keyId},{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",collectionMode:"platform_collect"});
      const draft=runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)!;
      runtime.repository.updatePaymentAttempt({...draft,provider:"alipay_page"});
      const confirmation={channel:"alipay_page" as const,providerRef:"2026100200000001",receivedMinor:order.saleAmountMinor};
      runtime.payment.markPaid(merchantId,order.id,confirmation);
      const original=runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)!;
      const ledgerCount=runtime.repository.listLedger(merchantId).length;
      const paidEvents=()=>runtime.repository.listOutbox(merchantId).filter(event=>event.eventType==="order.paid");
      expect(paidEvents()).toHaveLength(1);
      runtime.repository.insertFulfillment({id:"ful_"+randomUUID(),merchantId,orderId:order.id,attemptNo:1,
        status:"succeeded",failureCode:null,message:null,accountEmailMasked:null,
        sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:null},mode:"cdk",voucherId:null,
        upstreamProvider:"supplier",upstreamOrderId:"supplier-replay-001",upstreamClientRequestId:randomUUID(),
        upstreamLookupToken:null,upstreamStatus:"completed",upstreamStage:"completed",upstreamQuoteMinor:null,
        upstreamCurrency:"USD",nextCheckAt:new Date(),createdAt:new Date(),finishedAt:new Date()});
      const stale={...original,status:"pending" as const,providerRef:null,receivedMinor:null,paidAt:null};
      runtime.repository.updatePaymentAttempt({...stale,providerRef:"other-trade"});
      expect(()=>runtime.payment.markPaid(merchantId,order.id,confirmation)).toThrow("支付尝试记录与已确认的渠道流水冲突");
      runtime.repository.updatePaymentAttempt({...stale,receivedMinor:order.saleAmountMinor-1n});
      expect(()=>runtime.payment.markPaid(merchantId,order.id,confirmation)).toThrow("支付尝试记录与已确认的渠道流水冲突");
      runtime.repository.updatePaymentAttempt({...stale,providerRef:order.id});
      expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();
      runtime.payment.markPaid(merchantId,order.id,confirmation);
      runtime.payment.markPaid(merchantId,order.id,confirmation);
      expect(runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)).toMatchObject({status:"paid",
        providerRef:confirmation.providerRef,receivedMinor:order.saleAmountMinor,paidAt:original.paidAt});
      expect(runtime.repository.listLedger(merchantId)).toHaveLength(ledgerCount);
      expect(paidEvents()).toHaveLength(1);
      expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2_500n);
      expect(runtime.repository.listOperations("wallet_entry",merchantId).filter(item=>item.kind==="earning_release"&&item.reference===order.id)).toHaveLength(1);
      runtime.repository.updatePaymentAttempt({...original,status:"refunded"});
      runtime.payment.markPaid(merchantId,order.id,confirmation);
      expect(runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)?.status).toBe("refunded");
    } finally {runtime.close();}
  });

  it("does not credit before matching payment confirmation and never duplicates or reverses an existing credit for a stale attempt",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
    const runtime=createRuntime(config);
    try {
      publishTestRechargeProduct(runtime);
      const binding=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
      const merchantId=binding.merchant.id;
      const order=await runtime.orders.create({merchantId,partnerId:binding.merchant.partnerId,
        appId:binding.app.id,keyId:binding.key.keyId},{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
        quantity:1,saleAmount:"135.00",collectionMode:"platform_collect"});
      const paid=runtime.payment.markPaid(merchantId,order.id,{providerRef:"alipay-confirmation-001",receivedMinor:order.saleAmountMinor});
      const attempt=runtime.repository.findPaymentAttemptByOrder(merchantId,order.id)!;
      const real={...attempt,provider:"alipay_page"};
      runtime.repository.insertFulfillment({id:"ful_"+randomUUID(),merchantId,orderId:order.id,attemptNo:1,
        status:"succeeded",failureCode:null,message:null,accountEmailMasked:null,
        sessionPayload:{ciphertext:null,iv:null,authTag:null,keyVersion:"test",clearedAt:null},mode:"cdk",voucherId:null,
        upstreamProvider:"supplier",upstreamOrderId:"supplier-confirmation-001",upstreamClientRequestId:randomUUID(),
        upstreamLookupToken:null,upstreamStatus:"completed",upstreamStage:"completed",upstreamQuoteMinor:null,
        upstreamCurrency:"USD",nextCheckAt:new Date(),createdAt:new Date(),finishedAt:new Date()});
      for (const inconsistent of [{...real,status:"pending" as const},{...real,receivedMinor:order.saleAmountMinor-1n},
        {...real,providerRef:"unrelated-payment"}]) {
        runtime.repository.updatePaymentAttempt(inconsistent);
        runtime.wallets.reconcileMerchantEarnings(merchantId);
        expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();
      }
      runtime.repository.updatePaymentAttempt(real);
      expect(hasConfirmedOrderPayment(paid,real)).toBe(true);
      runtime.wallets.reconcileMerchantEarnings(merchantId);
      runtime.wallets.reconcileMerchantEarnings(merchantId);
      expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2_500n);
      expect(runtime.repository.listOperations("wallet_entry",merchantId).filter(item=>item.kind==="earning_release"&&item.reference===order.id)).toHaveLength(1);
      runtime.repository.updatePaymentAttempt({...real,status:"pending"});
      runtime.wallets.reconcileMerchantEarnings(merchantId);
      expect(runtime.repository.getOperations("wallet_credit",order.id)?.recognizedMinor).toBe(2_500n);
      expect(runtime.repository.listOperations("wallet_entry",merchantId).filter(item=>item.reference===order.id)).toHaveLength(1);
      expect(hasConfirmedOrderPayment({...paid,collectionMode:"agent_collect",paymentProviderRef:"wallet:"+order.id},
        {...real,provider:"agent_wallet",providerRef:"wallet:"+order.id,receivedMinor:order.supplyAmountMinor})).toBe(true);
    } finally {runtime.close();}
  });
});
