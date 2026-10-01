import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import YAML from "yaml";

describe("sandbox delivery package", () => {
  it("shares one persistent volume between API and Worker", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const compose = YAML.parse(readFileSync(join(here, "../compose.yaml"), "utf8"));
    expect(compose.services.api.environment.STORAGE_DRIVER).toBe("sqlite");
    expect(compose.services.worker.environment.STORAGE_DRIVER).toBe("sqlite");
    expect(compose.services.api.volumes).toContain("quefa_sandbox:/app/data");
    expect(compose.services.worker.volumes).toContain("quefa_sandbox:/app/data");
    expect(compose.services.worker.depends_on.api.condition).toBe("service_healthy");
    expect(compose.volumes.quefa_sandbox).toBeDefined();
    const demo = readFileSync(join(here, "../examples/partner-demo/server.mjs"), "utf8");
    expect(demo).toContain("/webhooks/quefa");
    expect(demo).toContain("/payment-code");
    expect(demo).toContain('mode: "auto_recharge"');
    expect(demo).toContain("qr_image_data_url");
    expect(demo).not.toContain("current.qr_payload");
    expect(demo).not.toContain("current.fulfillment_url");
    expect(demo).not.toContain("打开 Quefa");
  });

  it("keeps the partner storefront on the agent domain and free of internal commercial fields", async () => {
    const module = await import(new URL("../examples/partner-demo/server.mjs", import.meta.url).href);
    const page = module.storefrontHtml() as string;
    expect(page).not.toMatch(/Quefa|tibo\.ink|qr_payload|fulfillment_url|supply_amount|merchant_margin|client_secret/i);
    expect(page).toContain("qr_image_data_url");
    expect(page).toContain("auto_recharge");
    const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (!script) throw new Error("partner demo script missing");
    expect(() => new Function(script)).not.toThrow();
  });
});
