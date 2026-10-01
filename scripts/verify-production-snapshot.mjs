import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {createRuntime} from "../dist/bootstrap.js";
import {loadConfig} from "../dist/config.js";
import {buildApp} from "../dist/app.js";
import {managedGptProducts} from "../dist/modules/gpt-products.js";

// Caller must mount a copied database, never the production state directory.
if(process.env.AUDIT_ISOLATED_SNAPSHOT!=="true")throw new Error("isolated_snapshot_required");
const config=loadConfig();
const db=new DatabaseSync(config.sqlitePath);
const financial=()=>createHash("sha256").update(JSON.stringify(db.prepare("SELECT kind,id,payload FROM sandbox_records WHERE kind IN ('order','refund','ledger','ops_wallet_entry','ops_wallet_credit','ops_wallet_deposit','ops_wallet_withdrawal') ORDER BY kind,id").all())).digest("hex");
const before=financial();
const oldCatalog=JSON.parse(db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_global_product_catalog' AND id='default'").get().payload).products;
const oldMappings=db.prepare("SELECT id,payload FROM sandbox_records WHERE kind='supplier_mapping'").all();
const oldMail=db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_mail_settings' AND id='default'").get()?.payload??null;
const runtime=createRuntime(config),app=await buildApp(config,runtime);
try{
  assert.equal((await app.inject({url:"/health/ready"})).statusCode,200);
  assert.equal((await app.inject({url:"/developers"})).statusCode,200);
  const specification=await app.inject({url:"/developers/openapi.yaml"});assert.equal(specification.statusCode,200);assert(!specification.body.includes("url: https://tibo.ink/v1"));
  assert.equal(financial(),before,"startup altered financial records");
  const current=runtime.repository.getOperations("global_product_catalog","default");
  for(const old of oldCatalog){const now=current.products.find(p=>p.productCode===old.productCode);assert(now);assert.equal(now.available,old.available);assert.equal(now.name,old.name);assert.equal(String(now.supplyPriceMinor),String(old.supplyPriceMinor.__bigint??old.supplyPriceMinor));}
  assert.equal(current.products.length,managedGptProducts.length);
  const newProducts=current.products.filter(p=>!oldCatalog.some(old=>old.productCode===p.productCode));
  assert(newProducts.every(p=>!p.available&&p.supplyPriceMinor===0n));
  for(const old of oldMappings)assert.equal(db.prepare("SELECT payload FROM sandbox_records WHERE kind='supplier_mapping' AND id=?").get(old.id).payload,old.payload);
  assert.equal(db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_mail_settings' AND id='default'").get()?.payload??null,oldMail);
  console.log(JSON.stringify({snapshotStartup:"passed",historicalFinancialRecords:"unchanged",existingProductChoices:"preserved",existingMappings:"preserved",newDrafts:newProducts.map(p=>p.productCode),mailSettings:"preserved",productionWrites:false}));
}finally{await app.close();runtime.close();db.close();}
