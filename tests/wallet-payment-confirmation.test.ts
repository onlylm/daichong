import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {hasConfirmedOrderPayment} from "../src/domain/payment-confirmation.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

for (const driver of ["memory","sqlite"] as const) describe(`wallet collection evidence (${driver})`,()=>{
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
