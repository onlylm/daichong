import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SqliteRepository} from "../dist/infra/sqlite-repository.js";
import {financeDrilldown} from "../dist/operations/finance-drilldown.js";
import {moneyToMinor} from "../dist/domain/money.js";
import {financeWorkspaceJs} from "../dist/operations/finance-ui.js";

// No runtime bootstrap, sessions, worker, migration or financial mutation.
if (process.env.AUDIT_READ_ONLY !== "true") throw new Error("read_only_audit_required");
const db = new DatabaseSync(process.env.SQLITE_PATH, {readOnly: true});
// Bind existing read methods without running the constructor's schema writes.
const repo = Object.create(SqliteRepository.prototype);
Object.defineProperty(repo, "db", {value: db});
const actor = {id: "read-only-release-check", role: "platform_admin", merchantId: null};
try {
  db.exec("BEGIN");
  const catalog = repo.getOperations("global_product_catalog", "default");
  const codes = ["chatgpt_plus_cdk_1m", "chatgpt_pro_5x_cdk_1m", "chatgpt_pro_20x_cdk_1m", "chatgpt_pro_50x_cdk_1m"];
  assert.deepEqual(codes.map(code => {
    const p = catalog.products.find(p => p.productCode === code);
    return [String(p.supplyPriceMinor), String(p.refundBenchmarkUsdMinor)];
  }), [["11000", "1576"], ["63800", "9298"], ["100000", "14312"], ["325000", "46544"]]);
  assert(catalog.products.filter(p => !codes.includes(p.productCode)).every(p => !p.available));
  assert(repo.getOperations("service_checkpoint", "subscription-pricing-20260930-v1"));
  const day = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  const from = new Date(day + "T00:00:00+08:00").toISOString();
  const to = new Date(Date.parse(from) + 86400000).toISOString();
  const summary = repo.financeWindow(from, to).daily[0];
  let net = 0n, margin = 0n;
  const netPage = financeDrilldown(repo, actor, {day, metric: "net_receipts", page: 1, limit: 20});
  for (let page = 1; page <= netPage.meta.pages; page++) {
    for (const row of financeDrilldown(repo, actor, {day, metric: "net_receipts", page, limit: 20}).data) {
      net += moneyToMinor(row.netReceipts);
      margin += moneyToMinor(row.margin);
    }
  }
  const aggregateNet = summary ? BigInt(summary.saleAmountMinor) - BigInt(summary.ordinaryRefundedMinor) - BigInt(summary.priceAdjustmentRefundedMinor) : 0n;
  assert.equal(net, aggregateNet);
  assert.equal(margin, BigInt(summary?.marginMinor ?? 0));
  const marginPage = financeDrilldown(repo, actor, {day, metric: "margin", page: 1, limit: 20});
  let commission = 0n;
  for (let page = 1; page <= marginPage.meta.pages; page++) {
    for (const row of financeDrilldown(repo, actor, {day, metric: "margin", page, limit: 20}).data) commission += moneyToMinor(row.margin);
  }
  assert.equal(commission, margin);
  assert(financeWorkspaceJs.includes('()=>openFinanceMetric(metric,today.day)'));
  assert(financeWorkspaceJs.includes('dialog.showModal();await read()'));
  console.log(JSON.stringify({pricing: "passed",financeDetailTotals: "match_summary",financeDetailPagination: "passed",liveRecordsChanged: false,netReceiptsRows: netPage.meta.total,commissionRows: marginPage.meta.total}));
  db.exec("ROLLBACK");
} finally { db.close(); }
