import {describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {loadConfig} from "../src/config.js";
import {createRuntime} from "../src/bootstrap.js";
import {refundReconciliationId} from "../src/domain/provider-refund-review.js";
import {loginPlatform} from "./fixtures/mfa.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe.each(["memory","sqlite"] as const)("explicit external refund HTTP amount (%s)",driver=>{
  it("rejects the old amount-less request unchanged; two precise receipts close only the observed difference",async()=>{
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:driver,SQLITE_PATH:":memory:",LOG_LEVEL:"silent",
      PUBLIC_BASE_URL:"https://tibo.test",ADMIN_BASE_URL:"https://admin.tibo.test"});
    const runtime=createRuntime(config);publishTestRechargeProduct(runtime);
    const admin=await runtime.accounts.bootstrap("receipt-admin","synthetic-receipt-admin-password");
    runtime.repository.saveOperations("account",{...runtime.repository.getOperations("account",admin.id)!,mustChangePassword:false});
    const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    const tenant={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};
    const order=await runtime.orders.create(tenant,{merchantOrderNo:"synthetic-partial",productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    runtime.payment.markPaid(tenant.merchantId,order.id,{providerRef:"synthetic-payment",receivedMinor:13500n});
    runtime.refunds.syncProviderRefund(order.id,2000n,"synthetic-cumulative-20");
    const recorder=vi.spyOn(runtime.refunds,"recordExternalCustomerRefund");
    const app=await buildApp(config,runtime);
    try{
      const login=await loginPlatform(app,"receipt-admin","synthetic-receipt-admin-password","https://admin.tibo.test");
      const headers={origin:"https://admin.tibo.test",cookie:String(login.headers["set-cookie"]).split(";")[0]!,"x-csrf-token":login.json().csrf};
      const url=`/workspace/api/orders/${order.id}/external-customer-refunds`,payload={reason:"合成普通部分退款凭证",requestKey:"synthetic-receipt-a",providerRefundNo:"SYNTH-RECEIPT-A",confirmAlreadyRefundedAtChannel:true};
      const ledgerCount=runtime.repository.listLedger(tenant.merchantId).length;
      const old=await app.inject({method:"POST",url,headers,payload});expect(old.statusCode).toBe(400);
      expect(recorder).not.toHaveBeenCalled();expect(runtime.repository.listRefundsForOrder(tenant.merchantId,order.id)).toHaveLength(0);
      expect(runtime.repository.listLedger(tenant.merchantId)).toHaveLength(ledgerCount);
      expect(runtime.repository.findOrderInternal(order.id)?.ordinaryRefundedMinor).toBe(0n);
      for(const index of [1,2]){
        const data={...payload,amount:"10.00",requestKey:`synthetic-receipt-${index}`,providerRefundNo:`SYNTH-RECEIPT-${index}`};
        const accepted=await app.inject({method:"POST",url,headers,payload:data});expect(accepted.statusCode,accepted.body).toBe(200);
        expect((await app.inject({method:"POST",url,headers,payload:data})).statusCode).toBe(200);
        expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus:"partially_refunded",ordinaryRefundedMinor:BigInt(index)*1000n,priceAdjustmentRefundedMinor:0n});
        expect(runtime.repository.getOperations("refund_reconciliation",refundReconciliationId(order.id))).toMatchObject({differenceMinor:BigInt(2-index)*1000n,status:index===1?"reviewing":"resolved"});
      }
      expect(runtime.repository.listRefundsForOrder(tenant.merchantId,order.id)).toHaveLength(2);
    }finally{await app.close();runtime.close();vi.restoreAllMocks();}
  });
});
