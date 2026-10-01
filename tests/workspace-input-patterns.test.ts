import {describe, expect, it} from "vitest";
import {workspaceJs} from "../src/operations/workspace-page.js";

describe("workspace native HTML input validation", () => {
  it("compiles every literal input pattern using the browser Unicode-sets flag", () => {
    const patterns = [...workspaceJs.matchAll(/pattern:"((?:\\.|[^"\\])*)"/g)]
      .map(match => JSON.parse('"' + match[1] + '"') as string);
    expect(patterns.length).toBeGreaterThanOrEqual(6);
    for (const pattern of patterns) expect(() => new RegExp("^(?:" + pattern + ")$", "v"), pattern).not.toThrow();
  });

  it("accepts valid manual completion references and rejects invalid characters or length", () => {
    const match = workspaceJs.match(/input\("externalOrderRef"[^\n]*pattern:"([^"]+)"/);
    expect(match).not.toBeNull();
    const pattern = new RegExp("^(?:" + JSON.parse('"' + match![1] + '"') + ")$", "v");
    for (const value of ["MANUAL-20261002-01", "upstream:order_123.abc", "A".repeat(120)]) expect(pattern.test(value)).toBe(true);
    for (const value of ["12345", "A".repeat(121), "订单-123456", "REF 123456", "REF/123456"]) expect(pattern.test(value)).toBe(false);
  });
});
