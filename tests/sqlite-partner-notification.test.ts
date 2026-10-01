import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import {verifyWebhook} from "../src/modules/webhook-signature.js";
import {OutboxWorker} from "../src/worker/outbox-worker.js";
import {RepositoryWebhookDeliveryStore} from "../src/worker/repository-webhook-store.js";
import {UpstreamRequestError,type UpstreamOrderState} from "../src/upstream/recharge-provider.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("SQLite automatic recharge and partner notification recovery",()=>{
  it.each(["unknown-result","confirmed-failure"] as const)("restores %s, credits once and retries one verifiable success event",async scenario=>{
    const directory=mkdtempSync(join(tmpdir(),"quefa-partner-notification-"));
    const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:join(directory,"isolated.sqlite"),LOG_LEVEL:"silent"});
    let runtime=createRuntime(config),app=await buildApp(config,runtime);
    const endpoint="https://agent-a.example.test/quefa",secret="isolated-agent-a-webhook-secret",foreignSecret="isolated-agent-b-webhook-secret";
    const rawSession="synthetic-private-session",lookupToken="synthetic-private-recovery-token";
    const captured:Array<{url:string;headers:Headers;body:Buffer}>=[];
    async function restart(){
      await app.close();runtime.close();runtime=createRuntime(config);
      Object.defineProperty(runtime.upstream,"name",{value:"configured_supplier",configurable:true});
      app=await buildApp(config,runtime);
    }
    async function signed(method:"GET"|"POST",path:string,payload?:unknown,foreign=false){
      const rawBody=payload===undefined?"":JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID(),key=randomUUID();
      const keyId=foreign?"key_demo_b_01":config.demoKeyId;
      return app.inject({method,url:path,headers:{"x-partner-id":foreign?"pt_demo_b":config.demoPartnerId,"x-key-id":keyId,
        "x-timestamp":timestamp,"x-nonce":nonce,"idempotency-key":key,
        "x-signature":signRequest({method,path,rawQuery:"",timestamp,nonce,keyId,idempotencyKey:key,rawBody:Buffer.from(rawBody)},
          foreign?"demo-secret-b-must-be-at-least-32-characters":config.demoClientSecret),
        ...(payload===undefined?{}:{"content-type":"application/json"})},...(payload===undefined?{}:{payload:rawBody})});
    }
    try{
      publishTestRechargeProduct(runtime);
      const merchant=runtime.repository.findMerchantByPartner(config.demoPartnerId)!,foreign=runtime.repository.findMerchantByPartner("pt_demo_b")!;
      runtime.repository.saveWebhookEndpoint({id:"partner-success-a",merchantId:merchant.id,url:endpoint,secret,subscribedEvents:["fulfillment.succeeded"],status:"active"});
      runtime.repository.saveWebhookEndpoint({id:"partner-success-b",merchantId:foreign.id,url:"https://agent-b.example.test/quefa",secret:foreignSecret,subscribedEvents:["fulfillment.succeeded"],status:"active"});
      const created=await signed("POST","/v1/orders",{merchant_order_no:"notification-"+randomUUID(),product_code:"chatgpt_plus_cdk_1m",
        quantity:1,sale_amount:"135.00",collection_mode:"platform_collect",delivery_mode:"auto_recharge",notify_url:endpoint});
      expect(created.statusCode,created.body).toBe(201);
      const orderId=String(created.json().data.order_id),order=runtime.repository.findOrderInternal(orderId)!;
      // Isolated synthetic collection fact: no Alipay request, callback or real funds are involved.
      runtime.payment.markPaid(merchant.id,orderId,{providerRef:"synthetic-payment-"+orderId,receivedMinor:order.saleAmountMinor});
      const payment=runtime.repository.findPaymentAttemptByOrder(merchant.id,orderId)!;
      runtime.repository.updatePaymentAttempt({...payment,provider:"alipay_page",status:"paid"});
      const voucher=(await runtime.cdk.issueOne())!,rawCdk=runtime.cdk.readUpstreamCode(voucher);
      Object.defineProperty(runtime.upstream,"name",{value:"configured_supplier",configurable:true});
      const submitUrl=`/public/orders/${orderId}/auto-recharge`,payload={token:runtime.portalTokens.sign(orderId),credential:{mode:"session",session:rawSession},customer_confirmed_email:true};
      const queued=await app.inject({method:"POST",url:submitUrl,payload});
      expect(queued.statusCode,queued.body).toBe(202);
      const firstId=String(queued.json().data.fulfillment.fulfillment_id);
      const firstSubmit=vi.spyOn(runtime.upstream,"submitCdk").mockImplementation(async input=>{
        input.onSubmitting?.(lookupToken);
        if(scenario==="unknown-result")throw new UpstreamRequestError("upstream_unavailable",true);
        return state("failed_precharge",input.clientRequestId,lookupToken);
      });
      expect((await runtime.fulfillments.processOne())?.status).toBe(scenario==="unknown-result"?"running":"failed");
      expect(firstSubmit).toHaveBeenCalledOnce();
      expect(runtime.repository.getOperations("wallet_credit",orderId)).toBeNull();
      expect(runtime.repository.listOutbox(merchant.id).filter(value=>value.eventType==="fulfillment.succeeded")).toHaveLength(0);
      if(scenario==="unknown-result"){
        expect((await app.inject({method:"POST",url:submitUrl,payload})).statusCode).toBe(409);
        expect(runtime.repository.findCdkVoucherByOrder(orderId)?.status).toBe("reserved");
      }

      await restart();
      let completedId=firstId;
      const recoveredSubmit=vi.spyOn(runtime.upstream,"submitCdk").mockImplementation(async input=>{
        input.onSubmitting?.(lookupToken);return state("completed",input.clientRequestId,lookupToken);
      });
      const query=vi.spyOn(runtime.upstream,"query").mockResolvedValue(state("completed",firstId,lookupToken));
      if(scenario==="unknown-result"){
        const restored=runtime.repository.findFulfillment(merchant.id,firstId)!;
        expect(restored).toMatchObject({status:"running",sessionPayload:{ciphertext:null}});
        expect(restored.lookupPayload?.ciphertext).toBeTruthy();expect(JSON.stringify(restored)).not.toContain(lookupToken);
        expect((await app.inject({method:"POST",url:submitUrl,payload})).statusCode).toBe(409);
        runtime.repository.updateFulfillment({...restored,nextCheckAt:new Date(0),leaseUntil:null});
      }else{
        const retry=await app.inject({method:"POST",url:submitUrl,payload:{...payload,credential:{mode:"session",session:"synthetic-corrected-session"}}});
        expect(retry.statusCode,retry.body).toBe(202);completedId=String(retry.json().data.fulfillment.fulfillment_id);
        expect(completedId).not.toBe(firstId);
        expect(runtime.repository.findFulfillment(merchant.id,completedId)).toMatchObject({attemptNo:2,status:"queued"});
        expect((await app.inject({method:"POST",url:submitUrl,payload})).statusCode).toBe(409);
      }
      expect(await runtime.fulfillments.processOne()).toMatchObject({id:completedId,status:"succeeded"});
      if(scenario==="unknown-result"){
        expect(recoveredSubmit).not.toHaveBeenCalled();expect(query).toHaveBeenCalledWith(expect.objectContaining({lookupToken,clientRequestId:firstId}));
      }else{expect(recoveredSubmit).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();}
      const completed=runtime.repository.findFulfillment(merchant.id,completedId)!;
      runtime.fulfillments.applyUpstreamEvent(completedId,state("completed",completedId,lookupToken));
      expect(await runtime.fulfillments.processOne()).toBeNull();
      expect(runtime.repository.findCdkVoucherByOrder(orderId)).toMatchObject({status:"consumed",upstreamCodePayload:{ciphertext:null}});
      const releases=()=>runtime.repository.listOperations("wallet_entry",merchant.id).filter(value=>value.kind==="earning_release"&&value.reference===orderId);
      expect(releases()).toHaveLength(1);expect(releases()[0]?.earningsDelta).toBe(2_500n);
      expect(runtime.repository.listLedger(merchant.id).filter(value=>value.orderId===orderId&&value.type==="user_payment")).toHaveLength(1);
      const terminal=runtime.repository.listOutbox(merchant.id).filter(value=>value.eventType==="fulfillment.succeeded");
      expect(terminal).toHaveLength(1);expect(terminal[0]?.payload).toMatchObject({order_id:orderId,fulfillment_id:completedId,status:"succeeded",progress_version:completed.progressVersion});
      const worker=new OutboxWorker(new RepositoryWebhookDeliveryStore(runtime.repository),async(url,init)=>{
        captured.push({url,headers:new Headers(init.headers),body:Buffer.from(String(init.body))});return {ok:false,status:503};
      });
      expect(await worker.tick()).toBe(1);expect(await worker.tick()).toBe(0);
      expect(captured).toHaveLength(1);expect(captured[0]!.url).toBe(endpoint);
      const deliveryId=captured[0]!.headers.get("x-quefa-delivery")!;

      await restart();
      const retried=new OutboxWorker(new RepositoryWebhookDeliveryStore(runtime.repository),async(url,init)=>{
        captured.push({url,headers:new Headers(init.headers),body:Buffer.from(String(init.body))});return {ok:true,status:204};
      });
      expect(await retried.tick()).toBe(0);
      // Advance only this isolated delivery's due time; its persisted event and identity must stay intact.
      runtime.repository.rescheduleWebhookDelivery(deliveryId,new Date(0),"http_503");
      expect(await retried.tick()).toBe(1);expect(await retried.tick()).toBe(0);expect(captured).toHaveLength(2);
      for(const delivery of captured){
        expect(delivery.url).toBe(endpoint);expect(delivery.headers.get("x-quefa-delivery")).toBe(deliveryId);
        expect(delivery.headers.get("x-quefa-event-id")).toBe(terminal[0]!.id);
        const timestamp=Number(delivery.headers.get("x-quefa-timestamp")),signature=delivery.headers.get("x-quefa-signature")!;
        expect(verifyWebhook(timestamp,delivery.body,secret,signature)).toBe(true);
        expect(verifyWebhook(timestamp,delivery.body,foreignSecret,signature)).toBe(false);
        for(const privateValue of [rawSession,rawCdk,lookupToken])expect(delivery.body.toString()).not.toContain(privateValue);
      }
      expect(captured[1]!.body).toEqual(captured[0]!.body);
      const notification=JSON.parse(captured[1]!.body.toString()).data;
      const orderRead=await signed("GET",`/v1/orders/${orderId}`),attemptsRead=await signed("GET",`/v1/orders/${orderId}/fulfillments`);
      expect(orderRead.statusCode).toBe(200);expect(orderRead.json().data).toMatchObject({order_id:notification.order_id,payment_status:"paid",fulfillment_status:notification.status,sync_mark:notification.sync_mark});
      expect(attemptsRead.statusCode).toBe(200);
      expect(attemptsRead.json().data.find((value:{fulfillment_id:string})=>value.fulfillment_id===completedId)).toMatchObject({status:notification.status,progress_version:notification.progress_version,retry_allowed:false});
      for(const path of [`/v1/orders/${orderId}`,`/v1/orders/${orderId}/fulfillments`])expect((await signed("GET",path,undefined,true)).statusCode).toBe(404);
      expect(runtime.repository.listOutbox(foreign.id)).toHaveLength(0);
      expect(runtime.repository.listFulfillments(merchant.id,orderId)).toHaveLength(scenario==="unknown-result"?1:2);
      expect(releases()).toHaveLength(1);expect(runtime.repository.getOperations("wallet_credit",orderId)?.recognizedMinor).toBe(2_500n);
      expect(runtime.repository.listOutbox(merchant.id).filter(value=>value.eventType==="fulfillment.succeeded")).toHaveLength(1);
      expect((await app.inject({method:"POST",url:submitUrl,payload})).statusCode).toBe(409);
    }finally{await app.close();runtime.close();vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});}
  });
});

function state(status:string,id:string,lookupToken:string):UpstreamOrderState{return {orderId:"synthetic-supplier-"+id,lookupToken,status,stage:status,
  accountEmail:"synthetic@example.test",quotedAmountMinor:1576,chargedAmountMinor:1576,currency:"USD",message:status==="completed"?"充值成功":"扣款前失败"};}
