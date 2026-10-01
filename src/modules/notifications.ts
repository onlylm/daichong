import {createHash} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import type {Actor, OperationalIssue, Ticket} from "../operations/model.js";
import {isPlatform, requirePermission} from "../operations/accounts.js";
import {canResubmitFulfillment} from "../domain/recharge-policy.js";
import {latestFulfillmentOf} from "../domain/order-sync-mark.js";
import {queryRecords, type QueryRecords, type RecordFilter} from "../infra/record-query.js";

type Issue = {key: string; entityId: string; merchantId: string; orderId: string; kind: "recharge"|"cdk"|"refund"; message: string; retryAllowed: boolean};

export class NotificationService {
  private lastTick = 0;
  constructor(private readonly repo: Repository) {}

  tasks(actor: Actor) {return this.tasksPage(actor).data;}
  tasksPage(actor: Actor, page = 1, limit = 30) {
    requirePermission(actor, "tickets.read");
    const result = queryRecords(this.repo, "operational_issue", {page, limit,
      ...(isPlatform(actor) ? {} : {merchantId: actor.merchantId!}),
      filters: [{field:"status",value:"open"}],orderBy:"attentionKey",direction:"asc",
    });
    return {...result,data:result.data.map(issue=>({key:issue.id,orderId:issue.orderId,merchantId:issue.merchantId,
      kind:issue.kind,message:issue.reason,issueId:issue.id,status:issue.status,retryAllowed:issue.retryAllowed,
      priority:issue.severity,dueAt:issue.dueAt,overdue:issue.dueAt.getTime()<=Date.now(),createdAt:issue.firstDetectedAt}))};
  }

  /** Each worker pass reads at most 100 records per queue. A durable cursor prevents starvation. */
  private batch<K extends keyof QueryRecords>(kind: K, queue: string, filters: RecordFilter[]) {
    const id = "case-scan:" + queue, checkpoint = this.repo.getOperations("service_checkpoint", id);
    const result = queryRecords(this.repo, kind, {limit:100, count:false, orderBy:"id", direction:"asc",
      ...(checkpoint?.afterId ? {afterId:checkpoint.afterId} : {}), filters});
    const last = result.data.at(-1) as {id?:string}|undefined;
    this.repo.saveOperations("service_checkpoint", {id, merchantId:null, createdAt:checkpoint?.createdAt??new Date(),
      afterId:result.data.length===100 ? last?.id??null : null});
    return result.data;
  }

  async tick(): Promise<void> {
    if (Date.now()-this.lastTick<10_000) return;
    this.lastTick=Date.now();
    this.repo.transaction(() => {
      this.migrateLegacyCasesLocked();
      for (const task of this.batch("fulfillment", "recharge", [{field:"status",op:"in",value:["queued","running","failed"]}])) {
        const order=this.repo.findOrder(task.merchantId,task.orderId);
        if (!order || order.archivedAt || !["paid","partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor>0n) continue;
        if (latestFulfillmentOf(this.repo.listFulfillments(task.merchantId,task.orderId))?.id!==task.id) continue;
        if (["queued","running"].includes(task.status) && Date.now()-task.createdAt.getTime()<600_000) continue;
        const retryAllowed=canResubmitFulfillment(task);
        this.openIssue({key:"task:"+task.id,entityId:task.id,merchantId:task.merchantId,orderId:task.orderId,kind:"recharge",retryAllowed,
          message:retryAllowed?"充值已明确失败，请核对资料后在原订单重新提交":"充值结果尚未确认，请等待平台核对，不要重复下单"});
      }
      for (const order of this.batch("order", "cdk", [{field:"paymentStatus",value:"paid"},{field:"fulfillmentMode",value:"cdk"},
        {field:"archivedAt",op:"is_null"},
        {field:"voucherCode",op:"is_null"},{field:"paidAt",op:"lte",value:new Date(Date.now()-300_000)}])) {
        if (order.ordinaryRefundedMinor>0n || this.repo.listFulfillments(order.merchantId,order.id).length) continue;
        this.openIssue({key:"cdk:"+order.id,entityId:order.id,merchantId:order.merchantId,orderId:order.id,kind:"cdk",retryAllowed:false,
          message:"兑换码签发尚未完成，请勿重复采购，平台将核对供应状态"});
      }
      for (const refund of this.batch("refund", "refund", [{field:"status",op:"in",value:["failed","processing"]}])) {
        if (this.repo.findOrder(refund.merchantId,refund.orderId)?.archivedAt) continue;
        if (refund.status==="processing" && Date.now()-refund.createdAt.getTime()<300_000) continue;
        this.openIssue({key:"refund:"+refund.id,entityId:refund.id,merchantId:refund.merchantId,orderId:refund.orderId,kind:"refund",retryAllowed:false,
          message:"退款结果待渠道核对，请勿另外发起退款"});
      }
      for (const issue of this.batch("operational_issue", "active", [{field:"status",value:"open"}])) {
        const order=this.repo.findOrder(issue.merchantId,issue.orderId);
        if(!order||order.archivedAt){this.updateIssue(issue,{status:"resolved"});continue;}
        const task=latestFulfillmentOf(this.repo.listFulfillments(issue.merchantId,issue.orderId));
        const refund=issue.kind==="refund"?this.repo.findRefund(issue.merchantId,issue.entityId):null;
        const newerAttempt=Boolean(issue.kind==="recharge"&&task&&task.id!==issue.entityId&&["queued","running"].includes(task.status));
        const recovered=issue.kind==="refund"?Boolean(refund&&["succeeded","rejected","cancelled"].includes(refund.status))
          :order.paymentStatus==="refunded"||(issue.kind==="cdk"?Boolean(order.voucherCode)
          :task?.status==="succeeded"||task?.status==="cancelled"||task?.recoveryAction==="refund"||newerAttempt);
        if(recovered)this.updateIssue(issue,{status:"resolved"});
        else if(issue.dueAt.getTime()<=Date.now()&&issue.severity!=="urgent")this.updateIssue(issue,{severity:"urgent"});
      }
    });
  }

  migrateLegacyCases(){return this.repo.transaction(()=>this.migrateLegacyCasesLocked());}

  private issueId(key:string){return "issue_"+createHash("sha256").update(key).digest("hex").slice(0,32);}
  private attentionKey(severity:"normal"|"urgent",detectedAt:Date){return `${severity==="urgent"?"0":"1"}:${detectedAt.toISOString()}`;}
  private openIssue(issue: Issue,legacyTicketIds:string[]=[]) {
    const id=this.issueId(issue.key),existing=this.repo.getOperations("operational_issue",id);
    if(existing){
      const merged=[...new Set([...existing.legacyTicketIds,...legacyTicketIds])];
      if(existing.status==="resolved"||merged.length!==existing.legacyTicketIds.length||existing.reason!==issue.message
          ||existing.retryAllowed!==issue.retryAllowed)this.repo.saveOperations("operational_issue",{
        ...existing,status:"open",reason:issue.message,retryAllowed:issue.retryAllowed,legacyTicketIds:merged,resolvedAt:null,updatedAt:new Date(),
        attentionKey:this.attentionKey(existing.severity,existing.firstDetectedAt)});
      return;
    }
    const now=new Date();
    const value:OperationalIssue={id,merchantId:issue.merchantId,orderId:issue.orderId,entityId:issue.entityId,kind:issue.kind,
      status:"open",severity:"normal",reason:issue.message,retryAllowed:issue.retryAllowed,
      attentionKey:this.attentionKey("normal",now),dueAt:new Date(now.getTime()+30*60_000),firstDetectedAt:now,updatedAt:now,
      resolvedAt:null,legacyTicketIds};
    this.repo.saveOperations("operational_issue",value,true);
  }
  private updateIssue(issue:OperationalIssue,changes:Partial<Pick<OperationalIssue,"status"|"severity">>){
    const status=changes.status??issue.status,severity=changes.severity??issue.severity,now=new Date();
    this.repo.saveOperations("operational_issue",{...issue,status,severity,attentionKey:this.attentionKey(severity,issue.firstDetectedAt),
      updatedAt:now,resolvedAt:status==="resolved"?now:null});
  }

  private migrateLegacyCasesLocked(){
    const checkpointId="legacy-system-cases-v2",checkpoint=this.repo.getOperations("service_checkpoint",checkpointId);
    if(checkpoint?.completed)return 0;
    const page=queryRecords(this.repo,"ticket",{limit:100,count:false,orderBy:"id",direction:"asc",
      ...(checkpoint?.afterId?{afterId:checkpoint.afterId}:{}),filters:[{field:"archivedAt",op:"is_null"},
        {field:"createdBy",value:"system"},{field:"status",op:"in",value:["open","in_progress","waiting_agent"]}]});
    let migrated=0;
    for(const ticket of page.data){
      if((ticket.systemCase?.issueKey??"").startsWith("refund-reconcile:"))continue;
      const order=ticket.orderId?this.repo.findOrder(ticket.merchantId,ticket.orderId):null;
      const task=order?latestFulfillmentOf(this.repo.listFulfillments(order.merchantId,order.id)):null;
      const entityId=ticket.systemCase?.entityId??task?.id??order?.id??ticket.id;
      const kind=["recharge","cdk","refund"].includes(ticket.category)?ticket.category as Issue["kind"]:"recharge";
      const refund=kind==="refund"?this.repo.findRefund(ticket.merchantId,entityId):null;
      const recovered=!order||order.archivedAt||order.paymentStatus==="refunded"||(kind==="refund"
        ?Boolean(refund&&["succeeded","rejected","cancelled"].includes(refund.status))
        :kind==="cdk"?Boolean(order.voucherCode):Boolean(task&&["succeeded","cancelled"].includes(task.status)));
      if(!recovered&&order)this.openIssue({key:ticket.systemCase?.issueKey??`legacy:${ticket.id}`,entityId,merchantId:ticket.merchantId,
        orderId:order.id,kind,retryAllowed:Boolean(kind==="recharge"&&task&&canResubmitFulfillment(task)),message:ticket.title},[ticket.id]);
      const next:Ticket={...ticket,status:"resolved",version:ticket.version+1,publicVersion:ticket.publicVersion+1,updatedAt:new Date()};
      this.repo.saveOperations("ticket",next);
      const noteId=`${ticket.id}:operational-issue-migrated`;
      if(!this.repo.getOperations("ticket_message",noteId))this.repo.saveOperations("ticket_message",{id:noteId,merchantId:ticket.merchantId,
        ticketId:ticket.id,actorId:"system",author:"platform",internal:true,body:recovered
          ?"历史系统异常已恢复，本工单仅保留追溯。":"业务异常已迁移到独立待办记录；本工单及消息仅保留沟通追溯，不再控制业务状态。",createdAt:new Date()},true);
      migrated++;
    }
    const last=page.data.at(-1);
    this.repo.saveOperations("service_checkpoint",{id:checkpointId,merchantId:null,createdAt:checkpoint?.createdAt??new Date(),
      afterId:page.data.length===100?last?.id??checkpoint?.afterId??null:null,completed:page.data.length<100});
    return migrated;
  }
}
