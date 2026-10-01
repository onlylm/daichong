import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const read=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");

describe("production health monitoring",()=>{
  it("fails on worker health and keeps detailed probes off public hosts",()=>{
    const script=read("deploy/production/healthcheck.sh"),caddy=read("deploy/production/Caddyfile");
    expect(script).toContain("http://127.0.0.1:3200/health/worker");
    expect(script).toContain("quefa-app-worker-1");
    expect(script).toContain("expect_status 404 https://tibo.ink/health/worker");
    expect(caddy).toMatch(/@blocked path[^\n]*\/health\*/);
    expect(caddy).toMatch(/@private path[^\n]*\/health\*/);
  });

  it("routes failed health, backup and restore checks to a sanitized OnFailure notifier",()=>{
    const units=["quefa-healthcheck.service","quefa-backup.service","quefa-restore-test.service"]
      .map(name=>read(`deploy/production/systemd/${name}`));
    const alert=read("deploy/production/health-alert.sh");
    for(const unit of units)expect(unit).toContain("OnFailure=quefa-health-alert@%n.service");
    expect(alert).toContain("HEALTH_ALERT_WEBHOOK_URL");
    expect(alert).toContain("must be root-owned mode 0600 or stricter");
    expect(alert).toContain("quefa_unit_failed");
    expect(alert).not.toContain("/health/worker");
  });
});
