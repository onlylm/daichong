import {createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import {AppError} from "../domain/errors.js";
import {AuditService} from "../modules/audit-service.js";
import type {Account, AccountRole, Actor} from "./model.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import {resolveTierBenefits} from "./tier-benefits.js";
import {queryRecords} from "../infra/record-query.js";

const permissions: Record<Actor["role"], string[]> = {
  platform_admin: ["*"],
  platform_support: ["tickets.read", "tickets.write", "tickets.manage", "announcements.read", "announcements.manage", "agents.read"],
  platform_finance: ["tickets.read", "announcements.read", "agents.read", "orders.read", "wallet.read", "wallet.review", "invoices.read", "invoices.manage"],
  platform_auditor: ["tickets.read", "announcements.read", "agents.read", "orders.read", "wallet.read", "accounts.read", "invoices.read", "audit.read"],
  agent_owner: ["orders.read", "orders.write", "tickets.read", "tickets.write", "announcements.read", "wallet.read", "wallet.deposit", "wallet.withdraw", "wallet.transfer", "accounts.read", "accounts.manage", "tiers.read", "tiers.apply", "api.read", "api.apply", "api.keys", "invoices.read", "invoices.write"],
  agent_staff: ["orders.read", "tickets.read", "tickets.write", "announcements.read", "tiers.read"],
  agent_finance: ["orders.read", "tickets.read", "announcements.read", "wallet.read", "wallet.deposit", "tiers.read", "invoices.read", "invoices.write"],
  agent_api: ["tickets.read", "tickets.write", "announcements.read", "wallet.read", "tiers.read", "tiers.apply"],
};
export function requirePermission(actor: Actor, permission: string): void {
  if (!permissions[actor.role].includes("*") && !permissions[actor.role].includes(permission)) throw new AppError(403, "permission_denied", "无权执行此操作");
}
export function isPlatform(actor: Actor): boolean { return actor.role.startsWith("platform_") && actor.merchantId === null; }
export function requireTenantScope(actor: Actor, merchantId: string): void {
  if (!isPlatform(actor) && actor.merchantId !== merchantId) throw new AppError(404, "resource_not_found", "资源不存在");
}
export function publicAccount(account: Account) {
  return {id: account.id, username: account.username, displayName: account.displayName, role: account.role,
    merchantId: account.merchantId, status: account.status, mustChangePassword: account.mustChangePassword, mfaEnabled: Boolean(account.mfaEnabled)};
}
export function permissionList(actor: Actor): string[] { return permissions[actor.role]; }

export type AccountSession = {account: Account; token: string; csrf: string};
export type PasswordLoginResult = AccountSession | {mfa: {
  required: true; challengeToken: string; enrollment: boolean; secret?: string; otpauthUri?: string;
}};

export class AccountService {
  private hashing = 0;
  constructor(private readonly repository: Repository, private readonly audit: AuditService, private readonly secret: string,
    private readonly cipher: SensitivePayloadCipher) {}

  async bootstrap(username: string, password: string): Promise<Account> {
    const passwordHash = await this.hash(password);
    return this.repository.transaction(() => {
      if (queryRecords(this.repository,"account",{filters:[{field:"role",value:"platform_admin"}],limit:1,count:false}).data.length) throw new AppError(409, "admin_exists", "管理员已存在，不能重复初始化");
      return this.insert({id: "local-bootstrap", role: "platform_admin", merchantId: null}, {username, displayName: "平台管理员", role: "platform_admin", merchantId: null}, passwordHash, false);
    });
  }

  async create(actor: Actor, input: {username: string; displayName: string; role: AccountRole; merchantId: string | null; password: string}): Promise<Account> {
    requirePermission(actor, "accounts.manage");
    if (isPlatform(actor)) this.assertPlatformStaffCreate(input.role, input.merchantId);
    this.assertAccountScope(actor, input.role, input.merchantId);
    if (input.merchantId && input.role !== "agent_owner") this.assertStaffLimit(input.merchantId);
    const passwordHash = await this.hash(input.password);
    return this.repository.transaction(() => this.insert(actor, input, passwordHash, true));
  }

  async registerOwner(input: {username: string; displayName: string; password: string; merchantId: string}): Promise<Account> {
    const passwordHash = await this.hash(input.password);
    return this.registerOwnerWithHash(input, passwordHash);
  }

  async hashPassword(password: string): Promise<string> {
    return this.hash(password);
  }

  registerOwnerWithHash(input: {username: string; displayName: string; merchantId: string}, passwordHash: string): Account {
    this.assertStaffLimit(input.merchantId, true);
    const actor: Actor = {id: "registration", role: "platform_admin", merchantId: null};
    return this.insert(actor, {username: input.username, displayName: input.displayName, role: "agent_owner", merchantId: input.merchantId}, passwordHash, false);
  }

  issueSessionFor(account: Account): AccountSession {
    return this.repository.transaction(() => this.issueSession(account));
  }

  issueSessionInsideTransaction(account: Account): AccountSession {
    return this.issueSession(account);
  }

  list(actor: Actor): ReturnType<typeof publicAccount>[] {
    requirePermission(actor, "accounts.read");
    const result=queryRecords(this.repository,"account",isPlatform(actor)
      ?{filters:[{field:"merchantId",op:"is_null"}],orderBy:"createdAt",direction:"asc",limit:500,count:false}
      :{merchantId:actor.merchantId!,orderBy:"createdAt",direction:"asc",limit:500,count:false});
    const visible = isPlatform(actor) ? result.data.filter(isPlatformAccount) : result.data;
    return visible.map(publicAccount);
  }

  listForAgent(actor: Actor, merchantId: string): ReturnType<typeof publicAccount>[] {
    requirePermission(actor, isPlatform(actor) ? "agents.read" : "accounts.read");
    requireTenantScope(actor, merchantId);
    if (!this.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
    const roleOrder: Record<AccountRole, number> = {agent_owner: 0, agent_staff: 1, agent_finance: 2,
      platform_admin: 9, platform_support: 9, platform_finance: 9, platform_auditor: 9};
    return queryRecords(this.repository,"account",{merchantId,filters:[{field:"role",op:"in",value:["agent_owner","agent_staff","agent_finance"]}],
      orderBy:"createdAt",direction:"asc",limit:500,count:false}).data
      .sort((a, b) => (roleOrder[a.role] - roleOrder[b.role]) || a.displayName.localeCompare(b.displayName, "zh-CN"))
      .map(publicAccount);
  }

  update(actor: Actor, id: string, role: AccountRole, status: Account["status"]): Account {
    requirePermission(actor, "accounts.manage");
    return this.repository.transaction(() => {
      const target = this.repository.getOperations("account", id);
      if (!target) throw new AppError(404, "account_not_found", "账号不存在");
      requireTenantScope(actor, target.merchantId ?? "_platform");
      if (isPlatform(actor) && isPlatformAccount(target) && !isPlatformRole(role, target.merchantId)) {
        throw new AppError(422, "platform_account_scope_required", "后台账号仅可维护平台内部账号");
      }
      if (isPlatform(actor) && !isPlatformAccount(target) && isPlatformRole(role, target.merchantId)) {
        throw new AppError(422, "agent_account_scope_required", "代理商账号请在代理商管理中维护");
      }
      this.assertAccountScope(actor, role, target.merchantId);
      if (actor.role !== "platform_admin" && target.role === "agent_owner") throw new AppError(403, "owner_protected", "代理主账号只能由平台调整");
      if (target.role === "platform_admin" && (role !== target.role || status !== "active")
          && queryRecords(this.repository,"account",{filters:[{field:"role",value:"platform_admin"},{field:"status",value:"active"}],limit:1}).meta.total <= 1) {
        throw new AppError(409, "last_admin", "不能禁用或降权最后一名管理员");
      }
      const updated = {...target, role, status, authVersion: target.authVersion + 1, updatedAt: new Date()};
      this.repository.saveOperations("account", updated);
      this.log(actor, "account.update", id, target.merchantId);
      return updated;
    });
  }

  async login(username: string, password: string, ip: string): Promise<PasswordLoginResult> {
    const normalized = username.toLowerCase().trim();
    this.repository.transaction(() => {
      const id = createHmac("sha256", this.secret).update("login-ip:" + ip).digest("hex");
      const old = this.repository.getOperations("login_throttle", id);
      const current = old && old.expiresAt > new Date() ? old : {id, merchantId: null, count: 0, expiresAt: new Date(Date.now() + 900_000)};
      if (current.count >= 30) throw new AppError(429, "login_throttled", "尝试过于频繁，请稍后再试");
      this.repository.saveOperations("login_throttle", {...current, count: current.count + 1});
    });
    const found = queryRecords(this.repository,"account",{filters:[{field:"username",value:normalized}],limit:1,count:false}).data[0];
    const valid = await this.verify(password, found?.passwordHash ?? "");
    const result = this.repository.transaction(() => {
      const current = found ? this.repository.getOperations("account", found.id) : null;
      if (!current || current.status !== "active" || current.authVersion !== found?.authVersion || (current.lockedUntil && current.lockedUntil > new Date())) return null;
      if (!valid) {
        const failedLogins = current.failedLogins + 1;
        this.repository.saveOperations("account", {...current, failedLogins, lockedUntil: failedLogins >= 6 ? new Date(Date.now() + 900_000) : null});
        return null;
      }
      if (current.merchantId && this.repository.findMerchantById(current.merchantId)?.status !== "active") return null;
      const account = {...current, failedLogins: 0, lockedUntil: null};
      this.repository.saveOperations("account", account);
      if (!isPlatformAccount(account)) return this.issueSession(account);
      const challengeToken = randomBytes(32).toString("base64url"), challengeId = digest(challengeToken), enrollment = !account.mfaEnabled || !account.mfaSecret;
      const secret = enrollment ? base32Encode(randomBytes(20)) : undefined;
      this.repository.saveOperations("mfa_challenge", {id: challengeId, merchantId: null, accountId: account.id,
        purpose: enrollment ? "enroll" : "login", encryptedSecret: secret ? this.cipher.encrypt(secret, "mfa-challenge:" + challengeId) : null,
        authVersion: account.authVersion, failedAttempts: 0, expiresAt: new Date(Date.now() + 5 * 60_000), createdAt: new Date()}, true);
      return {mfa: {required: true as const, challengeToken, enrollment, ...(secret ? {secret,
        otpauthUri: `otpauth://totp/${encodeURIComponent("Tibo:" + account.username)}?secret=${secret}&issuer=Tibo&algorithm=SHA1&digits=6&period=30`} : {})}};
    });
    if (!result) throw new AppError(401, "invalid_credentials", "账号或密码不正确，或账号暂不可用");
    return result;
  }

  verifyMfa(challengeToken: string, code: string): AccountSession & {recoveryCodes?: string[]} {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challengeToken)) throw new AppError(401, "mfa_challenge_invalid", "验证请求已失效，请重新登录");
    const challengeId = digest(challengeToken), normalizedCode = code.trim();
    const result = this.repository.transaction(() => {
      const challenge = this.repository.getOperations("mfa_challenge", challengeId);
      const account = challenge && this.repository.getOperations("account", challenge.accountId);
      if (!challenge || challenge.expiresAt <= new Date() || challenge.failedAttempts >= 5 || !account || account.status !== "active"
          || account.authVersion !== challenge.authVersion || !isPlatformAccount(account)) return {error: "expired" as const};
      const encryptedSecret = challenge.purpose === "enroll" ? challenge.encryptedSecret : account.mfaSecret;
      if (!encryptedSecret) return {error: "expired" as const};
      const secret = String(this.cipher.decrypt(encryptedSecret, challenge.purpose === "enroll" ? "mfa-challenge:" + challenge.id : "mfa-account:" + account.id));
      const matchedStep = matchTotpStep(secret, normalizedCode);
      const recoveryIndex = challenge.purpose === "login" && matchedStep === null
        ? (account.mfaRecoveryCodeHashes ?? []).findIndex(hash => equal(hash, this.recoveryHash(account.id, normalizedCode))) : -1;
      if (matchedStep === null && recoveryIndex < 0) {
        const failedAttempts = challenge.failedAttempts + 1;
        this.repository.saveOperations("mfa_challenge", {...challenge, failedAttempts,
          expiresAt: failedAttempts >= 5 ? new Date(0) : challenge.expiresAt});
        return {error: "invalid" as const};
      }
      if (matchedStep !== null && matchedStep <= (account.mfaLastUsedStep ?? -1)) return {error: "reused" as const};
      this.repository.saveOperations("mfa_challenge", {...challenge, expiresAt: new Date(0)});
      if (challenge.purpose === "enroll") {
        const recoveryCodes = Array.from({length: 10}, () => recoveryCode());
        const updated: Account = {...account, mfaEnabled: true, mfaSecret: this.cipher.encrypt(secret, "mfa-account:" + account.id),
          mfaRecoveryCodeHashes: recoveryCodes.map(value => this.recoveryHash(account.id, value)), mfaLastUsedStep: matchedStep,
          authVersion: account.authVersion + 1, updatedAt: new Date()};
        this.repository.saveOperations("account", updated);
        this.log(updated, "account.mfa.enroll", updated.id, updated.merchantId);
        return {...this.issueSession(updated), recoveryCodes};
      }
      const usedRecovery = recoveryIndex >= 0;
      const hashes = [...(account.mfaRecoveryCodeHashes ?? [])];
      if (usedRecovery) hashes.splice(recoveryIndex, 1);
      const updated: Account = {...account, mfaLastUsedStep: matchedStep ?? account.mfaLastUsedStep ?? null,
        mfaRecoveryCodeHashes: hashes, authVersion: account.authVersion + (usedRecovery ? 1 : 0), updatedAt: new Date()};
      this.repository.saveOperations("account", updated);
      if (usedRecovery) this.log(updated, "account.mfa.recovery_used", updated.id, updated.merchantId);
      return this.issueSession(updated);
    });
    if ("error" in result) {
      if (result.error === "invalid") throw new AppError(401, "mfa_code_invalid", "验证码或恢复码不正确");
      if (result.error === "reused") throw new AppError(401, "mfa_code_reused", "该动态验证码已使用，请等待下一组验证码");
      throw new AppError(401, "mfa_challenge_invalid", "验证请求已失效，请重新登录");
    }
    return result;
  }

  authenticate(token: string): Account {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, "login_required", "请先登录");
    const session = this.repository.getOperations("session", digest(token));
    const account = session && this.repository.getOperations("account", session.accountId);
    if (!session || session.expiresAt <= new Date() || !account || account.status !== "active" || session.authVersion !== account.authVersion
        || (account.merchantId && this.repository.findMerchantById(account.merchantId)?.status !== "active")) {
      throw new AppError(401, "login_required", "登录已失效，请重新登录");
    }
    return account;
  }

  logout(token: string): void {
    const session = this.repository.getOperations("session", digest(token));
    if (session) this.repository.saveOperations("session", {...session, expiresAt: new Date(0)});
  }
  csrf(token: string): string { return createHmac("sha256", this.secret).update("csrf:" + token).digest("base64url"); }
  verifyCsrf(token: string, csrf: string): boolean { return equal(this.csrf(token), csrf); }

  async changePassword(account: Account, currentPassword: string, nextPassword: string): Promise<void> {
    if (!await this.verify(currentPassword, account.passwordHash)) throw new AppError(401, "password_incorrect", "当前密码不正确");
    const passwordHash = await this.hash(nextPassword);
    this.repository.transaction(() => {
      const current = this.repository.getOperations("account", account.id)!;
      if (current.authVersion !== account.authVersion) throw new AppError(409, "account_changed", "账号已变化，请重新登录");
      this.repository.saveOperations("account", {...current, passwordHash, mustChangePassword: false, authVersion: current.authVersion + 1, updatedAt: new Date()});
      this.log(account, "account.password.change", account.id, account.merchantId);
    });
  }

  private insert(actor: Actor, input: {username: string; displayName: string; role: AccountRole; merchantId: string | null}, passwordHash: string, mustChangePassword: boolean): Account {
    const username = input.username.toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9_.@-]{2,79}$/.test(username)) throw new AppError(422, "invalid_username", "账号名使用 3–80 位字母、数字或 ._@-");
    if (queryRecords(this.repository,"account",{filters:[{field:"username",value:username}],limit:1,count:false}).data.length) throw new AppError(409, "username_exists", "账号名已存在");
    const account: Account = {id: randomUUID(), merchantId: input.merchantId, username, displayName: input.displayName,
      role: input.role, status: "active", passwordHash, mustChangePassword, authVersion: 1, failedLogins: 0, lockedUntil: null,
      mfaEnabled: false, mfaSecret: null, mfaRecoveryCodeHashes: [], mfaLastUsedStep: null, createdAt: new Date(), updatedAt: new Date()};
    this.repository.saveOperations("account", account, true);
    this.log(actor, "account.create", account.id, account.merchantId);
    return account;
  }
  private assertPlatformStaffCreate(role: AccountRole, merchantId: string | null): void {
    if (merchantId === null && !isPlatformRole(role, merchantId)) {
      throw new AppError(422, "platform_account_scope_required", "平台内部账号必须使用平台角色");
    }
    if (merchantId !== null && !role.startsWith("agent_")) {
      throw new AppError(422, "agent_account_scope_required", "代理商账号必须使用代理角色");
    }
  }
  private assertAccountScope(actor: Actor, role: AccountRole, merchantId: string | null): void {
    if (role.startsWith("platform_") !== (merchantId === null)) throw new AppError(422, "invalid_account_scope", "账号类型与代理归属不一致");
    if (merchantId && !this.repository.findMerchantById(merchantId)) throw new AppError(404, "merchant_not_found", "代理商不存在");
    if (actor.role !== "platform_admin" && (actor.merchantId !== merchantId || !["agent_staff", "agent_finance"].includes(role))) throw new AppError(403, "role_assignment_denied", "不能授予该角色");
  }
  private assertStaffLimit(merchantId: string, includeOwner = false): void {
    const profile = this.repository.getOperations("agent_profile", merchantId);
    const rules = this.repository.getOperations("tier_rules", "default");
    const benefits = resolveTierBenefits(profile?.tier ?? "standard", rules ?? {id: "default", merchantId: null, version: 0, metric: "supply_amount", enabled: false, levels: [], updatedAt: new Date(0)});
    const roles=includeOwner?["agent_owner","agent_staff","agent_finance"]:["agent_staff","agent_finance"];
    const staffCount=queryRecords(this.repository,"account",{merchantId,filters:[{field:"status",value:"active"},{field:"role",op:"in",value:roles}],limit:1}).meta.total;
    const limit = includeOwner ? benefits.maxStaffAccounts + 1 : benefits.maxStaffAccounts;
    if (staffCount >= limit) throw new AppError(409, "staff_limit_reached", "当前会员等级最多可创建 " + benefits.maxStaffAccounts + " 个子账号");
  }
  private async hash(password: string): Promise<string> {
    if (password.length < 8 || Buffer.byteLength(password) > 1024) throw new AppError(422, "weak_password", "密码不符合要求");
    const salt = randomBytes(16).toString("hex");
    const hash = await this.derive(password, salt);
    return "scrypt$32768$8$3$" + salt + "$" + hash.toString("hex");
  }
  private async verify(password: string, stored: string): Promise<boolean> {
    if (Buffer.byteLength(password) > 1024) return false;
    const parts = stored.split("$");
    const salt = parts[4] || "00000000000000000000000000000000";
    const result = await this.derive(password, salt);
    return parts.length === 6 && equal(result.toString("hex"), parts[5] ?? "");
  }
  private async derive(password: string, salt: string): Promise<Buffer> {
    if (this.hashing >= 4) throw new AppError(429, "login_busy", "登录服务繁忙，请稍后再试");
    this.hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, {N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024}, (error, key) => error ? reject(error) : resolve(key)));
    } finally {this.hashing--;}
  }
  private issueSession(account: Account): AccountSession {
    const token = randomBytes(32).toString("base64url");
    this.repository.saveOperations("session", {id: digest(token), merchantId: account.merchantId, accountId: account.id,
      authVersion: account.authVersion, createdAt: new Date(), expiresAt: new Date(Date.now() + 8 * 3600_000)}, true);
    this.log(account, "account.login", account.id, account.merchantId);
    return {account, token, csrf: this.csrf(token)};
  }
  private recoveryHash(accountId: string, code: string): string {
    return createHmac("sha256", this.secret).update("mfa-recovery:" + accountId + ":" + normalizeRecovery(code)).digest("hex");
  }
  private log(actor: Actor, action: string, id: string, merchantId: string | null): void {
    this.audit.record({merchantId, actorId: actor.id, actorType: isPlatform(actor) ? "platform_user" : "merchant_user", action, targetType: "account", targetId: id, requestId: randomUUID()});
  }
}
function digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function isPlatformRole(role: AccountRole, merchantId: string | null): boolean { return merchantId === null && role.startsWith("platform_"); }
function isPlatformAccount(account: Account): boolean { return isPlatformRole(account.role, account.merchantId); }
function recoveryCode(): string { const raw = randomBytes(5).toString("hex").toUpperCase(); return raw.slice(0, 5) + "-" + raw.slice(5); }
function normalizeRecovery(value: string): string { return value.toUpperCase().replace(/[^A-F0-9]/g, ""); }
function base32Encode(value: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, buffer = 0, output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) {bits -= 5; output += alphabet[(buffer >>> bits) & 31];}
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}
function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, "")) {
    const index = alphabet.indexOf(character); if (index < 0) throw new Error("invalid_base32");
    buffer = (buffer << 5) | index; bits += 5;
    if (bits >= 8) {bits -= 8; output.push((buffer >>> bits) & 255);}
  }
  return Buffer.from(output);
}
export function totpCodeAt(secret: string, time = Date.now()): string {
  const step = Math.floor(time / 30_000), counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const value = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = value[value.length - 1]! & 15;
  const number = (value.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, "0");
}
function matchTotpStep(secret: string, code: string, time = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(time / 30_000);
  for (const offset of [-1, 0, 1]) if (equal(totpCodeAt(secret, (current + offset) * 30_000), code)) return current + offset;
  return null;
}
