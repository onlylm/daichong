import {randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {AuditService} from "../modules/audit-service.js";

/** Exact scope confirmed by the owner. Never expand this to an entire merchant. */
export const confirmedTestOrders = [
  {ticketId:"case_f889924ff31bea7c87c26ad850978136",orderId:"ord_31c09c7dfad24e3295396256af738e8d"},
  {ticketId:"case_ec238c71dc90630e215405cd6ced7df5",orderId:"QF0000000010"},
  {ticketId:"case_bd8c3666ce14dc522b85ad9cb0a3bbe7",orderId:"QF0000000002"},
  {ticketId:"case_c3f7580d8bb199e123eec1b5ca120edd",orderId:"ord_a9df812882f44650863d85a4c7fcb1ab"},
  {ticketId:"case_b9c6a1d0df1b84861e2e73c31e8f4fe9",orderId:"ord_c7b9ee956a48424cbb8bd29059dfb919"},
  {ticketId:"case_aade1ac455e95d8bc615a111c8207322",orderId:"ord_6a623f0e67184c52a7e3245932f92bbb"},
  {ticketId:"case_75a06df3cb76e232746d47fd9569e939",orderId:"QF0000000015"},
] as const;

export function archiveConfirmedTestOrders(repo: Repository) {
  return repo.transaction(() => {
    // Validate the entire selection before any write. Failed/ended attempts are preserved, not cancelled.
    const records = confirmedTestOrders.map(({ticketId,orderId}) => {
      const ticket=repo.getOperations("ticket",ticketId),order=repo.findOrderInternal(orderId);
      if (!ticket || !order || ticket.orderId!==order.id || ticket.merchantId!==order.merchantId || !ticket.systemCase)
        throw new Error("archive_scope_mismatch:"+orderId);
      if (repo.listFulfillments(order.merchantId,orderId).some(f=>["queued","running","succeeded"].includes(f.status)))
        throw new Error("archive_nonterminal_or_successful_order:"+orderId);
      if (repo.listRefundsForOrder(order.merchantId,orderId).some(r=>["requested","approved","processing"].includes(r.status)))
        throw new Error("archive_refund_in_progress:"+orderId);
      const otherTickets=repo.listOperations("ticket",order.merchantId).filter(t=>t.orderId===orderId && t.id!==ticketId && !t.archivedAt);
      if (otherTickets.length) throw new Error("archive_unconfirmed_related_ticket:"+orderId);
      return {ticket,order};
    });
    const now=new Date(),actorId="owner-confirmed-test-cleanup",reason="用户确认：截图中的7笔为自有测试订单及自动异常工单，清理正常业务列表；保留账证、不退款、不改余额";
    const audit=new AuditService(repo),requestId=randomUUID();
    let ordersArchived=0,ticketsArchived=0;
    for (const {ticket,order} of records) {
      if (!order.archivedAt) {
        repo.updateOrder({...order,archivedAt:now,archiveReason:reason,archivedBy:actorId,updatedAt:now});
        audit.record({merchantId:order.merchantId,actorId,actorType:"platform_user",action:"order.archive.confirmed_test",targetType:"order",targetId:order.id,requestId});
        ordersArchived++;
      }
      if (!ticket.archivedAt) {
        repo.saveOperations("ticket",{...ticket,status:"closed",archivedAt:now,archiveReason:reason,archivedBy:actorId,
          version:ticket.version+1,publicVersion:ticket.publicVersion+1,updatedAt:now});
        audit.record({merchantId:ticket.merchantId,actorId,actorType:"platform_user",action:"ticket.archive.confirmed_test",targetType:"ticket",targetId:ticket.id,requestId});
        ticketsArchived++;
      }
    }
    return {ordersArchived,ticketsArchived,selection:confirmedTestOrders,financialRecordsChanged:false};
  });
}
