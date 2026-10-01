import {createHash, createPrivateKey, createPublicKey, randomUUID} from "node:crypto";
import {z} from "zod";
import type {AppConfig} from "../config.js";
import {AppError} from "../domain/errors.js";
import type {Repository} from "../infra/repository.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import type {Actor, PaymentChannel, PaymentRevision, PaymentSettings} from "../operations/model.js";
import {AuditService} from "./audit-service.js";
import {DujiaoClient, USDT_NETWORKS} from "./dujiaopay-client.js";
import {LiveTestPolicy} from "./live-test-policy.js";

const secret = z.string().trim().max(16000).default("");
const identifier = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,160}$/);
export const paymentConfigInput = z.discriminatedUnion("channel", [
  z.object({channel: z.literal("alipay_page"), version: z.number().int().nonnegative(),
    appId: z.string().regex(/^\d{16}$/), sellerId: z.string().regex(/^\d{16}$/), keyType: z.enum(["PKCS1", "PKCS8"]),
    privateKey: secret, publicKey: secret}).strict(),
  z.object({channel: z.literal("dujiaopay"), version: z.number().int().nonnegative(),
    merchantId: identifier, projectId: identifier, keyId: identifier, network: z.enum(["tron", "ethereum", "bsc", "solana"]),
    apiSecret: secret, webhookSecret: secret}).strict(),
]);
export type PaymentConfigInput = z.input<typeof paymentConfigInput>;
export function requirePaymentAdmin(actor: Actor): void {
  if (actor.role !== "platform_admin" || actor.merchantId !== null) throw new AppError(403, "permission_denied", "仅平台管理员可管理支付配置");
}
function pem(value: string, label: string): string {
  return value.includes("-----BEGIN ") ? value.trim() : "-----BEGIN " + label + "-----\n" + (value.replace(/\s/g, "").match(/.{1,64}/g) ?? []).join("\n") + "\n-----END " + label + "-----";
}
export class PaymentSettingsService {
  constructor(private readonly repo: Repository, private readonly cipher: SensitivePayloadCipher,
    private readonly config: AppConfig, private readonly audit: AuditService) {}
  state(channel: PaymentChannel): PaymentSettings {
    return this.repo.getOperations("payment_settings", channel) ?? {id: channel, merchantId: null, channel, version: 0, draftId: null, activeId: null, paused: true, updatedAt: new Date()};
  }
  revision(id: string, channel?: PaymentChannel): PaymentRevision {
    const value = this.repo.getOperations("payment_revision", id);
    if (!value || (channel && value.channel !== channel)) throw new AppError(404, "payment_config_not_found", "支付配置不存在");
    return value;
  }
  secrets(revision: PaymentRevision): Record<string, string> {
    return this.cipher.decrypt(revision.encrypted, "payment:" + revision.id) as Record<string, string>;
  }
  list(actor: Actor) {
    requirePaymentAdmin(actor);
    return {mode: this.config.paymentProvider ?? "mock", executionMode: this.config.executionMode, channels: (["alipay_page", "dujiaopay"] as const).map(channel => {
      const state = this.state(channel);
      const view = (id: string | null) => {
        if (!id) return null;
        const r = this.revision(id), check = this.repo.getOperations("payment_check", id);
        return {id: r.id, details: r.details, fingerprint: r.fingerprint, secretsConfigured: true, createdAt: r.createdAt,
          check: check ? {kind: check.kind, checkedAt: check.checkedAt} : null,
          webhookUrl: this.config.publicBaseUrl + (r.channel === "dujiaopay" ? "/internal/webhooks/dujiaopay/" + r.id : "/internal/webhooks/alipay")};
      };
      return {...state, draft: view(state.draftId), active: view(state.activeId)};
    }), networks: Object.entries(USDT_NETWORKS).map(([value, n]) => ({value, label: n.label}))};
  }
  save(actor: Actor, raw: PaymentConfigInput) {
    requirePaymentAdmin(actor); this.safeStorage();
    const input = paymentConfigInput.parse(raw);
    return this.repo.transaction(() => {
      const state = this.state(input.channel); this.version(state, input.version);
      const oldId = state.draftId ?? state.activeId;
      const old = oldId ? this.revision(oldId) : null, oldSecrets = old ? this.secrets(old) : {};
      let details: Record<string, string>, credentials: Record<string, string>, fingerprint: string;
      if (input.channel === "alipay_page") {
        if (old && (old.details.appId !== input.appId || old.details.keyType !== input.keyType) && (!input.privateKey || !input.publicKey)) throw new AppError(422, "payment_keys_required", "切换应用或密钥格式时，请重新填写两份密钥");
        const privateKey = input.privateKey || oldSecrets.privateKey || "", publicKey = input.publicKey || oldSecrets.publicKey || "";
        try {
          const a = createPrivateKey(pem(privateKey, input.keyType === "PKCS1" ? "RSA PRIVATE KEY" : "PRIVATE KEY"));
          const b = createPublicKey(pem(publicKey, "PUBLIC KEY"));
          if (a.asymmetricKeyType !== "rsa" || b.asymmetricKeyType !== "rsa" || (a.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || (b.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("rsa_key_required");
          credentials = {privateKey: a.export({type: input.keyType === "PKCS1" ? "pkcs1" : "pkcs8", format: "pem"}).toString(), publicKey: b.export({type: "spki", format: "pem"}).toString()};
          fingerprint = createHash("sha256").update(createPublicKey(a).export({type: "spki", format: "der"})).digest("hex");
        } catch {throw new AppError(422, "invalid_payment_keys", "请填写有效的 RSA 密钥（至少 2048 位）；公钥须来自支付宝开放平台");}
        details = {appId: input.appId, sellerId: input.sellerId, keyType: input.keyType};
      } else {
        const changed = old && ["merchantId", "projectId", "keyId"].some(k => old.details[k] !== input[k as "merchantId" | "projectId" | "keyId"]);
        if (changed && (!input.apiSecret || !input.webhookSecret)) throw new AppError(422, "payment_keys_required", "切换项目或 Key ID 时，请重新填写 API 和回调密钥");
        credentials = {apiSecret: input.apiSecret || oldSecrets.apiSecret || "", webhookSecret: input.webhookSecret || oldSecrets.webhookSecret || ""};
        if (Object.values(credentials).some(v => v.length < 16 || v.length > 512)) throw new AppError(422, "invalid_payment_keys", "请分别填写 API 与回调密钥，不要填写钱包私钥或助记词");
        details = {merchantId: input.merchantId, projectId: input.projectId, keyId: input.keyId, network: input.network, tokenId: USDT_NETWORKS[input.network].tokenId};
        fingerprint = createHash("sha256").update(input.keyId).digest("hex");
      }
      const id = "pc_" + randomUUID().replaceAll("-", "");
      this.repo.saveOperations("payment_revision", {id, merchantId: null, channel: input.channel, details, fingerprint,
        encrypted: this.cipher.encrypt(credentials, "payment:" + id), createdAt: new Date()}, true);
      this.repo.saveOperations("payment_settings", {...state, draftId: id, version: state.version + 1, updatedAt: new Date()});
      this.log(actor, "payment.config.save", id); return this.list(actor);
    });
  }
  async check(actor: Actor, channel: PaymentChannel, version: number) {
    requirePaymentAdmin(actor); this.safeStorage();
    const state = this.state(channel); this.version(state, version);
    if (!state.draftId) throw new AppError(409, "payment_draft_required", "请先保存配置草稿");
    const r = this.revision(state.draftId);
    if (channel === "dujiaopay") {
      const who = await this.client(r).whoami();
      if (who.merchant_id !== r.details.merchantId || who.project_id !== r.details.projectId || who.api_key_id !== r.details.keyId) throw new AppError(422, "payment_identity_mismatch", "商户、项目或 Key ID 与凭据身份不一致");
    }
    return this.repo.transaction(() => {
      this.version(this.state(channel), version);
      this.repo.saveOperations("payment_check", {id: r.id, merchantId: null, revisionId: r.id, checkedAt: new Date().toISOString(), kind: channel === "dujiaopay" ? "remote_identity" : "local_keys"});
      this.log(actor, "payment.config.check", r.id); return this.list(actor);
    });
  }
  activate(actor: Actor, channel: PaymentChannel, version: number) {
    requirePaymentAdmin(actor); this.safeStorage(); LiveTestPolicy.validate(this.config);
    if (this.config.executionMode === "disabled") throw new AppError(409, "transactions_disabled", "生产交易总开关当前关闭，不能启用收款通道");
    if (this.config.paymentProvider !== "managed") throw new AppError(409, "managed_payments_required", "部署尚未切换到后台管理支付模式");
    return this.repo.transaction(() => {
      const s = this.state(channel); this.version(s, version);
      const check = s.draftId ? this.repo.getOperations("payment_check", s.draftId) : null;
      if (!check || Date.now() - Date.parse(check.checkedAt) > 30 * 60_000) throw new AppError(409, "payment_check_required", "请先验证当前草稿；验证结果有效期 30 分钟");
      this.repo.saveOperations("payment_settings", {...s, activeId: s.draftId, paused: false, version: s.version + 1, updatedAt: new Date()});
      this.log(actor, "payment.config.activate", s.draftId!); return this.list(actor);
    });
  }
  pauseMany(actor: Actor, items: Array<{channel: PaymentChannel; version: number}>) {
    requirePaymentAdmin(actor);
    if (this.config.paymentProvider !== "managed") throw new AppError(409, "managed_payments_required", "部署尚未切换到后台管理支付模式，不能用此开关关闭文件模式");
    if (items.length < 1 || items.length > 2 || new Set(items.map(x => x.channel)).size !== items.length) throw new AppError(422, "invalid_channels", "请选择要关闭的通道");
    return this.repo.transaction(() => {
      const states = items.map(x => {const s = this.state(x.channel); this.version(s, x.version); return s;});
      for (const s of states) {
        this.repo.saveOperations("payment_settings", {...s, paused: true, version: s.version + 1, updatedAt: new Date()});
        this.log(actor, "payment.config.pause", s.channel);
      }
      return this.list(actor);
    });
  }
  available(): PaymentChannel[] {
    if (this.config.executionMode === "disabled") return [];
    if (this.config.paymentProvider !== "managed") return this.config.paymentProvider === "alipay_page" ? ["alipay_page"] : [];
    return (["alipay_page", "dujiaopay"] as const).filter(c => {const s = this.state(c); return !s.paused && !!s.activeId;});
  }
  active(channel?: PaymentChannel): PaymentRevision {
    const chosen = channel ?? this.available()[0];
    if (!chosen || !this.available().includes(chosen)) throw new AppError(409, "payment_channel_disabled", "该支付通道尚未启用或已关闭");
    return this.revision(this.state(chosen).activeId!, chosen);
  }
  assertOpen(channel: PaymentChannel): void {
    if (!this.available().includes(channel)) throw new AppError(409, "payment_channel_disabled", "该通道已关闭新付款；已发起付款仍会核对到账");
  }
  client(r: PaymentRevision): DujiaoClient {
    if (r.channel !== "dujiaopay") throw new AppError(409, "payment_channel_mismatch", "支付通道不匹配");
    return new DujiaoClient({keyId: r.details.keyId!, secret: this.secrets(r).apiSecret!});
  }
  private safeStorage(): void {
    const url = new URL(this.config.publicBaseUrl);
    if (this.config.storageDriver !== "sqlite" || this.config.sqlitePath === ":memory:" || this.config.dataEncryptionKey.equals(Buffer.alloc(32))
        || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || this.config.enableSandboxRoutes) throw new AppError(409, "payment_storage_unsafe", "请先部署 HTTPS、独立持久化数据库和安全主密钥，并关闭模拟付款入口");
  }
  private version(state: PaymentSettings, version: number): void {
    if (state.version !== version) throw new AppError(409, "payment_config_changed", "配置已变化，请刷新后重试");
  }
  private log(actor: Actor, action: string, id: string): void {
    this.audit.record({merchantId: null, actorId: actor.id, actorType: "platform_user", action, targetType: "payment_config", targetId: id, requestId: randomUUID()});
  }
}
