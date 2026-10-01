import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Order,TenantContext} from "../src/domain/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("refund reconciliation queue boundaries",()=>{
  const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
  let runtime:Runtime,tenant:TenantContext;
  beforeEach(()=>{runtime=createRuntime(config);publishTestRechargeProduct(runtime);const bundle=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!;
    tenant={merchantId:bundle.merchant.id,partnerId:bundle.merchant.partnerId,appId:bundle.app.id,keyId:bundle.key.keyId};});
  afterEach(()=>runtime.close());

  async function paidOrder():Promise<Order>{
    const created=await runtime.orders.create(tenant,{merchantOrderNo:randomUUID(),productCode:"chatgpt_plus_cdk_1m",
      quantity:1,saleAmount:"135.00",deliveryMode:"auto_recharge"});
    return runtime.payment.markPaid(created.merchantId,created.id,{channel:"mock",providerRef:`mock:${created.id}`,receivedMinor:created.saleAmountMinor});
  }
  const hold=(order:Order)=>runtime.refundReconciliations.observe({merchantId:order.merchantId,orderId:order.id,
    reportedMinor:1_000n,recordedMinor:0n,providerReference:`alipay-query:${order.id}:10.00`});

  it("continues polling a running upstream task while blocking new submissions",async()=>{
    const order=await paidOrder(),voucher=(await runtime.cdk.issueOne())!;
    const queued=runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"running-session"});
    runtime.repository.updateFulfillment({...queued,status:"running",upstreamProvider:"mock",upstreamOrderId:"mock-running-order",
      upstreamStatus:"processing",nextCheckAt:new Date(0),leaseToken:null,leaseUntil:null});
    hold(order);

    const completed=await runtime.fulfillments.processOne();
    expect(completed).toMatchObject({id:queued.id,orderId:order.id,status:"succeeded"});
  });

  it("executes an eligible fulfillment behind twenty locked queue entries",async()=>{
    for(let index=0;index<20;index+=1){
      const order=await paidOrder(),voucher=(await runtime.cdk.issueOne())!;
      runtime.fulfillments.createCdkPublic(order,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:`held-${index}`});
      hold(order);
    }
    const eligible=await paidOrder(),voucher=(await runtime.cdk.issueOne())!;
    runtime.fulfillments.createCdkPublic(eligible,voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"eligible"});

    const completed=await runtime.fulfillments.processOne();
    expect(completed).toMatchObject({orderId:eligible.id,status:"succeeded"});
  });

  it("issues an eligible CDK behind twenty locked orders",async()=>{
    for(let index=0;index<20;index+=1)hold(await paidOrder());
    const eligible=await paidOrder();

    const voucher=await runtime.cdk.issueOne();
    expect(voucher).toMatchObject({orderId:eligible.id,status:"unused"});
  });
});
