import {createHash} from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Repository } from "../infra/repository.js";
import type { TenantContext } from "../domain/model.js";
import { AppError } from "../domain/errors.js";
import { ipAllowed } from "./ip.js";
import { signRequest, signaturesEqual } from "./signature.js";

export interface NonceStore {
  consume(scope: string, nonce: string, ttlSeconds: number): Promise<boolean>;
}

export class RepositoryNonceStore implements NonceStore {
  constructor(private readonly repository: Repository) {}
  async consume(scope: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now(), key = createHash("sha256").update(JSON.stringify([scope, nonce])).digest("hex");
    return this.repository.consumeNonce(key, now + ttlSeconds * 1000, now);
  }
}

export class MemoryNonceStore implements NonceStore {
  private readonly values = new Map<string, number>();

  async consume(scope: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    for (const [key, expiresAt] of this.values) if (expiresAt <= now) this.values.delete(key);
    const key = `${scope}:${nonce}`;
    if (this.values.has(key)) return false;
    this.values.set(key, now + ttlSeconds * 1000);
    return true;
  }
}

interface RedisSetClient {
  set(key: string, value: string, options: { NX: true; EX: number }): Promise<string | null>;
}

export class RedisNonceStore implements NonceStore {
  constructor(private readonly client: RedisSetClient) {}

  async consume(scope: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(`quefa:nonce:${scope}:${nonce}`, "1", { NX: true, EX: ttlSeconds });
    return result === "OK";
  }
}

export class ApiAuthenticator {
  constructor(
    private readonly repository: Repository,
    private readonly nonceStore: NonceStore,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: {readPerMinute: number; writePerMinute: number} = {readPerMinute: 600, writePerMinute: 120},
  ) {}

  async authenticate(request: FastifyRequest): Promise<TenantContext> {
    const partnerId = requiredHeader(request, "x-partner-id");
    const keyId = requiredHeader(request, "x-key-id");
    const timestamp = requiredHeader(request, "x-timestamp");
    const nonce = requiredHeader(request, "x-nonce");
    const suppliedSignature = requiredHeader(request, "x-signature");
    const idempotencyKey = optionalHeader(request, "idempotency-key");

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !idempotencyKey) {
      throw new AppError(400, "idempotency_key_required", "变更类请求必须携带 Idempotency-Key");
    }
    if (!/^[0-9]{10}$/.test(timestamp)) {
      throw new AppError(401, "timestamp_out_of_range", "签名时间戳无效");
    }
    const requestTime = Number(timestamp) * 1000;
    if (Math.abs(this.now().getTime() - requestTime) > 300_000) {
      throw new AppError(401, "timestamp_out_of_range", "签名时间戳超出允许范围");
    }
    if (nonce.length < 16 || nonce.length > 128) {
      throw new AppError(401, "invalid_nonce", "Nonce 长度无效");
    }

    const credential = this.repository.findCredential(partnerId, keyId);
    if (!credential || credential.merchant.status !== "active" || credential.app.status !== "active") {
      throw new AppError(401, "invalid_signature", "签名无效");
    }
    if (credential.key.status === "revoked" || credential.key.notBefore > this.now() || (credential.key.expiresAt && credential.key.expiresAt <= this.now())) {
      throw new AppError(401, "invalid_signature", "签名无效");
    }
    // Rollout is compatibility-open: historical applications may already carry
    // staged IP rules but do not have the explicit enforcement flag yet. Only an
    // administrator/agent opt-in may turn those rules into an access boundary.
    const ipAllowlistEnabled = credential.app.ipAllowlistEnabled === true;
    if (ipAllowlistEnabled && !ipAllowed(request.ip, credential.app.allowedIps)) {
      throw new AppError(403, "ip_not_allowed", "来源 IP 不在白名单");
    }

    const rawUrl = request.raw.url ?? request.url;
    const queryStart = rawUrl.indexOf("?");
    const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const rawQuery = queryStart === -1 ? "" : rawUrl.slice(queryStart + 1);
    const expected = signRequest({
      method: request.method,
      path,
      rawQuery,
      timestamp,
      nonce,
      keyId,
      idempotencyKey,
      rawBody: request.rawBody ?? Buffer.alloc(0),
    }, credential.key.secret);
    if (!signaturesEqual(expected, suppliedSignature)) {
      throw new AppError(401, "invalid_signature", "签名无效");
    }

    if (!this.apiAccessGranted(credential.merchant.id)) {
      throw new AppError(403, "api_access_required", "API 接入已被停用，请联系平台管理员");
    }

    const now = this.now().getTime(), read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
    const limit = read ? this.limits.readPerMinute : this.limits.writePerMinute;
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const bucket = createHash("sha256").update(JSON.stringify([partnerId, keyId, read ? "read" : "write"])).digest("hex");
    const usage = this.repository.consumeRateLimit(bucket, windowStart, limit);
    request.apiRateLimit = {limit, remaining: Math.max(0, limit - usage.count), resetAt: windowStart + 60_000};
    if (!usage.allowed) throw new AppError(429, "rate_limited", "请求过于频繁，请在限流窗口重置后重试", true);

    const consumed = await this.nonceStore.consume(`${partnerId}:${keyId}`, nonce, 600);
    if (!consumed) throw new AppError(409, "nonce_replayed", "Nonce 已使用");

    return {
      merchantId: credential.merchant.id,
      partnerId,
      appId: credential.app.id,
      keyId,
    };
  }

  private apiAccessGranted(merchantId: string): boolean {
    const access = this.repository.getOperations("api_access", merchantId);
    if (!access?.enabled) return false;
    if (access.depositId.startsWith("manual:") || access.depositId.startsWith("tier:") || access.depositId.startsWith("default:")) return true;
    const deposit = this.repository.getOperations("wallet_deposit", access.depositId);
    return deposit?.status === "credited" && !!deposit.verifiedReference;
  }
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = optionalHeader(request, name);
  if (!value) throw new AppError(401, "missing_auth_header", `缺少 ${name} 请求头`);
  return value;
}

function optionalHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
