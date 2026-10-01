import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createRuntime} from "../dist/bootstrap.js";
import {loadConfig} from "../dist/config.js";
import {preparePro50x} from "../dist/cli/prepare-pro-50x.js";
import {managedGptProducts} from "../dist/modules/gpt-products.js";
import {listGlobalWorkspaceProducts,saveGlobalWorkspaceProduct} from "../dist/operations/global-product-catalog.js";
import {ZovoCardRechargeProvider} from "../dist/upstream/zovocard-provider.js";
import {SensitivePayloadCipher} from "../dist/infra/crypto.js";
import {signRequest} from "../dist/auth/signature.js";
import {buildApp} from "../dist/app.js";

const config=loadConfig({NODE_ENV:"test",STORAGE_DRIVER:"memory",LOG_LEVEL:"silent",PUBLIC_BASE_URL:"https://example.test"});
const runtime=createRuntime(config),repo=runtime.repository,code="chatgpt_pro_50x_cdk_1m";
const credential=repo.findCredential(config.demoPartnerId,config.demoKeyId),mid=credential.merchant.id;
const tenant={merchantId:mid,partnerId:credential.merchant.partnerId,appId:credential.app.id,keyId:credential.key.keyId};
const conn=repo.findSupplierConnection("supplier_primary");
repo.saveSupplierConnection({...conn,enabled:true,secretPayload:new SensitivePayloadCipher(config.dataEncryptionKey,config.keyEncryptionKeyId).encrypt({apiKey:"fixture-key"},"supplier-connection:"+conn.id)});
const oldMapping=structuredClone(repo.findSupplierProductMapping("chatgpt_pro_20x_cdk_1m"));
const oldProducts=structuredClone(repo.getOperations("global_product_catalog","default").products.filter(p=>p.productCode!==code));
let checks=0;
async function check(name,fn){await fn();checks++;console.log("PASS "+name);}
let purchasable=true,issued=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{
 const path=new URL(String(url)).pathname;
 if(path.endsWith("/gpt-direct/plans")){
   assert.equal(init.method,"GET");
   return Response.json({code:0,data:{version:263,payment_regions:[{country:"PH",currency:"PHP"}],
     plans:{pro_50x:{enabled:true}},registry:[{key:"pro_50x",product:"gpt",acc_plan_key:"pro_50x",label:"Pro 50x",flow:"direct",
       checkout_currency:"PHP",checkout_amount_minor:2900893,is_credit:false,purchasable,service_fee_usd_minor:15}]}});
 }
 if(path.endsWith("/gpt-direct/cdks")){
   assert.equal(init.method,"POST");const body=JSON.parse(init.body);
   assert.equal(body.plan,"pro_50x");assert.equal(body.payment_country,"PH");assert.equal(body.payment_currency,"PHP");
   assert.equal(body.count,1);assert.equal(body.funding_confirmed,true);assert(init.headers["Idempotency-Key"].startsWith("quefa-cdk-"));
   return Response.json({code:0,data:{issued:[{id:String(++issued),code:"fixture-private-"+issued}]}});
 }
 throw new Error("unexpected_network_path");
};
let app;
try{
 await check("50x starts unpublished, unpriced, and unavailable to all agents",()=>{
   const p=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code===code);
   assert.equal(p.configuredAvailable,false);assert.equal(p.supplyPrice,"0.00");assert.equal(p.mappingEnabled,false);
   for(const merchant of repo.listMerchants()){assert(repo.findProductGrant(merchant.id,code));assert(!runtime.catalog.list(merchant.id).some(p=>p.productCode===code));}
 });
 await check("50x cannot match 5x, 20x, renewal, or credit plans",()=>{
   const definition=managedGptProducts.find(p=>p.productCode===code);
   for(const key of ["pro_5x","pro_20x","pro_20x_renew","credit5000"])assert.equal(definition.matchPlan({product:"gpt",plan:key,accPlanKey:key,name:key}),false);
   assert.equal(definition.matchPlan({product:"gpt",plan:"pro_50x",accPlanKey:"pro_50x",name:"Pro 50x"}),true);
 });
 await check("unavailable upstream blocks preparation without mutation",async()=>{
   const before=structuredClone(repo.listSupplierProductMappings());purchasable=false;
   await assert.rejects(preparePro50x(config,repo),/philippines_pro_50x_not_confirmed/);
   assert.deepEqual(repo.listSupplierProductMappings(),before);purchasable=true;
 });
 await check("preparing PH supply enables only 50x mapping and preserves all prices",async()=>{
   const ready=await preparePro50x(config,repo);
   assert.equal(ready.paymentCountry,"PH");assert.equal(ready.mappingEnabled,true);assert.equal(ready.published,false);
   assert.deepEqual(repo.findSupplierProductMapping("chatgpt_pro_20x_cdk_1m"),oldMapping);
   assert.deepEqual(repo.getOperations("global_product_catalog","default").products.filter(p=>p.productCode!==code),oldProducts);
   const version=repo.findSupplierProductMapping(code).version;await preparePro50x(config,repo);
   assert.equal(repo.findSupplierProductMapping(code).version,version);
 });
 await check("upstream mapping does not bypass missing price or publish flag",()=>{
   const p=listGlobalWorkspaceProducts(repo,runtime.catalog).find(p=>p.code===code);
   assert(p.blockers.some(b=>b.code==="price_missing"));assert(p.blockers.some(b=>b.code==="unpublished"));
   assert.throws(()=>saveGlobalWorkspaceProduct(repo,code,{name:p.name,supplyPriceMinor:0n,available:true,priceVersion:p.priceVersion},runtime.catalog));
   assert(!runtime.catalog.list(mid).some(p=>p.productCode===code));
   saveGlobalWorkspaceProduct(repo,code,{name:p.name,supplyPriceMinor:100n,available:true,priceVersion:p.priceVersion},runtime.catalog);
   runtime.supplierManagement.seed(config);assert.equal(repo.findSupplierProductMapping(code).enabled,true);
   assert.equal(runtime.catalog.requireGrant(mid,code).upstreamPlan,"pro_50x");
 });
 repo.saveOperations("api_access",{id:mid,merchantId:mid,enabled:true,depositId:"tier:gold",ticketId:"",version:1,updatedAt:new Date()});
 app=await buildApp(config,runtime);
 const get=async path=>{
   const input={method:"GET",path,rawQuery:"",timestamp:String(Math.floor(Date.now()/1000)),nonce:randomUUID(),keyId:config.demoKeyId,idempotencyKey:"",rawBody:Buffer.alloc(0)};
   return app.inject({url:path,headers:{"X-Partner-Id":config.demoPartnerId,"X-Key-Id":input.keyId,"X-Timestamp":input.timestamp,"X-Nonce":input.nonce,"X-Signature":signRequest(input,config.demoClientSecret)}});
 };
 await check("public products exposes both delivery modes after publication",async()=>{
   const response=await get("/v1/products");assert.equal(response.statusCode,200);
   const p=response.json().data.find(p=>p.product_code===code);assert(p);assert.deepEqual(p.delivery_modes,["auto_recharge","cdk"]);
 });
 const provider=new ZovoCardRechargeProvider(conn.openApiBase,conn.cdkBase,"fixture-key",null);
 runtime.upstream.issueCdk=provider.issueCdk.bind(provider);
 for(const mode of ["cdk","auto_recharge"]){
   await check("PH 50x "+mode+" uses correct supplier request and completes its CDK task",async()=>{
     const order=await runtime.orders.create(tenant,{merchantOrderNo:"ph50-"+mode,productCode:code,quantity:1,saleAmount:"1.00",deliveryMode:mode});
     assert.equal(order.fulfillmentMode,"cdk");assert.equal(order.upstreamPlan,"pro_50x");
     runtime.payment.markPaid(mid,order.id,{providerRef:"fixture-"+mode,receivedMinor:100n});
     await runtime.cdk.issueOne();const voucher=repo.findCdkVoucherByOrder(order.id);assert.equal(voucher.status,"unused");
     const response=await get("/v1/orders/"+order.id);assert.equal(response.statusCode,200);
     assert.equal(response.json().data.voucher_code,mode==="cdk"?voucher.publicCode:null);assert(!response.body.includes("fixture-private-"));
     const task=runtime.fulfillments.createCdkPublic(repo.findOrder(mid,order.id),voucher,runtime.cdk.readUpstreamCode(voucher),{mode:"session",session:"fixture-only"});
     assert.equal(task.orderId,order.id);assert.equal(voucher.plan,"pro_50x");await runtime.fulfillments.processOne();
     assert.equal(repo.findFulfillment(mid,task.id).status,"succeeded");assert.equal(repo.findCdkVoucherByOrder(order.id).status,"consumed");
   });
 }
 assert.equal(issued,2);
 console.log(JSON.stringify({passed:checks,network:"stubbed plus container network disabled",productionWrites:false}));
}finally{globalThis.fetch=originalFetch;if(app)await app.close();runtime.close();}
