import {validateWebhookUrl} from "../infra/safe-webhook.js";
import {randomBytes, randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {AppError} from "../domain/errors.js";
import {AuditService} from "../modules/audit-service.js";
import {MerchantService} from "../modules/merchant-service.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import {SupportService, safeText} from "./support.js";
import type {Actor, Ticket} from "./model.js";
import {queryRecords} from "../infra/record-query.js";
import {normalizeIpRules} from "../auth/ip.js";
const apiDepositMinor = 11_000n;
export const defaultApiAccessPolicyRevision = "default-api-access-20261001-v1";

/** Existing active agents without an explicit API decision receive the new default-open policy.
 * Explicitly disabled records are preserved so an administrator can still block abusive access. */
export function applyDefaultApiAccessPolicy(repository: Repository) {
  return repository.transaction(() => {
    if (repository.getOperations("service_checkpoint", defaultApiAccessPolicyRevision)) return {applied: false, enabled: 0};
    const now = new Date();
    let enabled = 0;
    for (const merchant of repository.listMerchants().filter(item => item.status === "active")) {
      if (repository.getOperations("api_access", merchant.id)) continue;
      repository.saveOperations("api_access", {id: merchant.id, merchantId: merchant.id, enabled: true,
        depositId: "default:open-api", ticketId: "", version: 1, updatedAt: now}, true);
      enabled++;
    }
    repository.saveOperations("service_checkpoint", {id: defaultApiAccessPolicyRevision, merchantId: null, createdAt: now}, true);
    return {applied: true, enabled};
  });
}

export class ApiAccessService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService,
    private readonly requireHttpsWebhook = false) {}
  summary(actor: Actor, merchantId: string) {
    requirePermission(actor, "api.read"); requireTenantScope(actor, merchantId);
    return {access: this.repository.getOperations("api_access", merchantId),
      automaticAccess: true, canApply: false, apiDepositMinor: "0",
      hasVerifiedDeposit: !!this.verifiedDeposit(merchantId), procurementBalanceMinor: this.balance(merchantId).toString(),
      applications: queryRecords(this.repository,"ticket",{merchantId,filters:[{field:"apiApplication",op:"not_null"}],
        orderBy:"updatedAt",direction:"desc",limit:500,count:false}).data.map(t => ({
        id: t.id,
        status: t.apiApplication!.status,
        reviewReason: t.apiApplication!.reviewReason,
        version: t.version,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      apps: this.repository.listApps(merchantId).filter(a => a.appId !== "quefa_web_portal").map(a => ({
        id: a.id, appId: a.appId, name: a.name, status: a.status, allowedIps: a.allowedIps,
        ipAllowlistEnabled: a.ipAllowlistEnabled === true, configVersion: a.configVersion ?? 1,
      })),
      webhooks: this.repository.listWebhookEndpoints(merchantId).map(e => ({id: e.id, url: e.url, status: e.status}))};
  }
  adminOverview(actor: Actor) {
    requirePermission(actor, "api.read");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "无权执行此操作");
    const pendingApplications: Array<{id: string; merchantId: string; merchantName: string; partnerId: string; version: number; createdAt: Date}> = [];
    const aggregate=this.repository.apiAccessOverview?.();
    const agents = aggregate?.map(value=>({...value,procurementBalanceMinor:value.procurementBalanceMinor.toString()}))??this.repository.listMerchants().filter(m => m.status === "active").map(m => {
      const access = this.repository.getOperations("api_access", m.id);
      const applications = this.repository.listOperations("ticket", m.id).filter(t => !!t.apiApplication);
      const webhooks = this.repository.listWebhookEndpoints(m.id);
      return {merchantId: m.id, name: m.name, partnerId: m.partnerId, apiEnabled: !!access?.enabled, accessVersion: access?.version ?? 0,
        procurementBalanceMinor: this.balance(m.id).toString(),
        appCount: this.repository.listApps(m.id).filter(a => a.appId !== "quefa_web_portal").length,
        webhookCount: webhooks.filter(e => e.status === "active").length,
        pendingApplication: applications.some(t => t.apiApplication?.status === "pending")};
    }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return {pendingApplications, agents};
  }
  apply(actor: Actor, merchantId: string, reason: string, requestKey: string): Ticket {
    requirePermission(actor, "api.apply"); requireTenantScope(actor, merchantId); safeText(reason);
    void requestKey;
    throw new AppError(410, "api_application_retired", "API 已默认开放，无需申请或预存；如被管理员停用请联系平台处理");
  }
  review(actor: Actor, ticketId: string, approve: boolean, reason: string, version: number) {
    requirePermission(actor, "api.manage"); safeText(reason, true);
    return this.repository.transaction(() => {
      const t = this.repository.getOperations("ticket", ticketId), application = t?.apiApplication;
      if (!t || !application) throw new AppError(404, "api_application_not_found", "API 申请不存在");
      const status = approve ? "approved" : "rejected";
      if (application.status === status && application.reviewReason === reason) return t;
      if (application.status !== "pending" || t.version !== version) throw new AppError(409, "api_application_changed", "申请已变化或已处理");
      if (approve) {
        const current = this.repository.getOperations("api_access", t.merchantId);
        const depositId = application.depositId && !application.depositId.startsWith("manual:")
          ? application.depositId
          : "manual:" + actor.id;
        this.repository.saveOperations("api_access", {id: t.merchantId, merchantId: t.merchantId, enabled: true, depositId,
          ticketId, version: (current?.version ?? 0) + 1, updatedAt: new Date()});
      }
      const updated = {...t, apiApplication: {...application, status: status as "approved" | "rejected", reviewReason: reason},
        status: "resolved" as const, version: t.version + 1, publicVersion: t.publicVersion + 1, updatedAt: new Date()};
      this.repository.saveOperations("ticket", updated);
      this.repository.saveOperations("ticket_message", {id: randomUUID(), merchantId: t.merchantId, ticketId, actorId: actor.id, author: "platform", internal: false,
        body: (approve ? "API 接入已开通。" : "API 申请未通过。") + reason, createdAt: new Date()}, true);
      this.log(actor, t.merchantId, "api.application." + status, ticketId); return updated;
    });
  }
  disable(actor: Actor, merchantId: string, version: number, reason: string): void {
    requirePermission(actor, "api.manage"); safeText(reason, true);
    this.repository.transaction(() => {
      const current = this.repository.getOperations("api_access", merchantId);
      if (!current || current.version !== version) throw new AppError(409, "api_access_changed", "API 配置已变化");
      this.repository.saveOperations("api_access", {...current, enabled: false, version: current.version + 1, updatedAt: new Date()});
      this.log(actor, merchantId, "api.disable", merchantId);
    });
  }
  issueKey(actor: Actor, merchantId: string, requestKey: string, name: string) {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    return this.repository.transaction(() => {
      if (!this.repository.getOperations("api_access", merchantId)?.enabled) throw new AppError(403, "api_access_required", "API 接入已被停用，请联系平台管理员");
      const appId = "partner_" + requestKey;
      if (this.repository.listApps(merchantId).some(a => a.appId === appId)) throw new AppError(409, "api_key_already_created", "此申请已创建密钥，不重复显示秘密；如丢失请先停用旧应用再创建新密钥");
      const merchants = new MerchantService(this.repository), app = merchants.createApp(merchantId, {appId, name});
      const keyId = "key_" + randomUUID().replaceAll("-", "");
      const issued = merchants.issueKey(merchantId, app.id, keyId);
      this.log(actor, merchantId, "api.key.issue", app.id);
      return {partner_id: this.repository.findMerchantById(merchantId)!.partnerId, app_id: app.appId, key_id: keyId, client_secret: issued.clientSecret};
    });
  }
  grant(actor: Actor, merchantId: string, reason: string): void {
    requirePermission(actor, "api.manage"); safeText(reason, true);
    this.repository.transaction(() => {
      if (this.repository.getOperations("api_access", merchantId)?.enabled) throw new AppError(409, "api_already_enabled", "API 已开通");
      if (this.repository.findMerchantById(merchantId)?.status !== "active") throw new AppError(403, "merchant_inactive", "代理商未启用");
      const current = this.repository.getOperations("api_access", merchantId);
      this.repository.saveOperations("api_access", {id: merchantId, merchantId, enabled: true, depositId: "manual:" + actor.id,
        ticketId: current?.ticketId ?? "", version: (current?.version ?? 0) + 1, updatedAt: new Date()});
      this.log(actor, merchantId, "api.manual.grant", merchantId);
    });
  }
  disableApp(actor: Actor, merchantId: string, appId: string): void {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    this.repository.transaction(() => {
      const app = this.repository.listApps(merchantId).find(a => a.id === appId && a.appId !== "quefa_web_portal");
      if (!app) throw new AppError(404, "api_app_not_found", "API 应用不存在");
      this.repository.saveApp({...app, status: "disabled"}); this.log(actor, merchantId, "api.app.disable", appId);
    });
  }
  configureIpAllowlist(actor: Actor, merchantId: string, appId: string, enabled: boolean,
    rules: readonly string[], expectedVersion: number) {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    let allowedIps: string[];
    try {
      allowedIps = normalizeIpRules(rules);
    } catch {
      throw new AppError(422, "ip_allowlist_invalid", "白名单只允许单个 IPv4、IPv6 或 CIDR，每行一条");
    }
    if (allowedIps.length > 50) throw new AppError(422, "ip_allowlist_too_large", "每个应用最多配置 50 条 IP 或网段");
    if (enabled && allowedIps.length === 0) throw new AppError(422, "ip_allowlist_required", "启用白名单前至少配置一条 IP 或网段");
    return this.repository.transaction(() => {
      const app = this.repository.listApps(merchantId).find(a => a.id === appId && a.appId !== "quefa_web_portal");
      if (!app) throw new AppError(404, "api_app_not_found", "API 应用不存在");
      const currentVersion = app.configVersion ?? 1;
      if (currentVersion !== expectedVersion) throw new AppError(409, "api_app_changed", "应用安全配置已变化，请刷新后重试");
      const updated = {...app, allowedIps, ipAllowlistEnabled: enabled, configVersion: currentVersion + 1};
      this.repository.saveApp(updated);
      this.log(actor, merchantId, enabled ? "api.app.ip_allowlist.enable" : "api.app.ip_allowlist.disable", appId);
      return {id: updated.id, allowedIps: updated.allowedIps, ipAllowlistEnabled: updated.ipAllowlistEnabled,
        configVersion: updated.configVersion};
    });
  }
  registerWebhook(actor: Actor, merchantId: string, url: string, requestKey: string) {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    const normalized = this.normalizeWebhookUrl(url);
    return this.repository.transaction(() => {
      if (!this.repository.getOperations("api_access", merchantId)?.enabled) throw new AppError(403, "api_access_required", "API 接入已被停用，请联系平台管理员");
      const id = `wh_${merchantId}_${requestKey}`;
      const existing = this.repository.listWebhookEndpoints(merchantId).find(e => e.id === id);
      if (existing) {
        if (existing.url !== normalized) throw new AppError(409, "webhook_conflict", "登记号已用于不同回调地址");
        throw new AppError(409, "webhook_already_registered", "该回调已登记，密钥仅显示一次，如需新密钥请轮换");
      }
      if (this.repository.listWebhookEndpoints(merchantId).some(e => e.status === "active" && e.url === normalized)) {
        throw new AppError(409, "webhook_url_in_use", "该回调地址已登记");
      }
      const webhookSecret = randomBytes(32).toString("base64url");
      this.repository.saveWebhookEndpoint({id, merchantId, url: normalized, secret: webhookSecret, subscribedEvents: ["*"], status: "active"});
      this.log(actor, merchantId, "api.webhook.register", id);
      return {partner_id: this.repository.findMerchantById(merchantId)!.partnerId, webhook_url: normalized, webhook_secret: webhookSecret};
    });
  }
  rotateWebhook(actor: Actor, merchantId: string, endpointId: string) {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    return this.repository.transaction(() => {
      if (!this.repository.getOperations("api_access", merchantId)?.enabled) throw new AppError(403, "api_access_required", "API 接入已被停用，请联系平台管理员");
      const endpoint = this.repository.listWebhookEndpoints(merchantId).find(e => e.id === endpointId);
      if (!endpoint || endpoint.status !== "active") throw new AppError(404, "webhook_not_found", "回调登记不存在或已停用");
      const webhookSecret = randomBytes(32).toString("base64url");
      this.repository.saveWebhookEndpoint({...endpoint, secret: webhookSecret});
      this.log(actor, merchantId, "api.webhook.rotate", endpointId);
      return {partner_id: this.repository.findMerchantById(merchantId)!.partnerId, webhook_url: endpoint.url, webhook_secret: webhookSecret};
    });
  }
  disableWebhook(actor: Actor, merchantId: string, endpointId: string): void {
    requirePermission(actor, "api.keys"); requireTenantScope(actor, merchantId);
    this.repository.transaction(() => {
      const endpoint = this.repository.listWebhookEndpoints(merchantId).find(e => e.id === endpointId);
      if (!endpoint) throw new AppError(404, "webhook_not_found", "回调登记不存在");
      if (endpoint.status === "disabled") return;
      this.repository.saveWebhookEndpoint({...endpoint, status: "disabled"});
      this.log(actor, merchantId, "api.webhook.disable", endpointId);
    });
  }
  private normalizeWebhookUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = validateWebhookUrl(url.trim());
    } catch {
      throw new AppError(422, "webhook_url_invalid", "回调地址无效");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new AppError(422, "webhook_url_invalid", "回调地址必须使用 HTTP(S)");
    if (this.requireHttpsWebhook && parsed.protocol !== "https:") throw new AppError(422, "https_webhook_required", "生产回调地址必须使用 HTTPS");
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  }
  private balance(merchantId: string) {return this.repository.walletTotals?.(merchantId).procurement
    ??this.repository.listOperations("wallet_entry", merchantId).reduce((sum, e) => sum + e.procurementDelta, 0n);}
  private verifiedDeposit(merchantId: string) {
    if(this.repository.findVerifiedDeposit)return this.repository.findVerifiedDeposit(merchantId,apiDepositMinor);
    return this.repository.listOperations("wallet_deposit", merchantId).find(d => d.status === "credited" && d.amountMinor >= apiDepositMinor && !!d.verifiedReference
      && this.repository.getOperations("wallet_entry", "deposit:" + d.id)?.procurementDelta === d.amountMinor);
  }
  private log(actor: Actor, merchantId: string, action: string, targetId: string) {
    this.audit.record({merchantId, actorId: actor.id, actorType: actor.role.startsWith("platform_") ? "platform_user" : "merchant_user", action, targetType: "api_access", targetId, requestId: randomUUID()});
  }
}
