import {createHash, randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {queryRecords} from "../infra/record-query.js";
import {refundReconciliationId} from "../domain/provider-refund-review.js";
import type {Actor, RefundReconciliation, RefundReconciliationEvent, Ticket} from "../operations/model.js";
import {isPlatform, requirePermission} from "../operations/accounts.js";
import {AppError} from "../domain/errors.js";

type DiscrepancyInput = {merchantId:string;orderId:string;reportedMinor:bigint;recordedMinor:bigint;providerReference:string;capturedRecordedMinor?:bigint};

/** Durable finance reconciliation for ambiguous cumulative provider refunds. */
export class RefundReconciliationService {
  constructor(private readonly repository: Repository) {}

  observe(input: DiscrepancyInput): RefundReconciliation | null {
    const id=refundReconciliationId(input.orderId),now=new Date();
    const current=this.repository.getOperations("refund_reconciliation",id);
    // Provider queries are cumulative snapshots and may arrive out of order. Neither the
    // confirmed provider total nor the locally posted total may move backwards.
    const reportedMinor=current&&current.merchantId===input.merchantId
      ? bigintMax(current.reportedMinor,input.reportedMinor):input.reportedMinor;
    const recordedMinor=current&&current.merchantId===input.merchantId
      ? bigintMax(current.recordedMinor,input.recordedMinor):input.recordedMinor;
    // A signed asynchronous notification has no query-start watermark. When
    // there is no prior review and its amount is already locally booked, it is
    // only a duplicate observation of the known fact; do not manufacture a
    // discrepancy. A later aggregate query can still create one with its own
    // capturedRecordedMinor if it was stale at request time.
    if (!current && input.capturedRecordedMinor === undefined && reportedMinor <= recordedMinor) return null;
    // A query can cover only postings committed before it started. A notification
    // has no such watermark. Response arrival time cannot establish this ordering.
    const previousCovered=current?(current.snapshotCoveredRecordedMinor??current.recordedMinor):0n;
    const snapshotCoveredRecordedMinor=bigintMin(recordedMinor,bigintMax(previousCovered,input.capturedRecordedMinor??0n));
    const difference=bigintMax(reportedMinor-snapshotCoveredRecordedMinor,0n);
    const legacyTicketIds=difference>0n?this.migrateLegacyTickets(input.merchantId,input.orderId,id):[];
    const newLegacyTicketIds=legacyTicketIds.filter(ticketId=>!current?.legacyTicketIds.includes(ticketId));
    const action:RefundReconciliationEvent["action"]=difference===0n?"resolved":!current?"detected":current.status==="resolved"?"reopened":"amount_updated";
    const next:RefundReconciliation={id,merchantId:input.merchantId,orderId:input.orderId,provider:"alipay_page",status:difference>0n?"reviewing":"resolved",
      reportedMinor,recordedMinor,snapshotCoveredRecordedMinor,differenceMinor:difference,
      providerReferenceFingerprint:!current||input.reportedMinor>current.reportedMinor
        ? createHash("sha256").update(input.providerReference).digest("hex").slice(0,32):current.providerReferenceFingerprint,
      legacyTicketIds:[...new Set([...(current?.legacyTicketIds??[]),...legacyTicketIds])],version:(current?.version??0)+1,
      firstDetectedAt:current?.firstDetectedAt??now,lastCheckedAt:now,resolvedAt:difference>0n?null:current?.resolvedAt??now};
    const changed=!current||current.status!==next.status||current.reportedMinor!==next.reportedMinor||current.recordedMinor!==next.recordedMinor
      || current.snapshotCoveredRecordedMinor!==next.snapshotCoveredRecordedMinor
      || current.providerReferenceFingerprint!==next.providerReferenceFingerprint||next.legacyTicketIds.length!==(current.legacyTicketIds?.length??0);
    if(changed){
      this.repository.saveOperations("refund_reconciliation",next,!current);
      this.event(next,action);
      if(newLegacyTicketIds.length)this.event(next,"legacy_ticket_migrated");
      return next;
    }
    const checked={...current,lastCheckedAt:now,version:current.version+1};
    this.repository.saveOperations("refund_reconciliation",checked);
    return checked;
  }

  recorded(input:{merchantId:string;orderId:string;recordedMinor:bigint;reconciliationCreditMinor?:bigint}):RefundReconciliation|null {
    const id=refundReconciliationId(input.orderId),current=this.repository.getOperations("refund_reconciliation",id);
    if(!current||current.merchantId!==input.merchantId)return null;
    const recordedMinor=bigintMax(current.recordedMinor,input.recordedMinor);
    // Actual outbound success must be booked, but may be unrelated to the older
    // aggregate discrepancy. Only explicit external-refund evidence credits it.
    const credit=bigintMin(recordedMinor-current.recordedMinor,bigintMax(input.reconciliationCreditMinor??0n,0n));
    const snapshotCoveredRecordedMinor=bigintMin(recordedMinor,(current.snapshotCoveredRecordedMinor??current.recordedMinor)+credit);
    const difference=bigintMax(current.reportedMinor-snapshotCoveredRecordedMinor,0n);
    if(difference>0n){
      const updated={...current,recordedMinor,snapshotCoveredRecordedMinor,differenceMinor:difference,lastCheckedAt:new Date(),version:current.version+1};
      this.repository.saveOperations("refund_reconciliation",updated);
      if(current.recordedMinor!==updated.recordedMinor||current.differenceMinor!==updated.differenceMinor)this.event(updated,"amount_updated");
      return updated;
    }
    if(current.status==="resolved"&&current.differenceMinor===0n&&current.recordedMinor===recordedMinor
      &&current.snapshotCoveredRecordedMinor===snapshotCoveredRecordedMinor)return current;
    const resolved={...current,status:"resolved" as const,recordedMinor,snapshotCoveredRecordedMinor,differenceMinor:0n,
      lastCheckedAt:new Date(),resolvedAt:new Date(),version:current.version+1};
    this.repository.saveOperations("refund_reconciliation",resolved);
    this.event(resolved,"resolved");
    return resolved;
  }

  /**
   * One-time-compatible startup migration for databases that ran the former
   * ticket-backed refund review. It is idempotent and runs before workers can
   * evaluate the new business lock.
   */
  migrateLegacyRecords():{migrated:number;reviewing:number;resolved:number;skipped:number} {
    return this.repository.transaction(()=>{
      const groups=new Map<string,{merchantId:string;orderId:string;reportedMinor:bigint;firstDetectedAt:Date;ticketIds:string[]}>();
      let skipped=0;
      for(const ticket of this.repository.listOperations("ticket")){
        const parsed=parseLegacyIssue(ticket);
        if(!parsed)continue;
        const order=this.repository.findOrderInternal(parsed.orderId);
        if(!order||order.merchantId!==ticket.merchantId){skipped++;continue;}
        const key=`${ticket.merchantId}:${parsed.orderId}`,current=groups.get(key);
        if(current){
          current.reportedMinor=bigintMax(current.reportedMinor,parsed.reportedMinor);
          if(ticket.createdAt<current.firstDetectedAt)current.firstDetectedAt=ticket.createdAt;
          current.ticketIds.push(ticket.id);
        }else groups.set(key,{merchantId:ticket.merchantId,orderId:parsed.orderId,reportedMinor:parsed.reportedMinor,
          firstDetectedAt:ticket.createdAt,ticketIds:[ticket.id]});
      }

      let migrated=0,reviewing=0,resolved=0;
      for(const group of groups.values()){
        const order=this.repository.findOrderInternal(group.orderId)!;
        const recordedMinor=order.ordinaryRefundedMinor+order.priceAdjustmentRefundedMinor;
        const id=refundReconciliationId(group.orderId),before=this.repository.getOperations("refund_reconciliation",id);
        const beforeTickets=new Set(before?.legacyTicketIds??[]);
        let value:RefundReconciliation;
        if(group.reportedMinor>recordedMinor||before){
          value=this.observe({merchantId:group.merchantId,orderId:group.orderId,reportedMinor:group.reportedMinor,recordedMinor,
            capturedRecordedMinor:before?(before.snapshotCoveredRecordedMinor??before.recordedMinor):recordedMinor,
            providerReference:`legacy-ticket-migration:${group.orderId}:${group.reportedMinor}`})!;
        }else{
          const legacyTicketIds=this.migrateLegacyTickets(group.merchantId,group.orderId,id);
          const now=new Date();
          value={id,merchantId:group.merchantId,orderId:group.orderId,provider:"alipay_page",status:"resolved",
            reportedMinor:group.reportedMinor,recordedMinor,differenceMinor:0n,
            providerReferenceFingerprint:createHash("sha256").update(`legacy-ticket-migration:${group.orderId}:${group.reportedMinor}`).digest("hex").slice(0,32),
            legacyTicketIds,version:1,firstDetectedAt:group.firstDetectedAt,lastCheckedAt:now,resolvedAt:now};
          this.repository.saveOperations("refund_reconciliation",value,true);
          this.event(value,"legacy_ticket_migrated");
        }
        const newlyMigrated=value.legacyTicketIds.filter(ticketId=>!beforeTickets.has(ticketId)).length;
        migrated+=newlyMigrated;
        if(value.status==="reviewing")reviewing+=newlyMigrated?1:0;
        else resolved+=newlyMigrated?1:0;
      }
      return {migrated,reviewing,resolved,skipped};
    });
  }

  page(actor:Actor,page=1,limit=20,status:"reviewing"|"resolved"|"all"="reviewing"){
    requirePermission(actor,"wallet.review");
    if(!isPlatform(actor))throw new AppError(403,"permission_denied","仅平台财务可查看退款对账异常");
    return queryRecords(this.repository,"refund_reconciliation",{page,limit,orderBy:status==="reviewing"?"firstDetectedAt":"lastCheckedAt",direction:status==="reviewing"?"asc":"desc",
      ...(status==="all"?{}:{filters:[{field:"status",value:status}]})});
  }

  private event(value:RefundReconciliation,action:RefundReconciliationEvent["action"]):void {
    this.repository.saveOperations("refund_reconciliation_event",{id:`refund-reconciliation-event:${randomUUID()}`,
      merchantId:value.merchantId,reconciliationId:value.id,orderId:value.orderId,action,reportedMinor:value.reportedMinor,
      recordedMinor:value.recordedMinor,differenceMinor:value.differenceMinor,
      snapshotCoveredRecordedMinor:value.snapshotCoveredRecordedMinor??value.recordedMinor,createdAt:new Date()},true);
  }

  /** Resolve legacy system cases but retain every ticket/message for audit. */
  private migrateLegacyTickets(merchantId:string,orderId:string,reconciliationId:string):string[] {
    const prefix=`refund-reconcile:${orderId}:`,tickets=this.repository.listOperations("ticket",merchantId)
      .filter(ticket=>ticket.orderId===orderId&&ticket.createdBy==="system"&&(ticket.systemCase?.issueKey??"").startsWith(prefix));
    for(const ticket of tickets){
      if(["open","in_progress","waiting_agent"].includes(ticket.status)){
        const updated:Ticket={...ticket,status:"resolved",version:ticket.version+1,publicVersion:ticket.publicVersion+1,updatedAt:new Date()};
        this.repository.saveOperations("ticket",updated);
      }
      const noteId=`${ticket.id}:refund-reconciliation-migrated`;
      if(!this.repository.getOperations("ticket_message",noteId))this.repository.saveOperations("ticket_message",{
        id:noteId,merchantId,ticketId:ticket.id,actorId:"system",author:"platform",internal:true,
        body:`退款差异业务状态已迁移到独立财务核对记录 ${reconciliationId}；本工单及既有消息仅保留历史追溯，不再控制履约。`,createdAt:new Date()},true);
    }
    return tickets.map(ticket=>ticket.id);
  }
}

function bigintMax(left:bigint,right:bigint):bigint{return left>right?left:right;}
function bigintMin(left:bigint,right:bigint):bigint{return left<right?left:right;}

function parseLegacyIssue(ticket:Ticket):{orderId:string;reportedMinor:bigint}|null {
  if(ticket.createdBy!=="system")return null;
  const match=/^refund-reconcile:(.+):(\d+)$/.exec(ticket.systemCase?.issueKey??"");
  if(!match)return null;
  return {orderId:match[1]!,reportedMinor:BigInt(match[2]!)};
}
