import { randomUUID } from "node:crypto";
import type { MerchantRole, MerchantUser } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError } from "../domain/errors.js";

export const merchantPermissions = [
  "catalog.read", "orders.read", "fulfillments.write", "refunds.request", "refunds.review",
  "ledger.read", "settlements.read", "invoices.write", "apps.manage", "users.manage", "audit.read",
] as const;

export class AccessControlService {
  constructor(private readonly repository: Repository) {}

  createRole(merchantId: string, input: {code: string; name: string; permissions: string[]}): MerchantRole {
    const allowed = new Set<string>(merchantPermissions);
    if (input.permissions.some((permission) => !allowed.has(permission))) {
      throw new AppError(422, "unknown_permission", "角色包含未知权限");
    }
    const role: MerchantRole = {id: randomUUID(), merchantId, ...input};
    this.repository.saveMerchantRole(role);
    return role;
  }

  assignUser(merchantId: string, userId: string, roleId: string): MerchantUser {
    if (!this.repository.findMerchantRole(merchantId, roleId)) throw new AppError(404, "role_not_found", "角色不存在");
    const binding: MerchantUser = {id: randomUUID(), merchantId, userId, roleId, status: "active"};
    this.repository.saveMerchantUser(binding);
    return binding;
  }

  requirePermission(merchantId: string, userId: string, permission: string): void {
    const binding = this.repository.findMerchantUser(merchantId, userId);
    if (!binding || binding.status !== "active") throw new AppError(403, "permission_denied", "无权执行该操作");
    const role = this.repository.findMerchantRole(merchantId, binding.roleId);
    if (!role?.permissions.includes(permission)) throw new AppError(403, "permission_denied", "无权执行该操作");
  }
}
