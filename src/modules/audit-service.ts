import { randomUUID } from "node:crypto";
import type { Repository } from "../infra/repository.js";

export class AuditService {
  constructor(private readonly repository: Repository) {}

  record(input: {merchantId: string | null; actorId: string; actorType?: "partner_api" | "merchant_user" | "platform_user" | "system"; action: string; targetType: string; targetId: string; requestId: string}): void {
    this.repository.appendAudit({
      id: `aud_${randomUUID().replaceAll("-", "")}`,
      merchantId: input.merchantId,
      actorType: input.actorType ?? "partner_api",
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId: input.requestId,
      createdAt: new Date(),
    });
  }
}
