import {createHash, randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {queryRecords} from "../infra/record-query.js";
import {refundReconciliationId} from "../domain/provider-refund-review.js";
import type {Actor, RefundReconciliation, RefundReconciliationEvent, Ticket} from "../operations/model.js";
import {isPlatform, requirePermission} from "../operations/accounts.js";
import {AppError} from "../domain/errors.js";

type DiscrepancyInput = {merchantId:string;orderId:string;reportedMinor:bigint;recordedMinor:bigint;providerReference:string};

/** Durable finance reconciliation for ambiguous cumulative provider refunds. */
export class RefundReconciliationService {
  constructor(private readonly repository: Repository) {}

  observe(input: DiscrepancyInput): RefundReconciliation {
    const id=refundReconciliationId(input.orderId),now=new Date(),difference=input.reportedMinor-input.recordedMinor;
    if(difference<=0n) return this.recorded({merchantId:input.merchantId,orderId:input.orderId,recordedMinor:input.recordedMinor})
      ?? this.snapshotResolved(input,now);
    const current=this.repository.getOperations("refund_reconciliation",id);
    const legacyTicketIds=this.migrateLegacyTickets(input.merchantId,input.orderId,id);
    const action:RefundReconciliationEvent["action"]=!current?"detected":current.status==="resolved"?"reopened":"amount_updated";
    const next:RefundReconciliation={id,merchantId:input.merchantId,orderId:input.orderId,provider:"alipay_page",status:"reviewing",
      reportedMinor:input.reportedMinor,recordedMinor:input.recordedMinor,differenceMinor:difference,
      providerReferenceFingerprint:createHash("sha256").update(input.providerReference).digest("hex").slice(0,32),
      legacyTicketIds:[...new Set([...(current?.legacyTicketIds??[]),...legacyTicketIds])],version:(current?.version??0)+1,
      firstDetectedAt:current?.firstDetectedAt??now,lastCheckedAt:now,resolvedAt:null};
    const changed=!current||current.status!==next.status||current.reportedMinor!==next.reportedMinor||current.recordedMinor!==next.recordedMinor
      || current.providerReferenceFingerprint!==next.providerReferenceFingerprint||next.legacyTicketIds.length!==(current.legacyTicketIds?.length??0);
    if(changed){
      this.repository.saveOperations("refund_reconciliation",next,!current);
      this.event(next,action);
      if(legacyTicketIds.length)this.event(next,"legacy_ticket_migrated");
      return next;
    }
    const checked={...current,lastCheckedAt:now,version:current.version+1};
    this.repository.saveOperations("refund_reconciliation",checked);
    return checked;
  }

  recorded(input:{merchantId:string;orderId:string;recordedMinor:bigint}):RefundReconciliation|null {
    const id=refundReconciliationId(input.orderId),current=this.repository.getOperations("refund_reconciliation",id);
    if(!current||current.merchantId!==input.merchantId)return null;
    const difference=current.reportedMinor-input.recordedMinor;
    if(difference>0n){
      const updated={...current,recordedMinor:input.recordedMinor,differenceMinor:difference,lastCheckedAt:new Date(),version:current.version+1};
      this.repository.saveOperations("refund_reconciliation",updated);
      if(current.recordedMinor!==updated.recordedMinor||current.differenceMinor!==updated.differenceMinor)this.event(updated,"amount_updated");
      return updated;
    }
    if(current.status==="resolved"&&current.differenceMinor===0n)return current;
    const resolved={...current,status:"resolved" as const,recordedMinor:input.recordedMinor,differenceMinor:0n,
      lastCheckedAt:new Date(),resolvedAt:new Date(),version:current.version+1};
    this.repository.saveOperations("refund_reconciliation",resolved);
    this.event(resolved,"resolved");
    return resolved;
  }

  page(actor:Actor,page=1,limit=20,status:"reviewing"|"resolved"|"all"="reviewing"){
    requirePermission(actor,"wallet.review");
    if(!isPlatform(actor))throw new AppError(403,"permission_denied","仅平台财务可查看退款对账异常");
    return queryRecords(this.repository,"refund_reconciliation",{page,limit,orderBy:"lastCheckedAt",direction:"desc",
      ...(status==="all"?{}:{filters:[{field:"status",value:status}]})});
  }

  private snapshotResolved(input:DiscrepancyInput,now:Date):RefundReconciliation {
    return {id:refundReconciliationId(input.orderId),merchantId:input.merchantId,orderId:input.orderId,provider:"alipay_page",
      status:"resolved",reportedMinor:input.reportedMinor,recordedMinor:input.recordedMinor,differenceMinor:0n,
      providerReferenceFingerprint:createHash("sha256").update(input.providerReference).digest("hex").slice(0,32),legacyTicketIds:[],
      version:0,firstDetectedAt:now,lastCheckedAt:now,resolvedAt:now};
  }

  private event(value:RefundReconciliation,action:RefundReconciliationEvent["action"]):void {
    this.repository.saveOperations("refund_reconciliation_event",{id:`refund-reconciliation-event:${randomUUID()}`,
      merchantId:value.merchantId,reconciliationId:value.id,orderId:value.orderId,action,reportedMinor:value.reportedMinor,
      recordedMinor:value.recordedMinor,differenceMinor:value.differenceMinor,createdAt:new Date()},true);
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
