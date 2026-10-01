import { randomBytes, randomUUID } from "node:crypto";
import type { ApiKey, Merchant, PartnerApp } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError } from "../domain/errors.js";

export class MerchantService {
  constructor(private readonly repository: Repository) {}

  createMerchant(input: {partnerId: string; name: string}): Merchant {
    if (this.repository.findMerchantByPartner(input.partnerId)) throw new AppError(409, "partner_id_exists", "partner_id 已存在");
    const merchant: Merchant = {id: randomUUID(), partnerId: input.partnerId, name: input.name, status: "active"};
    this.repository.saveMerchant(merchant);
    return merchant;
  }

  createApp(merchantId: string, input: {appId: string; name: string; allowedIps?: string[]; ipAllowlistEnabled?: boolean}): PartnerApp {
    const app: PartnerApp = {
      id: randomUUID(), merchantId, appId: input.appId, name: input.name,
      status: "active", allowedIps: input.allowedIps ?? [], ipAllowlistEnabled: input.ipAllowlistEnabled ?? false, configVersion: 1,
    };
    this.repository.saveApp(app);
    return app;
  }

  issueKey(merchantId: string, appId: string, keyId: string, secret?: string): {record: ApiKey; clientSecret: string} {
    const clientSecret = secret ?? randomBytes(32).toString("base64url");
    const record: ApiKey = {
      id: randomUUID(), merchantId, appId, keyId, secret: clientSecret,
      status: "active", notBefore: new Date(), expiresAt: null,
    };
    this.repository.saveKey(record);
    return {record, clientSecret};
  }

  rotateKey(current: ApiKey, newKeyId: string): {oldKey: ApiKey; newKey: ApiKey; clientSecret: string} {
    const oldKey: ApiKey = {...current, status: "expiring", expiresAt: new Date(Date.now() + 24 * 60 * 60_000)};
    this.repository.saveKey(oldKey);
    const issued = this.issueKey(current.merchantId, current.appId, newKeyId);
    return {oldKey, newKey: issued.record, clientSecret: issued.clientSecret};
  }

  revokeKey(key: ApiKey): ApiKey {
    const revoked: ApiKey = {...key, status: "revoked", expiresAt: new Date()};
    this.repository.saveKey(revoked);
    return revoked;
  }
}
