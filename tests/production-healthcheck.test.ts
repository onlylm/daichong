import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {describe,expect,it} from "vitest";

const read=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const releaseCheck=fileURLToPath(new URL("../deploy/production/check-worker-release-health.mjs",import.meta.url));
const requiredLanes=["retail-payment","wallet-payment","invoice-payment","cdk-issuance","cdk-refund-cleanup","fulfillment",
  "refund-recovery","webhook","notifications","cost-readback","supplier-quotes","daily-settlement"];
function workerSnapshot(startedAt="2026-10-01T10:00:01.000Z"){
  return {id:"primary",instanceId:"new-worker-instance",state:"running",startedAt,heartbeatAt:"2026-10-01T10:00:10.000Z",
    lanes:requiredLanes.map(name=>({name,inFlight:false,totalRuns:1,consecutiveFailures:0,lastCompletedAt:"2026-10-01T10:00:09.000Z"}))};
}
function checkRelease(snapshot:unknown,start=Date.parse("2026-10-01T10:00:00.000Z"),now=Date.parse("2026-10-01T10:00:11.000Z")){
  return spawnSync(process.execPath,[releaseCheck,String(start)],{input:JSON.stringify(snapshot),encoding:"utf8",env:{...process.env,NODE_OPTIONS:`--require=${fileURLToPath(new URL("./fixtures/fixed-date.cjs",import.meta.url))}`,
    FIXED_DATE_NOW:String(now)}});
}

describe("production health monitoring",()=>{
  it("fails on worker health and keeps detailed probes off public hosts",()=>{
    const script=read("deploy/production/healthcheck.sh"),caddy=read("deploy/production/Caddyfile"),deploy=read("deploy/production/deploy-production-candidate.sh");
    expect(script).toContain("http://127.0.0.1:3200/health/worker");
    expect(script).toContain("quefa-app-worker-1");
    expect(script).toContain("expect_status 404 https://tibo.ink/health/worker");
    expect(caddy).toMatch(/@blocked path[^\n]*\/health\*/);
    expect(caddy).toMatch(/@private path[^\n]*\/health\*/);
    expect(caddy.match(/header_up X-Forwarded-For \{remote_host\}/g)).toHaveLength(3);
    expect(deploy).toContain("replace_env TRUSTED_PROXY_CIDRS 127.0.0.0/8,::1/128,172.16.0.0/12");
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

  it("requires this release's worker and every critical lane before accepting a deployment",()=>{
    const deploy=read("deploy/production/deploy-production-candidate.sh"),worker=read("src/worker.ts"),checker=read("deploy/production/check-worker-release-health.mjs");
    expect(deploy).toContain('release_started_at_ms="$(($(date -u +%s) * 1000))"');
    expect(deploy).toContain('kind=\'ops_worker_health\'');
    expect(deploy).toContain('check-worker-release-health.mjs "$release_started_at_ms"');
    expect(deploy).toContain('curl -fsS http://127.0.0.1:3200/health/worker');
    expect(deploy).toContain('Production Worker did not publish a fresh healthy heartbeat');
    for(const lane of requiredLanes){expect(worker).toContain(`["${lane}"`);expect(checker).toContain(`"${lane}"`);}
  });

  it("rejects an old heartbeat, a missing lane and a failed lane even when the API can be healthy",()=>{
    expect(checkRelease(workerSnapshot()).status).toBe(0);
    const old=checkRelease(workerSnapshot("2026-10-01T09:59:00.000Z"));
    expect(old.status).toBe(1);expect(old.stderr).toContain("worker_instance_is_not_from_this_release");
    const missing=workerSnapshot();missing.lanes=missing.lanes.filter(item=>item.name!=="fulfillment");
    expect(checkRelease(missing).status).toBe(1);
    const failed=workerSnapshot(),lane=failed.lanes.find(item=>item.name==="retail-payment")!;lane.consecutiveFailures=1;
    expect(checkRelease(failed).status).toBe(1);
  });
});
