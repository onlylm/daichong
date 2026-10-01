import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {createRuntime} from "../dist/bootstrap.js";
import {loadConfig} from "../dist/config.js";
import {buildApp} from "../dist/app.js";
import {applySubscriptionPricing} from "../dist/operations/subscription-pricing.js";
import {financeDrilldown} from "../dist/operations/finance-drilldown.js";
import {listWorkspaceOrders} from "../dist/operations/order-view.js";
import {moneyToMinor} from "../dist/domain/money.js";

if(process.env.AUDIT_ISOLATED_SNAPSHOT!=="true")throw new Error("isolated_snapshot_required");
const cfg=loadConfig(),db=new DatabaseSync(cfg.sqlitePath);
const financial=()=>createHash("sha256").update(JSON.stringify(db.prepare("SELECT kind,id,payload FROM sandbox_records WHERE kind IN ('order','refund','ledger','ops_wallet_entry','ops_wallet_credit','ops_wallet_deposit','ops_wallet_withdrawal','ops_order_cost','ops_cost_saving_payment') ORDER BY kind,id").all())).digest("hex");
const before=financial();
const oldCatalog=JSON.parse(db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_global_product_catalog' AND id='default'").get().payload).products;
const oldMail=db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_mail_settings' AND id='default'").get()?.payload??null;
const runtime=createRuntime(cfg),app=await buildApp(cfg,runtime),actor={id:"isolated-check",role:"platform_admin",merchantId:null};
try {
  assert.equal(financial(),before,"startup changed financial history");
  assert.equal((await app.inject({url:"/health/ready"})).statusCode,200);
  assert.equal((await app.inject({url:"/developers"})).statusCode,200);
  assert.equal((await app.inject({url:"/developers/openapi.yaml"})).statusCode,200);
  assert.equal((await app.inject({url:"/workspace/api/finance/details?day=2026-09-30&metric=margin"})).statusCode,401);
  assert.equal(applySubscriptionPricing(runtime.repository).applied,true);
  assert.equal(applySubscriptionPricing(runtime.repository).applied,false);
  const catalog=runtime.repository.getOperations("global_product_catalog","default"),codes=["chatgpt_plus_cdk_1m","chatgpt_pro_5x_cdk_1m","chatgpt_pro_20x_cdk_1m","chatgpt_pro_50x_cdk_1m"];
  assert.deepEqual(codes.map(code=>{const p=catalog.products.find(p=>p.productCode===code);return [String(p.supplyPriceMinor),String(p.refundBenchmarkUsdMinor)];}),
    [["11000","1576"],["63800","9298"],["100000","14312"],["325000","46544"]]);
  for(const code of codes){const old=oldCatalog.find(p=>p.productCode===code),p=catalog.products.find(p=>p.productCode===code);if(old)assert.equal(p.available,old.available);}
  assert(catalog.products.filter(p=>!codes.includes(p.productCode)).every(p=>!p.available));
  assert.equal(financial(),before,"commercial migration changed financial history");
  const merchants=runtime.repository.listMerchants(),ids=merchants.map(m=>m.id);
  const page=listWorkspaceOrders(runtime.repository,actor,ids,new Map(merchants.map(m=>[m.id,m.name])),()=>[],{page:1,limit:20});
  assert(page.data.length<=20);assert.equal(page.meta.total,Number(db.prepare("SELECT COUNT(*) n FROM sandbox_records WHERE kind='order'").get().n));
  const summary=runtime.wallets.platformFinanceSummary(actor,7),detail=financeDrilldown(runtime.repository,actor,{day:summary.today.day,metric:"net_receipts",page:1,limit:100});
  assert.equal(detail.meta.total,summary.today.platformCollectOrders);
  let net=0n,margin=0n;
  for(let n=1;n<=detail.meta.pages;n++)for(const row of financeDrilldown(runtime.repository,actor,{day:summary.today.day,metric:"net_receipts",page:n,limit:100}).data){net+=moneyToMinor(row.netReceipts);margin+=moneyToMinor(row.margin);}
  assert.equal(net,moneyToMinor(summary.today.netSaleAmount));assert.equal(margin,moneyToMinor(summary.today.marginAmount));
  assert.throws(()=>runtime.notifications.settings(actor),e=>e.code==="email_notifications_removed");
  assert.equal(db.prepare("SELECT payload FROM sandbox_records WHERE kind='ops_mail_settings' AND id='default'").get()?.payload??null,oldMail);
  assert.equal(financial(),before,"read-only queries changed financial history");
  console.log(JSON.stringify({snapshotStartup:"passed",commercialMigration:"passed",historicalFinancialRecords:"unchanged",publicationChoices:"preserved",financeDrilldown:"matches_summary",orders:page.meta.total,emailTransport:"removed",productionWrites:false}));
}finally{await app.close();runtime.close();db.close();}
