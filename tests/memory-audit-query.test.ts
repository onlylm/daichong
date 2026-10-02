import {describe, expect, it, vi} from "vitest";
import {MemoryRepository} from "../src/infra/memory-repository.js";
import {queryRecords} from "../src/infra/record-query.js";
import {workspaceAudit} from "../src/operations/workspace-tools.js";

function repository() {
  const repo = new MemoryRepository();
  for (let index = 0; index < 13; index++) repo.appendAudit({id: "memory_audit_" + index,
    merchantId: index % 2 ? "historical-merchant" : null, actorId: "platform-admin", actorType: "platform_user",
    action: "audit.memory.test", targetType: "platform", targetId: "settings", requestId: "request-" + index,
    createdAt: new Date(Date.parse("2026-10-01T16:00:00.000Z") + index * 1_000)});
  return repo;
}

describe("memory global audit query compatibility", () => {
  it("includes platform-only and historical-tenant audit even when there are no merchant directory entries", () => {
    const repo = repository(), merchants = vi.spyOn(repo, "listMerchants");
    const result = workspaceAudit(repo, {id: "admin", role: "platform_admin", merchantId: null}, {
      from: "2026-10-02", to: "2026-10-02", action: "audit.memory", page: 2, limit: 5});
    expect(result.meta).toEqual({total: 13, page: 2, limit: 5, pages: 3});
    expect(result.data).toHaveLength(5);
    expect(result.data.map(item => item.id)).toEqual(["memory_audit_7", "memory_audit_6", "memory_audit_5", "memory_audit_4", "memory_audit_3"]);
    expect(result.data.some(item => item.merchantId === null)).toBe(true);
    expect(result.data.some(item => item.merchantId === "historical-merchant")).toBe(true);
    expect(merchants).not.toHaveBeenCalled();
  });

  it("keeps tenant-scoped audit isolated without invoking the global fallback", () => {
    const repo = repository(), all = vi.spyOn(repo, "listAllAudit");
    const result = queryRecords(repo, "audit", {merchantId: "historical-merchant", page: 1, limit: 20});
    expect(result.meta.total).toBe(6);
    expect(result.data.every(item => item.merchantId === "historical-merchant")).toBe(true);
    expect(queryRecords(repo, "audit", {merchantId: "another-merchant"}).meta.total).toBe(0);
    expect(all).not.toHaveBeenCalled();
  });

  it("returns copies so reading global audit cannot mutate stored evidence", () => {
    const repo = repository(), records = repo.listAllAudit();
    records[0]!.action = "tampered";
    records[0]!.createdAt.setFullYear(2000);
    records.length = 0;
    const stored = repo.listAllAudit();
    expect(stored).toHaveLength(13);
    expect(stored[0]!.action).toBe("audit.memory.test");
    expect(stored[0]!.createdAt.getUTCFullYear()).toBe(2026);
  });
});
