import {createHash} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import type {Actor, Ticket} from "../operations/model.js";
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
    if(this.repo.queryNotificationTasks){
      const result=this.repo.queryNotificationTasks(isPlatform(actor)?null:actor.merchantId!,page,limit);
      const orders=new Map(result.orders.map(item=>[item.id,item])),tasks=new Map(result.fulfillments.map(item=>[item.orderId,item]));
      return {meta:result.meta,data:result.tickets.map(ticket=>{
        const order=ticket.orderId?orders.get(ticket.orderId)??null:null,task=order?tasks.get(order.id)??null:null;
        return {key:ticket.systemCase?.issueKey??ticket.id,orderId:ticket.orderId,merchantId:ticket.merchantId,kind:ticket.category,
          message:ticket.title,ticketId:ticket.id,status:ticket.status,
          retryAllowed:Boolean(order&&order.paymentStatus==="paid"&&order.ordinaryRefundedMinor===0n&&task&&canResubmitFulfillment(task)),
          priority:ticket.priority??"normal",dueAt:ticket.dueAt??null,overdue:Boolean(ticket.dueAt&&ticket.dueAt.getTime()<=Date.now()),createdAt:ticket.createdAt};
      })};
    }
    const result = queryRecords(this.repo, "ticket", {page, limit,
      ...(isPlatform(actor) ? {} : {merchantId: actor.merchantId!}),
      filters: [{field:"archivedAt",op:"is_null"}, {field:"createdBy", value:"system"}, {field:"status", op:"in", value:["open","in_progress","waiting_agent"]}],
    });
    return {...result, data: result.data.map(ticket => {
      const order = ticket.orderId ? this.repo.findOrder(ticket.merchantId, ticket.orderId) : null;
      const task = order ? latestFulfillmentOf(this.repo.listFulfillments(order.merchantId, order.id)) : null;
      return {key:ticket.systemCase?.issueKey ?? ticket.id, orderId:ticket.orderId, merchantId:ticket.merchantId,
        kind:ticket.category, message:ticket.title, ticketId:ticket.id, status:ticket.status,
        retryAllowed:Boolean(order && order.paymentStatus==="paid" && order.ordinaryRefundedMinor===0n && task && canResubmitFulfillment(task)),
        priority:ticket.priority??"normal", dueAt:ticket.dueAt??null,
        overdue:Boolean(ticket.dueAt && ticket.dueAt.getTime()<=Date.now()), createdAt:ticket.createdAt};
    })};
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
      for (const task of this.batch("fulfillment", "recharge", [{field:"status",op:"in",value:["queued","running","failed"]}])) {
        const order=this.repo.findOrder(task.merchantId,task.orderId);
        if (!order || order.archivedAt || !["paid","partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor>0n) continue;
        if (latestFulfillmentOf(this.repo.listFulfillments(task.merchantId,task.orderId))?.id!==task.id) continue;
        if (["queued","running"].includes(task.status) && Date.now()-task.createdAt.getTime()<600_000) continue;
        const retryAllowed=canResubmitFulfillment(task);
        this.openCase({key:"task:"+task.id,entityId:task.id,merchantId:task.merchantId,orderId:task.orderId,kind:"recharge",retryAllowed,
          message:retryAllowed?"充值已明确失败，请核对资料后在原订单重新提交":"充值结果尚未确认，请等待平台核对，不要重复下单"});
      }
      for (const order of this.batch("order", "cdk", [{field:"paymentStatus",value:"paid"},{field:"fulfillmentMode",value:"cdk"},
        {field:"archivedAt",op:"is_null"},
        {field:"voucherCode",op:"is_null"},{field:"paidAt",op:"lte",value:new Date(Date.now()-300_000)}])) {
        if (order.ordinaryRefundedMinor>0n || this.repo.listFulfillments(order.merchantId,order.id).length) continue;
        this.openCase({key:"cdk:"+order.id,entityId:order.id,merchantId:order.merchantId,orderId:order.id,kind:"cdk",retryAllowed:false,
          message:"兑换码签发尚未完成，请勿重复采购，平台将核对供应状态"});
      }
      for (const refund of this.batch("refund", "refund", [{field:"status",op:"in",value:["failed","processing"]}])) {
        if (this.repo.findOrder(refund.merchantId,refund.orderId)?.archivedAt) continue;
        if (refund.status==="processing" && Date.now()-refund.createdAt.getTime()<300_000) continue;
        this.openCase({key:"refund:"+refund.id,entityId:refund.id,merchantId:refund.merchantId,orderId:refund.orderId,kind:"refund",retryAllowed:false,
          message:"退款结果待渠道核对，请勿另外发起退款"});
      }
      for (const ticket of this.batch("ticket", "active", [{field:"archivedAt",op:"is_null"},{field:"createdBy",value:"system"},{field:"status",op:"in",value:["open","in_progress","waiting_agent"]}])) {
        if (!ticket.orderId) continue;
        const order=this.repo.findOrder(ticket.merchantId,ticket.orderId);
        if (!order || order.archivedAt) continue;
        const task=latestFulfillmentOf(this.repo.listFulfillments(ticket.merchantId,ticket.orderId));
        const refund=ticket.category==="refund" && ticket.systemCase ? this.repo.findRefund(ticket.merchantId,ticket.systemCase.entityId) : null;
        const newerAttempt=Boolean(ticket.systemCase && task && task.id!==ticket.systemCase.entityId && ["queued","running"].includes(task.status));
        const recovered=ticket.category==="refund" ? Boolean(refund && ["succeeded","rejected","cancelled"].includes(refund.status))
          : order.paymentStatus==="refunded" || (ticket.category==="cdk" ? Boolean(order.voucherCode)
          : task?.status==="succeeded" || task?.status==="cancelled" || task?.recoveryAction==="refund" || newerAttempt);
        if (recovered) this.updateCase(ticket,{status:"resolved"},"本次异常已解除或恢复正常处理，请在原订单查看最新结果。");
        else if (ticket.dueAt && ticket.dueAt.getTime()<=Date.now() && ticket.priority!=="urgent")
          this.updateCase(ticket,{priority:"urgent"},"处理已超时，平台待办已升级；结果未确认前请勿重复采购、充值或退款。");
      }
    });
  }
  private openCase(issue: Issue) {
    const id="case_"+createHash("sha256").update(issue.key).digest("hex").slice(0,32);
    if (this.repo.getOperations("ticket",id)) return;
    const now=new Date();
    const ticket:Ticket={id,merchantId:issue.merchantId,orderId:issue.orderId,category:issue.kind,title:issue.message,
      status:issue.retryAllowed?"waiting_agent":"in_progress",assigneeId:null,version:1,publicVersion:1,createdBy:"system",
      systemCase:{issueKey:issue.key,entityId:issue.entityId},priority:"normal",dueAt:new Date(now.getTime()+30*60_000),createdAt:now,updatedAt:now};
    this.repo.saveOperations("ticket",ticket,true);
    this.note(ticket,issue.message);
  }
  private updateCase(ticket: Ticket, changes: Partial<Pick<Ticket,"status"|"priority">>, message: string) {
    const next={...ticket,...changes,version:ticket.version+1,publicVersion:ticket.publicVersion+1,updatedAt:new Date()};
    this.repo.saveOperations("ticket",next);
    this.note(next,message);
  }
  private note(ticket: Ticket, body: string) {
    this.repo.saveOperations("ticket_message",{id:ticket.id+":system:"+ticket.publicVersion,merchantId:ticket.merchantId,ticketId:ticket.id,
      actorId:"system",author:"platform",internal:false,body,createdAt:new Date()},true);
  }
}
