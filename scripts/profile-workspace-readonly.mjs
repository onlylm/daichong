import {DatabaseSync} from "node:sqlite";
import {performance} from "node:perf_hooks";
import {SqliteRepository} from "../dist/infra/sqlite-repository.js";
import {WalletService} from "../dist/operations/wallet.js";
import {CostAccountingService} from "../dist/operations/cost-accounting.js";
import {listWorkspaceOrders,workspaceOrderDetail} from "../dist/operations/order-view.js";
import {financeDrilldown} from "../dist/operations/finance-drilldown.js";

if(process.env.AUDIT_READ_ONLY!=="true")throw new Error("read_only_required");
const db=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
let queries=0,rows=0;
const countedDb={prepare(sql){const statement=db.prepare(sql);return {
  all(...args){queries++;const result=statement.all(...args);rows+=result.length;return result;},
  get(...args){queries++;const result=statement.get(...args);if(result)rows++;return result;},
};}};
const repo=Object.create(SqliteRepository.prototype);
Object.defineProperty(repo,"db",{value:countedDb});
repo.transaction=fn=>fn(); // Outer deferred read transaction; never requests a write lock.
const actor={id:"readonly-performance",role:"platform_admin",merchantId:null};
const wallets=new WalletService(repo,null,null),costs=new CostAccountingService(repo,null,null,false);
try{
  db.exec("BEGIN");
  const merchants=repo.listMerchants(),ids=merchants.map(m=>m.id),names=new Map(merchants.map(m=>[m.id,m.name]));
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const latest=repo.queryWorkspaceOrders(ids,{page:1,limit:1,today:day}).orders[0];
  const jobs=[
    ["orders_page",()=>listWorkspaceOrders(repo,actor,ids,names,()=>[],{page:1,limit:15})],
    ["wallet_overview",()=>wallets.adminOverview(actor)],
    ["finance_summary",()=>wallets.platformFinanceSummary(actor,7)],
    ["net_receipts_page",()=>financeDrilldown(repo,actor,{day,metric:"net_receipts",page:1,limit:20})],
    ["cost_list",()=>costs.list(actor)],
    ...(latest?[["order_detail",()=>workspaceOrderDetail(repo,actor,latest.id,[],names.get(latest.merchantId))]]:[]),
  ];
  console.log(JSON.stringify({dataCounts:db.prepare("SELECT kind,COUNT(*) n FROM sandbox_records WHERE kind IN ('order','fulfillment','merchant','audit','ops_wallet_entry') GROUP BY kind").all(),readOnly:true}));
  for(const [name,run]of jobs){const samples=[];for(let n=0;n<3;n++){queries=0;rows=0;const start=performance.now();const result=run();samples.push({ms:Number((performance.now()-start).toFixed(2)),queries,rows,responseBytes:Buffer.byteLength(JSON.stringify(result,(_,v)=>typeof v==="bigint"?String(v):v))});}console.log(JSON.stringify({name,samples}));}
  db.exec("ROLLBACK");
}finally{db.close();}
