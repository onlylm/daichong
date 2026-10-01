import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedPayload } from "../domain/model.js";

export class SensitivePayloadCipher {
  constructor(private readonly key: Buffer, private readonly keyVersion: string) {
    if (key.length !== 32) throw new Error("AES-256-GCM 密钥必须是 32 字节");
  }

  encrypt(value: unknown, aad: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: this.keyVersion,
      clearedAt: null,
    };
  }

  decrypt(payload: EncryptedPayload, aad: string): unknown {
    if (!payload.ciphertext || !payload.iv || !payload.authTag) throw new Error("敏感数据已清理");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(payload.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  clear(payload: EncryptedPayload, now = new Date()): EncryptedPayload {
    return {...payload, ciphertext: null, iv: null, authTag: null, clearedAt: now};
  }
}

