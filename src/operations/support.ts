import {randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {AppError} from "../domain/errors.js";
import {minorToMoney} from "../domain/money.js";
import {AuditService} from "../modules/audit-service.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import type {Actor, Announcement, Ticket, WalletWithdrawal} from "./model.js";
import {queryRecords, type RecordFilter} from "../infra/record-query.js";

export function safeText(value: string, publicPlatformText = false): string {
  if (/-----BEGIN.*PRIVATE KEY|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.|(?:access_token|authorization|cookie|api_key|session_token)\s*[:=]/i.test(value)) {
    throw new AppError(422, "sensitive_content", "请勿提交密码、密钥、Cookie 或完整登录凭据");
  }
  if (publicPlatformText && /zovocard|spacexcard|\b(?:ZC|GPTD)-[A-Z0-9-]{8,}/i.test(value)) throw new AppError(422, "supplier_content_blocked", "对外内容不能包含供应商身份或原始兑换码");
  return value;
}

export class SupportService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService) {}
  create(actor: Actor, merchantId: string, input: {orderId: string | null; title: string; category: Exclude<Ticket["category"], "tier_application" | "api_application">; body: string}): Ticket {
    requirePermission(actor, "tickets.write"); requireTenantScope(actor, merchantId);
    safeText(input.title, isPlatform(actor)); safeText(input.body, isPlatform(actor));
    return this.repository.transaction(() => {
      if (!this.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
      if (input.orderId) {
        const order = this.repository.findOrder(merchantId, input.orderId);
        if (!order || order.archivedAt) throw new AppError(404, "order_not_found", "订单不存在或已归档");
      }
      const now = new Date();
      const ticket: Ticket = {id: "tk_" + randomUUID(), merchantId, orderId: input.orderId, title: input.title, category: input.category,
        status: "open", assigneeId: null, version: 1, publicVersion: 1, createdBy: actor.id, createdAt: now, updatedAt: now};
      this.repository.saveOperations("ticket", ticket, true);
      this.repository.saveOperations("ticket_message", {id: randomUUID(), merchantId, ticketId: ticket.id, actorId: actor.id,
        author: isPlatform(actor) ? "platform" : "agent", internal: false, body: input.body, createdAt: now}, true);
      this.markRead(actor, ticket);
      this.log(actor, "ticket.create", ticket);
      return ticket;
    });
  }

  /** Auto-open a platform-visible ticket when an agent requests earnings withdrawal. */
  createWithdrawalTicket(actor: Actor, withdrawal: WalletWithdrawal): Ticket {
    return this.repository.transaction(() => {
      const existing = queryRecords(this.repository,"ticket",{merchantId:withdrawal.merchantId,
        filters:[{field:"withdrawalApplication.withdrawalId",value:withdrawal.id}],limit:1,count:false}).data[0];
      if (existing) return existing;
      const method = withdrawal.payoutMethod === "bank" ? "银行卡" : "支付宝";
      const amount = minorToMoney(withdrawal.amountMinor);
      const now = new Date();
      const body = [
        `代理商申请提现 ¥${amount}。`,
        `收款方式：${method}`,
        `收款户名：${withdrawal.payoutName || "—"}`,
        `收款账号：${withdrawal.payoutAccount || "—"}`,
        `申请号：${withdrawal.requestKey}`,
        "申请时金额已从「收益可用」冻结到「提现冻结」。平台确认实际打款后，冻结金额才会真正扣减；驳回则解冻退回收益可用。",
      ].join("\n");
      const ticket: Ticket = {
        id: "tk_" + randomUUID(),
        merchantId: withdrawal.merchantId,
        orderId: null,
        title: `提现申请 ¥${amount}`,
        category: "wallet",
        withdrawalApplication: {
          withdrawalId: withdrawal.id,
          amountMinor: withdrawal.amountMinor,
          requestKey: withdrawal.requestKey,
          payoutMethod: withdrawal.payoutMethod ?? "alipay",
          payoutAccount: withdrawal.payoutAccount ?? "",
          payoutName: withdrawal.payoutName ?? "",
          status: withdrawal.status,
          reviewReason: null,
        },
        status: "open",
        assigneeId: null,
        version: 1,
        publicVersion: 1,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      };
      this.repository.saveOperations("ticket", ticket, true);
      this.repository.saveOperations("ticket_message", {
        id: randomUUID(), merchantId: withdrawal.merchantId, ticketId: ticket.id, actorId: actor.id,
        author: isPlatform(actor) ? "platform" : "agent", internal: false, body, createdAt: now,
      }, true);
      this.markRead(actor, ticket);
      this.log(actor, "ticket.create.withdrawal", ticket);
      return ticket;
    });
  }

  syncWithdrawalTicket(withdrawal: WalletWithdrawal, reviewReason: string | null = null): void {
    this.repository.transaction(() => {
      const ticket = queryRecords(this.repository,"ticket",{merchantId:withdrawal.merchantId,
        filters:[{field:"withdrawalApplication.withdrawalId",value:withdrawal.id}],limit:1,count:false}).data[0];
      if (!ticket?.withdrawalApplication) return;
      const now = new Date();
      const status = withdrawal.status === "paid" || withdrawal.status === "rejected" ? "resolved" as const
        : withdrawal.status === "approved" ? "in_progress" as const
        : ticket.status;
      const updated: Ticket = {
        ...ticket,
        status,
        version: ticket.version + 1,
        publicVersion: ticket.publicVersion + 1,
        updatedAt: now,
        withdrawalApplication: {
          ...ticket.withdrawalApplication,
          status: withdrawal.status,
          reviewReason: reviewReason ?? ticket.withdrawalApplication.reviewReason,
        },
      };
      this.repository.saveOperations("ticket", updated);
      const note = withdrawal.status === "paid" ? `平台已确认打款，提现冻结 ¥${minorToMoney(withdrawal.amountMinor)} 已扣减。`
        : withdrawal.status === "rejected" ? `提现已驳回并解冻：${reviewReason || "无说明"}`
        : withdrawal.status === "approved" ? "平台已审核通过，待确认实际打款并扣减冻结。"
        : null;
      if (note) {
        this.repository.saveOperations("ticket_message", {
          id: randomUUID(), merchantId: ticket.merchantId, ticketId: ticket.id, actorId: "system",
          author: "platform", internal: false, body: note, createdAt: now,
        }, true);
      }
    });
  }
  list(actor: Actor) {
    requirePermission(actor, "tickets.read");
    return this.repository.listOperations("ticket", isPlatform(actor) ? undefined : actor.merchantId!)
      .filter(ticket => !ticket.archivedAt && !ticket.systemCase && !ticket.apiApplication && !ticket.tierApplication && !ticket.withdrawalApplication)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map(t => this.view(actor, t));
  }
  page(actor: Actor, input: {merchantId?: string; status?: Ticket["status"] | "all"; page: number; limit: number}) {
    requirePermission(actor, "tickets.read");
    const scopedMerchant = isPlatform(actor) ? input.merchantId : actor.merchantId ?? undefined;
    if (input.merchantId) requireTenantScope(actor, input.merchantId);
    const filters: RecordFilter[] = [{field: "archivedAt", op: "is_null"}, {field:"systemCase",op:"is_null"},
      {field:"apiApplication",op:"is_null"},{field:"tierApplication",op:"is_null"},{field:"withdrawalApplication",op:"is_null"}];
    if (input.status && input.status !== "all") filters.push({field: "status", value: input.status});
    const result = queryRecords(this.repository, "ticket", {
      ...(scopedMerchant ? {merchantId: scopedMerchant} : {}), filters,
      page: input.page, limit: input.limit, orderBy: "updatedAt", direction: "desc",
    });
    return {...result, data: result.data.map(ticket => this.view(actor, ticket))};
  }
  pendingAgentPage(actor: Actor, limit = 8) {
    requirePermission(actor, "tickets.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台可查看全部代理工单");
    const page = queryRecords(this.repository, "ticket", {filters: [
      {field: "archivedAt", op: "is_null"}, {field: "systemCase", op: "is_null"},
      {field:"apiApplication",op:"is_null"},{field:"tierApplication",op:"is_null"},{field:"withdrawalApplication",op:"is_null"},
      {field: "status", op: "in", value: ["open", "in_progress", "waiting_agent"]},
    ], page: 1, limit, orderBy: "updatedAt", direction: "desc"});
    return {...page, data: page.data.map(ticket => this.view(actor, ticket))};
  }
  get(actor: Actor, id: string) {
    requirePermission(actor, "tickets.read");
    return this.repository.transaction(() => {
      const ticket = this.require(actor, id);
      this.markRead(actor, ticket);
      const messages = (this.repository.listTicketMessages?.(ticket.merchantId,id,isPlatform(actor))
        ??this.repository.listOperations("ticket_message", ticket.merchantId).filter(m => m.ticketId === id && (isPlatform(actor) || !m.internal))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()))
        .map(m => ({id: m.id, author: m.author, body: m.body, internal: m.internal, createdAt: m.createdAt}));
      return {...this.view(actor, ticket), messages};
    });
  }
  reply(actor: Actor, id: string, body: string, internal: boolean, version: number): void {
    requirePermission(actor, "tickets.write");
    if (internal) requirePermission(actor, "tickets.manage");
    safeText(body, isPlatform(actor) && !internal);
    this.repository.transaction(() => {
      const current = this.require(actor, id);
      this.checkVersion(actor, current, version);
      if (current.status === "closed") throw new AppError(409, "ticket_closed", "请先重新打开工单");
      this.repository.saveOperations("ticket_message", {id: randomUUID(), merchantId: current.merchantId, ticketId: id,
        actorId: actor.id, author: isPlatform(actor) ? "platform" : "agent", internal, body, createdAt: new Date()}, true);
      const updated: Ticket = {...current, version: current.version + 1,
        publicVersion: current.publicVersion + (internal ? 0 : 1),
        status: internal ? current.status : isPlatform(actor) ? "waiting_agent" : "in_progress",
        updatedAt: internal ? current.updatedAt : new Date()};
      this.repository.saveOperations("ticket", updated); this.markRead(actor, updated); this.log(actor, internal ? "ticket.internal_note" : "ticket.reply", updated);
    });
  }
  transition(actor: Actor, id: string, status: Ticket["status"], version: number, assigneeId?: string | null): void {
    requirePermission(actor, "tickets.write");
    this.repository.transaction(() => {
      const current = this.require(actor, id); this.checkVersion(actor, current, version);
      if (current.tierApplication?.status === "pending" && ["resolved", "closed"].includes(status)) throw new AppError(409, "tier_review_required", "等级申请须由管理员审批后结单");
      if (current.apiApplication?.status === "pending" && ["resolved", "closed"].includes(status)) throw new AppError(409, "api_review_required", "API 申请须由管理员审批后结单");
      if (current.withdrawalApplication && ["requested", "approved"].includes(current.withdrawalApplication.status) && ["resolved", "closed"].includes(status)) {
        throw new AppError(409, "withdrawal_review_required", "提现申请须审核打款或驳回后再结单");
      }
      const transitions: Record<Ticket["status"], string[]> = {open: ["in_progress", "waiting_agent", "resolved"], in_progress: ["waiting_agent", "resolved"], waiting_agent: ["in_progress", "resolved"], resolved: ["closed", "open"], closed: ["open"]};
      if (status !== current.status && !transitions[current.status].includes(status)) throw new AppError(409, "ticket_transition_invalid", "当前状态不能执行该操作");
      if (!isPlatform(actor) && !(current.status === "resolved" && status === "closed") && !(["closed", "resolved"].includes(current.status) && status === "open")) throw new AppError(403, "ticket_transition_denied", "代理商只能确认关闭或重新打开工单");
      if (assigneeId !== undefined) {
        requirePermission(actor, "tickets.manage");
        const assignee = assigneeId ? this.repository.getOperations("account", assigneeId) : null;
        if (assigneeId && (!assignee || assignee.status !== "active" || !["platform_admin", "platform_support"].includes(assignee.role))) throw new AppError(422, "invalid_assignee", "处理人必须是启用的平台客服或管理员");
      }
      const updated = {...current, status, ...(assigneeId !== undefined ? {assigneeId} : {}), version: current.version + 1, publicVersion: current.publicVersion + 1, updatedAt: new Date()};
      this.repository.saveOperations("ticket", updated); this.log(actor, "ticket.status", updated);
    });
  }
  private require(actor: Actor, id: string): Ticket {
    const ticket = this.repository.getOperations("ticket", id);
    if (!ticket || ticket.archivedAt) throw new AppError(404, "ticket_not_found", "工单不存在或已归档");
    requireTenantScope(actor, ticket.merchantId); return ticket;
  }
  private view(actor: Actor, ticket: Ticket) {
    const version = isPlatform(actor) ? ticket.version : ticket.publicVersion;
    const read = this.repository.getOperations("ticket_read", actor.id + ":" + ticket.id);
    const merchant = isPlatform(actor) ? this.repository.findMerchantById(ticket.merchantId) : null;
    return {id: ticket.id, merchantId: ticket.merchantId, orderId: ticket.orderId, title: ticket.title, category: ticket.category, status: ticket.status,
      version, unread: !read || read.version < version, ...(merchant ? {merchantName: merchant.name, partnerId: merchant.partnerId} : {}),
      ...(isPlatform(actor) ? {assigneeId: ticket.assigneeId} : {}),
      ...(ticket.apiApplication ? {apiApplication: {status: ticket.apiApplication.status, reviewReason: ticket.apiApplication.reviewReason}} : {}),
      ...(ticket.tierApplication ? {tierApplication: {targetTier: ticket.tierApplication.targetTier, previousTier: ticket.tierApplication.previousTier,
        status: ticket.tierApplication.status, reviewReason: ticket.tierApplication.reviewReason}} : {}),
      ...(ticket.withdrawalApplication ? {withdrawalApplication: {
        withdrawalId: ticket.withdrawalApplication.withdrawalId,
        amount: minorToMoney(ticket.withdrawalApplication.amountMinor),
        requestKey: ticket.withdrawalApplication.requestKey,
        payoutMethod: ticket.withdrawalApplication.payoutMethod,
        payoutAccount: ticket.withdrawalApplication.payoutAccount,
        payoutName: ticket.withdrawalApplication.payoutName,
        status: ticket.withdrawalApplication.status,
        reviewReason: ticket.withdrawalApplication.reviewReason,
      }} : {}), createdAt: ticket.createdAt, updatedAt: ticket.updatedAt};
  }
  private markRead(actor: Actor, ticket: Ticket): void {
    this.repository.saveOperations("ticket_read", {id: actor.id + ":" + ticket.id, merchantId: actor.merchantId, accountId: actor.id, ticketId: ticket.id, version: isPlatform(actor) ? ticket.version : ticket.publicVersion});
  }
  private checkVersion(actor: Actor, ticket: Ticket, version: number): void {
    if (version !== (isPlatform(actor) ? ticket.version : ticket.publicVersion)) throw new AppError(409, "ticket_changed", "工单已更新，请刷新后操作");
  }
  private log(actor: Actor, action: string, ticket: Ticket): void {
    this.audit.record({merchantId: ticket.merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user", action, targetType: "ticket", targetId: ticket.id, requestId: randomUUID()});
  }
}

export class AnnouncementService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService) {}
  save(actor: Actor, input: Omit<Announcement, "id" | "merchantId" | "createdAt" | "updatedAt" | "version"> & {id?: string | undefined; version?: number | undefined}): Announcement {
    requirePermission(actor, "announcements.manage");
    safeText(input.title, true); safeText(input.body, true);
    if (input.endsAt && input.endsAt <= input.startsAt) throw new AppError(422, "announcement_dates", "结束时间必须晚于开始时间");
    if (input.audience === "merchants" && (!input.merchantIds.length || input.merchantIds.some(id => !this.repository.findMerchantById(id)))) throw new AppError(422, "invalid_audience", "请选择有效代理商");
    if (input.audience === "tiers" && !input.tierCodes.length) throw new AppError(422, "invalid_audience", "请选择业务等级");
    return this.repository.transaction(() => {
      const current = input.id ? this.repository.getOperations("announcement", input.id) : null;
      if (input.id && (!current || current.version !== input.version)) throw new AppError(409, "announcement_changed", "公告已变更");
      const result: Announcement = {...input, id: current?.id ?? "an_" + randomUUID(), merchantId: null,
        version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? new Date(), updatedAt: new Date()};
      this.repository.saveOperations("announcement", result);
      this.audit.record({merchantId: null, actorId: actor.id, actorType: "platform_user", action: "announcement." + result.status, targetType: "announcement", targetId: result.id, requestId: randomUUID()});
      return result;
    });
  }
  list(actor: Actor) {
    requirePermission(actor, "announcements.read");
    return this.repository.listOperations("announcement").filter(a => isPlatform(actor) || this.visible(actor, a))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.startsAt.getTime() - a.startsAt.getTime())
      .map(a => {
        const read = this.repository.getOperations("announcement_read", actor.id + ":" + a.id);
        const common = {id: a.id, title: a.title, body: a.body, pinned: a.pinned, startsAt: a.startsAt, endsAt: a.endsAt, version: a.version, unread: read?.version !== a.version};
        return isPlatform(actor) ? {...a, ...common} : common;
      });
  }
  read(actor: Actor, id: string): void {
    requirePermission(actor, "announcements.read");
    const item = this.repository.getOperations("announcement", id);
    if (!item || (!isPlatform(actor) && !this.visible(actor, item))) throw new AppError(404, "announcement_not_found", "公告不存在");
    this.repository.saveOperations("announcement_read", {id: actor.id + ":" + id, merchantId: actor.merchantId, accountId: actor.id, announcementId: id, version: item.version, readAt: new Date()});
  }
  private visible(actor: Actor, a: Announcement): boolean {
    const now = new Date();
    if (a.status !== "published" || a.startsAt > now || (a.endsAt && a.endsAt <= now)) return false;
    if (a.audience === "all") return true;
    if (a.audience === "merchants") return a.merchantIds.includes(actor.merchantId ?? "");
    const tier = this.repository.getOperations("agent_profile", actor.merchantId ?? "")?.tier ?? "standard";
    return a.tierCodes.includes(tier);
  }
}
