import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/infra/memory-repository.js";
import { MerchantService } from "../src/modules/merchant-service.js";
import { AccessControlService } from "../src/modules/access-control-service.js";

describe("merchant RBAC isolation", () => {
  it("never resolves another merchant's role or user binding", () => {
    const repository = new MemoryRepository();
    const merchants = new MerchantService(repository);
    const access = new AccessControlService(repository);
    const a = merchants.createMerchant({partnerId: "pt_rbac_a", name: "A"});
    const b = merchants.createMerchant({partnerId: "pt_rbac_b", name: "B"});
    const roleA = access.createRole(a.id, {code: "finance", name: "财务", permissions: ["ledger.read"]});
    access.assignUser(a.id, "user-1", roleA.id);

    expect(() => access.requirePermission(a.id, "user-1", "ledger.read")).not.toThrow();
    expect(() => access.requirePermission(b.id, "user-1", "ledger.read")).toThrowError(/无权/);
    expect(() => access.assignUser(b.id, "user-2", roleA.id)).toThrowError(/角色不存在/);
  });
});

