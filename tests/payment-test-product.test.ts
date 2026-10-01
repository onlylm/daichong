import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime,type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import {AlipayPagePaymentProvider,AlipayPaymentService,type AlipayClient} from "../src/modules/alipay-payment.js";

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

  it("accepts repeated verified Alipay HTTP callbacks once without enabling any recharge path",async()=>{
    const created=await signed("POST","/v1/payment-tests",{merchant_order_no:"PAYMENT-TEST-NOTIFY-001"},"payment-test-notify-create");
    expect(created.statusCode).toBe(201);
    const orderId=String(created.json().data.order_id),order=runtime.repository.findOrderInternal(orderId)!;
    const attempt=runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)!;
    runtime.repository.updatePaymentAttempt({...attempt,provider:"alipay_page",providerRef:order.id,qrPayload:null});
    const exec=vi.fn(),pageExecute=vi.fn(async()=>""),checkNotifySignV2=vi.fn(()=>true);
    const client={exec,pageExecute,checkNotifySignV2} as unknown as AlipayClient;
    await app.close();
    runtime.alipay=new AlipayPaymentService(runtime.repository,runtime.payment,client,
      {appId:"one-yuan-test-app",sellerId:"2088000000000000"},config.publicBaseUrl,
      new AlipayPagePaymentProvider(config.publicBaseUrl,runtime.portalTokens));
    app=await buildApp(config,runtime);
    const upstreamSpies=[vi.spyOn(runtime.upstream,"issueCdk"),vi.spyOn(runtime.upstream,"submitDirect"),
      vi.spyOn(runtime.upstream,"submitCdk"),vi.spyOn(runtime.upstream,"query"),vi.spyOn(runtime.upstream,"preflightDirect"),
      vi.spyOn(runtime.upstream,"preflightCdk")];
    const notice={sign_type:"RSA2",sign:"synthetic-signature",app_id:"one-yuan-test-app",seller_id:"2088000000000000",
      out_trade_no:order.id,total_amount:"1.00",trade_status:"TRADE_SUCCESS",trade_no:"2026100200001001"};
    for(let replay=0;replay<2;replay++){
      const response=await app.inject({method:"POST",url:"/internal/webhooks/alipay",
        headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams(notice).toString()});
      expect(response.statusCode,response.body).toBe(200);expect(response.body).toBe("success");
    }
    expect(checkNotifySignV2).toHaveBeenCalledTimes(2);
    expect(checkNotifySignV2).toHaveBeenCalledWith(expect.objectContaining(notice));
    expect(runtime.repository.findOrderInternal(order.id)).toMatchObject({paymentStatus:"paid",paymentReceivedMinor:100n,paymentProviderRef:notice.trade_no});
    expect(runtime.repository.findPaymentAttemptByOrder(order.merchantId,order.id)).toMatchObject({status:"paid",receivedMinor:100n,providerRef:notice.trade_no});
    const ledger=runtime.repository.listLedger(order.merchantId).filter(value=>value.orderId===order.id);
    expect(ledger).toHaveLength(4);
    expect(ledger.filter(value=>value.type==="user_payment")).toEqual([expect.objectContaining({amountMinor:100n})]);
    for(const type of ["supply_price","merchant_margin","merchant_pending_settlement"])expect(ledger.filter(value=>value.type===type)).toHaveLength(1);
    expect(runtime.repository.listOutbox(order.merchantId).filter(value=>value.eventType==="order.paid"&&value.payload.order_id===order.id)).toHaveLength(1);
    expect(await runtime.cdk.issueOne()).toBeNull();expect(await runtime.fulfillments.processOne()).toBeNull();
    const fulfillment=await signed("POST",`/v1/orders/${order.id}/fulfillments`,{session_data:{session:"must-not-send"},customer_confirmed_email:true},"callback-no-fulfillment");
    expect(fulfillment.statusCode).toBe(409);expect(fulfillment.json().error.code).toBe("payment_test_has_no_fulfillment");
    const payload={token:runtime.portalTokens.sign(order.id),credential:{mode:"session",session:"must-not-send"},customer_confirmed_email:true};
    const direct=await app.inject({method:"POST",url:`/public/orders/${order.id}/direct`,payload});
    expect(direct.statusCode).toBe(409);expect(direct.json().error.code).toBe("payment_test_has_no_fulfillment");
    const auto=await app.inject({method:"POST",url:`/public/orders/${order.id}/auto-recharge`,payload});
    expect(auto.statusCode).toBe(409);expect(auto.json().error.code).toBe("auto_recharge_unavailable");
    expect(runtime.repository.findCdkVoucherByOrder(order.id)).toBeNull();
    expect(runtime.repository.listFulfillments(order.merchantId,order.id)).toEqual([]);
    expect(runtime.repository.getOperations("wallet_credit",order.id)).toBeNull();
    expect(exec).not.toHaveBeenCalled();expect(pageExecute).not.toHaveBeenCalled();
    for(const spy of upstreamSpies)expect(spy).not.toHaveBeenCalled();
  });

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
