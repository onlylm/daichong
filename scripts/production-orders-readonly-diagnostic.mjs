// Run only inside the API container. This intentionally avoids runtime bootstrap, schema writes and secrets.
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {SqliteRepository} from '/app/dist/infra/sqlite-repository.js';
import {listWorkspaceOrders} from '/app/dist/operations/order-view.js';

const db = new DatabaseSync('/app/data/production.sqlite', {readOnly: true});
try {
  db.exec('PRAGMA query_only=ON; BEGIN;');
  const repository = Object.create(SqliteRepository.prototype);
  repository.db = db;
  repository.transactionDepth = 0;
  const merchants = repository.listMerchants();
  const ids = merchants.map(m => m.id);
  const names = new Map(merchants.map(m => [m.id, m.name]));
  const counts = db.prepare("SELECT kind,count(*) AS n FROM sandbox_records WHERE kind IN ('order','fulfillment','cdk_voucher','ops_order_cost','ops_cost_saving_payment') GROUP BY kind").all();
  let sql = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (...args) => { sql++; return prepare(...args); };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    sql = 0;
    const start = performance.now();
    const result = listWorkspaceOrders(repository, {id: 'readonly-diagnostic', role: 'platform_admin', merchantId: null}, ids, names, () => [], {page: 1, limit: 20});
    samples.push({ms: Number((performance.now() - start).toFixed(2)), sql, rows: result.data.length, total: result.meta.total});
  }
  console.log(JSON.stringify({merchants: ids.length, counts, samples}));
  db.exec('ROLLBACK;');
} finally {
  db.close();
}
