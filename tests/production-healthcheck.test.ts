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

  it("publishes the isolated SQLite restore result atomically for the admin overview",()=>{
    const script=read("deploy/production/verify-backup-restore.sh"),compose=read("compose.production.app.yaml"),deploy=read("deploy/production/deploy-production-candidate.sh");
    expect(script).toContain('health="$summary_dir/sqlite-restore-health.json"');
    expect(script).toContain('"failureCode":"restore_verification_failed"');
    expect(script).toContain('chown --reference="$ownership_reference" "$health_tmp"');
    expect(script).toContain('chmod 640 "$health_tmp"');
    expect(script).toContain('fs.writeFileSync(process.argv[3], JSON.stringify(summary)');
    expect(script).not.toContain('cp "$report" "$health_tmp"');
    expect(compose).toContain('/opt/recharge-platform/monitoring:/app/health:ro');
    expect(compose).toContain('BACKUP_HEALTH_REPORT_PATH: /app/health/sqlite-restore-health.json');
    expect(deploy).toContain('replace_env BACKUP_HEALTH_REPORT_PATH /app/health/sqlite-restore-health.json');
  });
});
