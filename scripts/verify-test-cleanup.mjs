import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {SqliteRepository} from "../dist/infra/sqlite-repository.js";
import {confirmedTestOrders} from "../dist/operations/test-order-archive.js";
import {SupportService} from "../dist/operations/support.js";
import {AuditService} from "../dist/modules/audit-service.js";
import {NotificationService} from "../dist/modules/notifications.js";
import {listWorkspaceOrders} from "../dist/operations/order-view.js";

if (process.env.AUDIT_READ_ONLY!=="true") throw new Error("read_only_required");
const db=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
const repo=Object.create(SqliteRepository.prototype);
Object.defineProperty(repo,"db",{value:db});
const actor={id:"read-only-cleanup-check",role:"platform_admin",merchantId:null};
try {
  db.exec("BEGIN");
  const support=new SupportService(repo,new AuditService(repo)),notifications=new NotificationService(repo);
  const ids=new Set(confirmedTestOrders.map(x=>x.orderId)),ticketIds=new Set(confirmedTestOrders.map(x=>x.ticketId));
  for (const {orderId,ticketId} of confirmedTestOrders) {
    const o=repo.findOrderInternal(orderId),t=repo.getOperations("ticket",ticketId);
    assert(o?.archivedAt instanceof Date);assert(t?.archivedAt instanceof Date);assert.equal(t.status,"closed");
    assert.equal(t.orderId,o.id);assert.equal(o.paymentStatus,"paid");
    assert(repo.listFulfillments(o.merchantId,o.id).every(f=>!["queued","running","succeeded"].includes(f.status)));
  }
  assert(support.list(actor).every(t=>!ticketIds.has(t.id)));
  const tasks=notifications.tasksPage(actor,1,500);
  assert(tasks.data.every(t=>!ids.has(t.orderId)));
  const merchants=repo.listMerchants(),merchantIds=merchants.map(m=>m.id);
  const orders=listWorkspaceOrders(repo,actor,merchantIds,new Map(),()=>[],{page:1,limit:500});
  assert(orders.data.every(o=>!ids.has(o.id)));
  const totalOrders=Number(db.prepare("SELECT COUNT(*) n FROM sandbox_records WHERE kind='order'").get().n);
  const retainedLedger=Number(db.prepare(`SELECT COUNT(*) n FROM sandbox_records WHERE kind='ledger' AND json_extract(payload,'$.orderId') IN (${[...ids].map(()=>"?").join(",")})`).get(...ids).n);
  assert.equal(orders.meta.total,totalOrders-7);assert.equal(retainedLedger,28);
  console.log(JSON.stringify({archivedOrders:7,archivedTickets:7,visibleOrders:orders.meta.total,totalStoredOrders:totalOrders,
    remainingVisibleTickets:support.list(actor).length,activeTasks:tasks.meta.total,retainedLedgerRecords:retainedLedger,readOnly:true}));
  db.exec("ROLLBACK");
}finally{db.close();}
