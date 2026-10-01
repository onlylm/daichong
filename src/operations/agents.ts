import {createHmac, randomBytes, randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {AppError} from "../domain/errors.js";
import {AuditService} from "../modules/audit-service.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import {defaultOrderVisibility, type Actor, type AgentProfile, type CollectionMode, type TierRules} from "./model.js";
import {SupportService, safeText} from "./support.js";
import {managedGptProduct, managedGptProducts, newProductGrant} from "../modules/gpt-products.js";
import {globalProductGrantsForMerchant, seedGlobalProductCatalog} from "./global-product-catalog.js";
import {defaultTierLevels, mergedCollectionModes, resolveTierBenefits, seedDefaultTierRules, tierCatalogProducts} from "./tier-benefits.js";
import {completedTierOrderMetrics, evaluateTierUpgradeEligibility} from "./tier-upgrade.js";
import type {AccountService, AccountSession} from "./accounts.js";
import {assertCdkPrefix, assertCdkTemplate, normalizeCdkPrefix, normalizeCdkTemplate} from "../modules/cdk-code.js";
import {queryRecords} from "../infra/record-query.js";

export function procurementBalanceMinor(repository: Repository, merchantId: string): bigint {
  if (repository.walletTotals) return repository.walletTotals(merchantId).procurement;
  return repository.listOperations("wallet_entry", merchantId).reduce((sum, entry) => sum + entry.procurementDelta, 0n);
}

/** 采购余额为零时强制仅平台收款；有余额后才允许余额支付。 */
export function effectiveCollectionModes(repository: Repository, merchantId: string, profile?: AgentProfile): CollectionMode[] {
  const modes = profile?.collectionModes ?? repository.getOperations("agent_profile", merchantId)?.collectionModes ?? ["platform_collect"];
  if (procurementBalanceMinor(repository, merchantId) > 0n) return modes;
  const filtered = modes.filter(mode => mode !== "agent_collect");
  return filtered.length > 0 ? filtered : ["platform_collect"];
}

/** 为从未上架过的存量套餐补齐默认可售（priceVersion 仍为 1 表示平台未单独改过）。 */
export function activateInitialAgentCatalog(repository: Repository): void {
  seedGlobalProductCatalog(repository);
  for (const merchant of repository.listMerchants()) {
    for (const grant of globalProductGrantsForMerchant(repository, merchant.id)) repository.saveProductGrant(grant);
    for (const grant of repository.listProductGrants(merchant.id)) {
      if (!managedGptProduct(grant.productCode) && grant.available)
        repository.saveProductGrant({...grant, available: false, priceVersion: grant.priceVersion + 1});
    }
  }
}

export class AgentService {
  constructor(private readonly repository: Repository, private readonly audit: AuditService,
    private readonly registrationEnabled = true) {}
  create(actor: Actor, input: {partnerId: string; name: string}) {
    requirePermission(actor, "agents.manage");
    const partnerId = input.partnerId.toLowerCase().trim(), name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(partnerId)) throw new AppError(422, "partner_id_invalid", "代理编号使用 3–64 位小写字母、数字、下划线或横线");
    if (name.length < 1 || name.length > 80) throw new AppError(422, "agent_name_invalid", "代理名称长度应为 1–80 个字符");
    return this.repository.transaction(() => {
      if (this.repository.findMerchantByPartner(partnerId)) throw new AppError(409, "partner_id_exists", "代理编号已存在");
      return this.createMerchantBundle(partnerId, name);
    });
  }
  async register(accounts: AccountService, input: {email: string; password: string}, ip: string): Promise<AccountSession> {
    if (!this.registrationEnabled) throw new AppError(403, "registration_disabled", "当前未开放自助注册");
    this.throttleRegistration(ip);
    const email = input.email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(422, "email_invalid", "请输入有效的邮箱地址");
    const local = email.split("@")[0] ?? "agent";
    const displayName = (local.slice(0, 80) || "代理商").trim();
    const companyName = displayName;
    const passwordHash = await accounts.hashPassword(input.password);
    return this.repository.transaction(() => {
      let partnerId = suggestPartnerIdFromEmail(email);
      if (this.repository.findMerchantByPartner(partnerId)) {
        partnerId = (partnerId.slice(0, 55) + "_" + randomBytes(3).toString("hex")).slice(0, 63);
        if (this.repository.findMerchantByPartner(partnerId)) throw new AppError(409, "partner_id_exists", "代理编号冲突，请稍后再试");
      }
      const {merchant} = this.createMerchantBundle(partnerId, companyName);
      const owner = accounts.registerOwnerWithHash({username: email, displayName, merchantId: merchant.id}, passwordHash);
      return accounts.issueSessionInsideTransaction(owner);
    });
  }
  profile(merchantId: string): AgentProfile {
    if (!this.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
    const value = this.repository.getOperations("agent_profile", merchantId);
    return value ? {...value, orderVisibility: value.orderVisibility ?? [...defaultOrderVisibility]}
      : {id: merchantId, merchantId, tier: "standard", collectionModes: ["platform_collect", "agent_collect"], customRedemptionEnabled: true,
          orderVisibility: [...defaultOrderVisibility], version: 0, updatedAt: new Date(0)};
  }
  rules(): TierRules {
    seedDefaultTierRules(this.repository);
    return this.repository.getOperations("tier_rules", "default") ?? {id: "default", merchantId: null, version: 0, metric: "supply_amount",
      enabled: false, levels: defaultTierLevels.map(level => ({...level})), updatedAt: new Date(0)};
  }
  saveRules(actor: Actor, input: Pick<TierRules, "metric" | "enabled" | "levels" | "version">): TierRules {
    requirePermission(actor, "agents.manage");
    if (!input.levels.length || input.levels[0]?.code !== "standard" || input.levels[0].threshold !== 0n
        || new Set(input.levels.map(x => x.code)).size !== input.levels.length
        || input.levels.some((x, i) => !/^[a-z][a-z0-9_-]{1,31}$/.test(x.code) || x.threshold < 0n || (i > 0 && x.threshold <= input.levels[i - 1]!.threshold))) {
      throw new AppError(422, "tier_rules_invalid", "等级必须从 standard/0 开始，门槛递增且编码唯一");
    }
    return this.repository.transaction(() => {
      seedDefaultTierRules(this.repository);
      const current = this.repository.getOperations("tier_rules", "default");
      if (!current || current.version !== input.version) throw new AppError(409, "tier_rules_changed", "等级规则已更新");
      const rules = {...input, id: "default", merchantId: null, version: input.version + 1, updatedAt: new Date()};
      if (this.repository.listOperations("agent_profile").some(p => !rules.levels.some(x => x.code === p.tier))) throw new AppError(409, "tier_in_use", "不能删除仍有代理使用的等级");
      this.repository.saveOperations("tier_rules", rules); this.log(actor, null, "tier.rules.update", rules.id);
      return rules;
    });
  }
  saveCdkSettings(actor: Actor, merchantId: string, input: {cdkCodePrefix: string; cdkCodeTemplate?: string | undefined; version: number}): AgentProfile {
    requireTenantScope(actor, merchantId);
    if (!isPlatform(actor) && actor.role !== "agent_owner") throw new AppError(403, "permission_denied", "仅代理主账号可修改 CDK 格式");
    if (isPlatform(actor)) requirePermission(actor, "agents.manage");
    const cdkCodePrefix = assertCdkPrefix(input.cdkCodePrefix);
    const cdkCodeTemplate = input.cdkCodeTemplate === undefined ? undefined : assertCdkTemplate(input.cdkCodeTemplate);
    return this.repository.transaction(() => {
      const profile = this.profile(merchantId);
      if (profile.version !== input.version) throw new AppError(409, "profile_changed", "代理配置已更新");
      const updated = {...profile, cdkCodePrefix,
        cdkCodeTemplate: cdkCodeTemplate ?? normalizeCdkTemplate(profile.cdkCodeTemplate),
        version: profile.version + 1, updatedAt: new Date()};
      this.repository.saveOperations("agent_profile", updated);
      this.log(actor, merchantId, "agent.cdk_settings.update", merchantId);
      return updated;
    });
  }
  rename(actor: Actor, merchantId: string, input: {name: string}) {
    requireTenantScope(actor, merchantId);
    if (isPlatform(actor)) requirePermission(actor, "agents.manage");
    else if (actor.role !== "agent_owner") throw new AppError(403, "permission_denied", "仅代理主账号可修改代理商名称");
    const name = input.name.replace(/\s+/g, " ").trim();
    if (Array.from(name).length < 1 || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name))
      throw new AppError(422, "agent_name_invalid", "代理商名称应为 1–80 个可见字符，支持中文和英文");
    safeText(name, true);
    return this.repository.transaction(() => {
      const current = this.repository.findMerchantById(merchantId);
      if (!current) throw new AppError(404, "merchant_not_found", "代理商不存在");
      if (current.name === name) return current;
      const updated = {...current, name};
      this.repository.saveMerchant(updated);
      this.log(actor, merchantId, "agent.name.update", merchantId);
      return updated;
    });
  }
  saveProfile(actor: Actor, merchantId: string, input: Pick<AgentProfile, "tier" | "collectionModes" | "version"> &
      {customRedemptionEnabled?: boolean | undefined; cdkCodePrefix?: string | undefined; cdkCodeTemplate?: string | undefined;
        orderVisibility?: AgentProfile["orderVisibility"]}): AgentProfile {
    requirePermission(actor, "agents.manage");
    return this.repository.transaction(() => {
      const profile = this.profile(merchantId), rules = this.rules();
      if (profile.version !== input.version) throw new AppError(409, "profile_changed", "代理配置已更新");
      if (!rules.levels.some(x => x.code === input.tier) || !input.collectionModes.length) throw new AppError(422, "profile_invalid", "等级或销售模式无效");
      const collectionModes = input.tier !== profile.tier ? mergedCollectionModes(input.collectionModes, input.tier, rules) : input.collectionModes;
      const updated = {...profile, tier: input.tier, collectionModes,
        customRedemptionEnabled: input.customRedemptionEnabled ?? profile.customRedemptionEnabled ?? false, version: profile.version + 1, updatedAt: new Date()};
      if (input.cdkCodePrefix !== undefined) updated.cdkCodePrefix = assertCdkPrefix(input.cdkCodePrefix);
      if (input.cdkCodeTemplate !== undefined) updated.cdkCodeTemplate = assertCdkTemplate(input.cdkCodeTemplate);
      updated.orderVisibility = input.orderVisibility ?? profile.orderVisibility ?? [...defaultOrderVisibility];
      this.repository.saveOperations("agent_profile", updated);
      if (input.tier !== profile.tier) this.applyTierPrivileges(merchantId, input.tier, rules, actor);
      this.log(actor, merchantId, "agent.profile.update", merchantId);
      return updated;
    });
  }
  applyTier(actor: Actor, merchantId: string, targetTier: string, reason: string, requestKey: string) {
    requirePermission(actor, "tiers.apply"); requireTenantScope(actor, merchantId); safeText(reason);
    return this.repository.transaction(() => {
      const existing = queryRecords(this.repository,"ticket",{merchantId,filters:[{field:"tierApplication.requestKey",value:requestKey}],limit:1,count:false}).data[0];
      if (existing) {
        const firstMessage = queryRecords(this.repository,"ticket_message",{merchantId,filters:[{field:"ticketId",value:existing.id}],
          orderBy:"createdAt",direction:"asc",limit:1,count:false}).data[0];
        if (existing.tierApplication!.targetTier !== targetTier || firstMessage?.body !== reason) throw new AppError(409, "tier_application_conflict", "同一申请号的内容不能变化");
        return existing;
      }
      if (queryRecords(this.repository,"ticket",{merchantId,filters:[{field:"tierApplication.status",value:"pending"}],limit:1,count:false}).data.length) throw new AppError(409, "tier_application_pending", "已有待审核的等级申请，请在原工单补充说明");
      const profile = this.profile(merchantId), rules = this.rules();
      const target = rules.levels.findIndex(l => l.code === targetTier), current = rules.levels.findIndex(l => l.code === profile.tier);
      if (target <= current) throw new AppError(422, "tier_target_invalid", "请选择高于当前等级的有效目标等级");
      const eligibility = evaluateTierUpgradeEligibility(this.repository, merchantId, targetTier, rules);
      if (!eligibility.eligible) throw new AppError(422, "tier_upgrade_requirements_unmet", eligibility.missing.join("；"));
      const ticket = new SupportService(this.repository, this.audit).create(actor, merchantId, {orderId: null, category: "other",
        title: "会员升级申请：" + rules.levels[target]!.name, body: reason});
      const updated = {...ticket, category: "tier_application" as const, tierApplication: {targetTier, previousTier: profile.tier,
        profileVersion: profile.version, rulesVersion: rules.version, requestKey, status: "pending" as const, reviewReason: null, reviewedBy: null}};
      this.repository.saveOperations("ticket", updated); return updated;
    });
  }
  reviewTier(actor: Actor, ticketId: string, approve: boolean, reason: string, version: number) {
    requirePermission(actor, "agents.manage"); safeText(reason, true);
    return this.repository.transaction(() => {
      const ticket = this.repository.getOperations("ticket", ticketId), application = ticket?.tierApplication;
      if (!ticket || !application) throw new AppError(404, "tier_application_not_found", "等级申请不存在");
      const decision = approve ? "approved" : "rejected";
      if (application.status === decision && application.reviewReason === reason) return ticket;
      if (application.status !== "pending" || ticket.version !== version) throw new AppError(409, "tier_application_changed", "申请已处理或已更新，请刷新");
      if (approve) {
        const profile = this.profile(ticket.merchantId), rules = this.rules();
        if (profile.version !== application.profileVersion || rules.version !== application.rulesVersion) throw new AppError(409, "tier_basis_changed", "等级或规则已变化，请驳回后按新规则重新申请");
        const eligibility = evaluateTierUpgradeEligibility(this.repository, ticket.merchantId, application.targetTier, rules);
        if (!eligibility.eligible) throw new AppError(409, "tier_upgrade_requirements_unmet", "申请时已不符合升级条件：" + eligibility.missing.join("；"));
        this.saveProfile(actor, ticket.merchantId, {...profile, tier: application.targetTier, collectionModes: mergedCollectionModes(profile.collectionModes, application.targetTier, rules)});
      }
      const updated = {...ticket, status: "resolved" as const, version: ticket.version + 1, publicVersion: ticket.publicVersion + 1,
        updatedAt: new Date(), tierApplication: {...application, status: decision as "approved" | "rejected", reviewReason: reason, reviewedBy: actor.id}};
      this.repository.saveOperations("ticket", updated);
      this.repository.saveOperations("ticket_message", {id: randomUUID(), merchantId: ticket.merchantId, ticketId, actorId: actor.id, author: "platform", internal: false,
        body: (approve ? "会员升级已通过，对应权益已同步开通。" : "会员升级未通过。") + reason, createdAt: new Date()}, true);
      this.log(actor, ticket.merchantId, "tier.application." + decision, ticketId); return updated;
    });
  }
  summary(actor: Actor, merchantId: string) {
    requireTenantScope(actor, merchantId);
    const profile = this.profile(merchantId);
    const effective = effectiveCollectionModes(this.repository, merchantId, profile);
    const visibleProfile = isPlatform(actor) ? profile : {...profile, collectionModes: effective};
    const completed = completedTierOrderMetrics(this.repository, merchantId);
    const productSupplyPrices = Object.fromEntries(
      globalProductGrantsForMerchant(this.repository, merchantId).filter(grant => grant.available)
        .map(grant => [grant.productCode, grant.supplyPriceMinor.toString()]),
    );
    const merchant = this.repository.findMerchantById(merchantId)!;
    return {merchant: {id: merchant.id, partnerId: merchant.partnerId, name: merchant.name, status: merchant.status},
      profile: visibleProfile, completedOrders: completed.completedOrders, completedSupplyMinor: completed.completedSupplyMinor.toString(),
      productSupplyPrices, collectionModes: effective, customRedemptionEnabled: profile.customRedemptionEnabled};
  }
  private createMerchantBundle(partnerId: string, name: string) {
    const merchant = {id: randomUUID(), partnerId, name, status: "active" as const};
    this.repository.saveMerchant(merchant);
    seedGlobalProductCatalog(this.repository);
    for (const grant of globalProductGrantsForMerchant(this.repository, merchant.id)) {
      this.repository.saveProductGrant(grant);
    }
    const rules = this.rules(), benefits = resolveTierBenefits("standard", rules);
    const profile: AgentProfile = {id: merchant.id, merchantId: merchant.id, tier: "standard", collectionModes: [...benefits.collectionModes],
      customRedemptionEnabled: true, orderVisibility: [...defaultOrderVisibility], version: 1, updatedAt: new Date()};
    this.repository.saveOperations("agent_profile", profile);
    this.repository.saveOperations("api_access", {id: merchant.id, merchantId: merchant.id, enabled: true,
      depositId: "default:open-api", ticketId: "", version: 1, updatedAt: new Date()}, true);
    return {merchant, profile};
  }
  private applyTierPrivileges(merchantId: string, tierCode: string, rules: TierRules, actor: Actor): void {
    const benefits = resolveTierBenefits(tierCode, rules);
    if (!benefits.apiIncluded) return;
    const current = this.repository.getOperations("api_access", merchantId);
    if (current?.enabled) return;
    this.repository.saveOperations("api_access", {id: merchantId, merchantId, enabled: true, depositId: current?.depositId ?? "tier:" + tierCode,
      ticketId: current?.ticketId ?? "", version: (current?.version ?? 0) + 1, updatedAt: new Date()});
    this.log(actor, merchantId, "tier.api.grant", merchantId);
  }
  private throttleRegistration(ip: string): void {
    const id = createHmac("sha256", "registration").update("register-ip:" + ip).digest("hex");
    const old = this.repository.getOperations("login_throttle", id);
    const current = old && old.expiresAt > new Date() ? old : {id, merchantId: null, count: 0, expiresAt: new Date(Date.now() + 900_000)};
    if (current.count >= 10) throw new AppError(429, "registration_throttled", "注册尝试过于频繁，请稍后再试");
    this.repository.saveOperations("login_throttle", {...current, count: current.count + 1});
  }
  private log(actor: Actor, merchantId: string | null, action: string, targetId: string) {
    this.audit.record({merchantId, actorId: actor.id, actorType: "platform_user", action, targetType: "agent", targetId, requestId: randomUUID()});
  }
}
function defaultCdkPrefix(partnerId: string): string {
  return normalizeCdkPrefix(partnerId.replace(/[^a-z0-9]/gi, "").slice(0, 8));
}

function suggestPartnerIdFromEmail(email: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") ?? "agent";
  const base = (local || "agent").slice(0, 48);
  let candidate = (/^[a-z0-9]/.test(base) ? base : `a_${base}`).slice(0, 63);
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(candidate)) candidate = ("agent_" + randomBytes(3).toString("hex")).slice(0, 63);
  return candidate;
}
