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
    expect(readFileSync(join(here, "../examples/partner-demo/server.mjs"), "utf8")).toContain("/webhooks/quefa");
  });
});
