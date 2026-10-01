import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";

describe("fixed one-yuan payment integration test",()=>{
  const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent",PUBLIC_BASE_URL:"https://tibo.ink"});
  let runtime:Runtime,app:Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async()=>{runtime=createRuntime(config);app=await buildApp(config,runtime);});
  afterEach(async()=>{vi.restoreAllMocks();await app.close();runtime.close();});

  async function signed(method:"GET"|"POST",path:string,payload?:unknown,key:string=randomUUID()){
    const body=payload===undefined?"":JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    return app.inject({method,url:path,headers:{"x-partner-id":config.demoPartnerId,"x-key-id":config.demoKeyId,
      "x-timestamp":timestamp,"x-nonce":nonce,...(method==="POST"?{"idempotency-key":key}:{}),
      "x-signature":signRequest({method,path,rawQuery:"",timestamp,nonce,keyId:config.demoKeyId,
        idempotencyKey:method==="POST"?key:"",rawBody:Buffer.from(body)},config.demoClientSecret),
      ...(payload===undefined?{}:{"content-type":"application/json"})},...(payload===undefined?{}:{payload:body})});
  }

  it("collects exactly one yuan and never enters CDK or recharge providers",async()=>{
    const create=await signed("POST","/v1/payment-tests",{merchant_order_no:"PAYMENT-TEST-001"},"payment-test-create-001");
    expect(create.statusCode).toBe(201);
    expect(create.json().data).toMatchObject({product_code:"payment_test_1_cny",purpose:"payment_test",quantity:1,
      sale_amount:"1.00",supply_amount:"1.00",merchant_margin:"0.00",payment_status:"pending",
      fulfillment_mode:null,delivery_mode:null,fulfillment_url:null,voucher_code:null});
    const replay=await signed("POST","/v1/payment-tests",{merchant_order_no:"PAYMENT-TEST-001"},"payment-test-create-001");
    expect(replay.json().data.order_id).toBe(create.json().data.order_id);
    expect(replay.json().idempotent).toBe(true);

    const orderId=String(create.json().data.order_id),order=runtime.repository.findOrderInternal(orderId)!;
    expect(order).toMatchObject({paymentPurpose:"payment_test",liveTest:true,saleAmountMinor:100n,supplyAmountMinor:100n});
    const upstreamSpies=[vi.spyOn(runtime.upstream,"issueCdk"),vi.spyOn(runtime.upstream,"submitDirect"),
      vi.spyOn(runtime.upstream,"submitCdk"),vi.spyOn(runtime.upstream,"query"),vi.spyOn(runtime.upstream,"preflightDirect"),
      vi.spyOn(runtime.upstream,"preflightCdk")];
    runtime.payment.markPaid(order.merchantId,order.id,{providerRef:"payment-test-paid",receivedMinor:100n});
    expect(await runtime.cdk.issueOne()).toBeNull();
    expect(await runtime.fulfillments.processOne()).toBeNull();
    const fulfillment=await signed("POST",`/v1/orders/${order.id}/fulfillments`,{session_data:{session:"must-not-send"},
      customer_confirmed_email:true},"payment-test-fulfillment");
    expect(fulfillment.json().error.code).toBe("payment_test_has_no_fulfillment");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)).toBeNull();
    expect(runtime.repository.listFulfillments(order.merchantId,order.id)).toEqual([]);
    for(const spy of upstreamSpies)expect(spy).not.toHaveBeenCalled();
  });
});
