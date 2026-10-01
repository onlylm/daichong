import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {SqliteRepository} from "../infra/sqlite-repository.js";
import {archiveConfirmedTestOrders,confirmedTestOrders} from "../operations/test-order-archive.js";

// No application bootstrap, network client, worker, refund or wallet service is created.
if (process.env.CONFIRM_TEST_ARCHIVE!=="screenshot-seven-20260930") throw new Error("explicit_archive_confirmation_required");
if (process.env.STORAGE_DRIVER!=="sqlite" || !process.env.SQLITE_PATH) throw new Error("archive_requires_explicit_sqlite_path");
const repo=new SqliteRepository(process.env.SQLITE_PATH);
const db=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true});
const fingerprint=()=>{
  const hash=createHash("sha256");
  // Every record other than the exact selected orders/tickets and appended audits must remain byte-identical.
  const exclusions=new Set(confirmedTestOrders.flatMap(x=>["order:"+x.orderId,"ops_ticket:"+x.ticketId]));
  for (const row of db.prepare("SELECT kind,id,payload FROM sandbox_records WHERE kind!='audit' ORDER BY kind,id").all()) {
    if (exclusions.has(String(row.kind)+":"+String(row.id))) continue;
    hash.update(JSON.stringify(row));
  }
  // Financial fields of the selected orders also remain unchanged.
  for (const {orderId} of confirmedTestOrders) {
    const row=db.prepare("SELECT payload FROM sandbox_records WHERE kind='order' AND id=?").get(orderId);
    if (!row) throw new Error("archive_order_missing:"+orderId);
    const value=JSON.parse(String(row.payload));
    for (const key of ["archivedAt","archiveReason","archivedBy","updatedAt"]) delete value[key];
    hash.update(JSON.stringify(value));
  }
  return hash.digest("hex");
};
try {
  const before=fingerprint(),result=archiveConfirmedTestOrders(repo),after=fingerprint();
  if (before!==after) throw new Error("archive_unexpected_unrelated_or_financial_changes");
  console.log(JSON.stringify({...result,unchangedEvidenceHash:after}));
} finally {db.close();repo.close();}
