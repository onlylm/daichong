import {randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {signRequest} from "../src/auth/signature.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
import type {Order} from "../src/domain/model.js";

describe("partner API cursor pagination",()=>{
  const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"sqlite",SQLITE_PATH:":memory:",LOG_LEVEL:"silent"});
  let runtime:ReturnType<typeof createRuntime>,app:Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async()=>{runtime=createRuntime(config);publishTestRechargeProduct(runtime);app=await buildApp(config,runtime);});
  afterEach(async()=>{vi.restoreAllMocks();await app.close();runtime.close();});

  async function get(url:string){
    const separator=url.indexOf("?"),path=separator<0?url:url.slice(0,separator),rawQuery=separator<0?"":url.slice(separator+1);
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID(),rawBody=Buffer.alloc(0);
    return app.inject({method:"GET",url,headers:{"x-partner-id":config.demoPartnerId,"x-key-id":config.demoKeyId,
      "x-timestamp":timestamp,"x-nonce":nonce,"x-signature":signRequest({method:"GET",path,rawQuery,timestamp,nonce,
        keyId:config.demoKeyId,idempotencyKey:"",rawBody},config.demoClientSecret)}});
  }

  it("pages orders, ledger entries and settlements in SQLite without full-list fallbacks",async()=>{
    const credential=runtime.repository.findCredential(config.demoPartnerId,config.demoKeyId)!,tenant={merchantId:credential.merchant.id,
      appId:credential.app.id,keyId:credential.key.keyId,partnerId:credential.merchant.partnerId};
    const orders:Order[]=[];
    for(let index=0;index<5;index++){
      const order=await runtime.orders.create(tenant,{merchantOrderNo:`PUBLIC-PAGE-${index}`,productCode:"chatgpt_plus_cdk_1m",quantity:1,saleAmount:"135.00"});
      const createdAt=new Date(Date.UTC(2026,8,1,index));
      runtime.repository.updateOrder({...order,createdAt,expiresAt:new Date(createdAt.getTime()+900_000)});
      if(index>=3)runtime.payment.markPaid(order.merchantId,order.id,{providerRef:`public-page-paid-${index}`,receivedMinor:order.saleAmountMinor});
      orders.push(runtime.repository.findOrderInternal(order.id)!);
    }
    const historicBase=Date.parse("2025-01-01T00:00:00.000Z");
    runtime.repository.appendLedger(Array.from({length:5},(_,index)=>({id:`ledger-public-${index}`,merchantId:tenant.merchantId,
      orderId:orders[0]!.id,type:"user_payment" as const,amountMinor:BigInt(100+index),direction:"increase" as const,
      occurredAt:new Date(historicBase+index*1_000)})));
    for(let index=0;index<4;index++)runtime.repository.insertSettlement({id:`st_public_${index}`,merchantId:tenant.merchantId,
      periodFrom:new Date(historicBase),periodTo:new Date(historicBase+86_400_000),status:"draft",grossMinor:100n,
      adjustmentMinor:0n,payableMinor:100n,currency:"CNY",sealedAt:null,paidAt:null,
      createdAt:new Date(historicBase+index*1_000),lines:[]});
    for(let index=0;index<5;index++){
      const createdAt=new Date(historicBase+index*1_000);
      runtime.repository.saveOperations("wallet_entry",{id:`wallet-public-${index}`,merchantId:tenant.merchantId,kind:"adjustment",
        procurementDelta:BigInt(index+1),earningsDelta:0n,frozenDelta:0n,reference:`wallet-page-${index}`,actorId:"test",createdAt},true);
      runtime.repository.saveOperations("ticket",{id:`ticket-public-${index}`,merchantId:tenant.merchantId,orderId:null,title:`分页工单 ${index}`,
        category:"other",status:"open",assigneeId:null,version:1,publicVersion:1,createdBy:"agent-api",createdAt,updatedAt:createdAt},true);
    }

    const fullOrders=vi.spyOn(runtime.repository,"listOrders"),fullLedger=vi.spyOn(runtime.repository,"listLedger"),
      fullSettlements=vi.spyOn(runtime.repository,"listSettlements"),fullOperations=vi.spyOn(runtime.repository,"listOperations");
    const firstOrders=await get("/v1/orders?limit=2"),firstOrderBody=firstOrders.json();
    expect(firstOrders.statusCode).toBe(200);expect(firstOrderBody.data).toHaveLength(2);expect(firstOrderBody.next_cursor).toBeTruthy();
    const secondOrders=(await get(`/v1/orders?limit=2&cursor=${encodeURIComponent(firstOrderBody.next_cursor)}`)).json();
    expect(secondOrders.data).toHaveLength(2);expect(secondOrders.data.map((item:{order_id:string})=>item.order_id))
      .not.toContain(firstOrderBody.data[0].order_id);
    const paid=(await get("/v1/orders?payment_status=paid&limit=10")).json();
    expect(paid.data).toHaveLength(2);expect(paid.data.every((item:{payment_status:string})=>item.payment_status==="paid")).toBe(true);
    expect((await get("/v1/orders?cursor=missing-order&limit=2")).json().error.code).toBe("invalid_cursor");

    const ledgerUrl="/v1/ledger?from=2025-01-01T00%3A00%3A00.000Z&to=2025-01-02T00%3A00%3A00.000Z&limit=2";
    const firstLedger=(await get(ledgerUrl)).json();expect(firstLedger.data).toHaveLength(2);expect(firstLedger.next_cursor).toBeTruthy();
    const secondLedger=(await get(`${ledgerUrl}&cursor=${firstLedger.next_cursor}`)).json();expect(secondLedger.data).toHaveLength(2);
    expect((await get("/v1/ledger?cursor=missing-ledger&limit=2")).json().error.code).toBe("invalid_cursor");

    const firstSettlements=(await get("/v1/settlements?limit=2")).json();
    expect(firstSettlements.data).toHaveLength(2);expect(firstSettlements.next_cursor).toBeTruthy();
    const secondSettlements=(await get(`/v1/settlements?limit=2&cursor=${firstSettlements.next_cursor}`)).json();
    expect(secondSettlements.data).toHaveLength(2);expect(secondSettlements.next_cursor).toBeNull();
    expect((await get("/v1/settlements?cursor=missing-settlement&limit=2")).json().error.code).toBe("invalid_cursor");
    const tickets=(await get("/v1/tickets?status=open&page=2&limit=2")).json();
    expect(tickets.data).toHaveLength(2);expect(tickets.meta).toMatchObject({total:5,page:2,limit:2,pages:3});
    const wallet=(await get("/v1/wallet?page=2&limit=2")).json();
    expect(wallet.entries).toHaveLength(2);expect(wallet.entries_meta).toMatchObject({total:5,page:2,limit:2,pages:3});
    expect(fullOrders).not.toHaveBeenCalled();expect(fullLedger).not.toHaveBeenCalled();expect(fullSettlements).not.toHaveBeenCalled();
    expect(fullOperations).not.toHaveBeenCalled();
  });
});
