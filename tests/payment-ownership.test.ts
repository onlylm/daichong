import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

describe("payment ownership boundary", () => {
  it("keeps payment credentials platform-scoped and outside tenant RLS", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const initial = readFileSync(join(here, "../migrations/0001_initial.sql"), "utf8");
    const rls = readFileSync(join(here, "../migrations/0002_rls_and_immutability.sql"), "utf8");
    const configTable = initial.match(/CREATE TABLE platform_payment_configs \([\s\S]*?\n\);/)?.[0];

    expect(configTable).toBeDefined();
    expect(configTable).not.toMatch(/merchant_id/i);
    expect(initial).toMatch(/payment_config_id uuid NOT NULL REFERENCES platform_payment_configs\(id\)/);
    expect(rls).not.toMatch(/platform_payment_configs/);
  });
});
