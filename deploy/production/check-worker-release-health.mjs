import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export const requiredWorkerLanes = [
  "retail-payment",
  "wallet-payment",
  "invoice-payment",
  "cdk-issuance",
  "cdk-refund-cleanup",
  "fulfillment",
  "refund-recovery",
  "webhook",
  "notifications",
  "cost-readback",
  "supplier-quotes",
  "daily-settlement",
];

export function checkWorkerReleaseHealth(snapshot, notBeforeMs, nowMs = Date.now()) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("worker_snapshot_missing");
  if (snapshot.state !== "running") throw new Error("worker_not_running");
  if (typeof snapshot.instanceId !== "string" || snapshot.instanceId.length < 8) throw new Error("worker_instance_missing");
  const startedAt = Date.parse(snapshot.startedAt), heartbeatAt = Date.parse(snapshot.heartbeatAt);
  if (!Number.isFinite(startedAt) || startedAt < notBeforeMs) throw new Error("worker_instance_is_not_from_this_release");
  if (!Number.isFinite(heartbeatAt) || heartbeatAt < startedAt || heartbeatAt > nowMs + 30_000
      || nowMs - heartbeatAt > 15_000) throw new Error("worker_heartbeat_stale");
  if (!Array.isArray(snapshot.lanes)) throw new Error("worker_lanes_missing");
  const lanes = new Map(snapshot.lanes.map((lane) => [lane?.name, lane]));
  for (const name of requiredWorkerLanes) {
    const lane = lanes.get(name);
    if (!lane) throw new Error(`worker_lane_missing:${name}`);
    if (!Number.isInteger(lane.totalRuns) || lane.totalRuns < 1 || !Number.isFinite(Date.parse(lane.lastCompletedAt))) {
      throw new Error(`worker_lane_not_exercised:${name}`);
    }
    if (lane.consecutiveFailures !== 0) throw new Error(`worker_lane_failed:${name}`);
  }
  return {instanceId: snapshot.instanceId, startedAt, heartbeatAt};
}

async function main() {
  const notBeforeMs = Number(process.argv[2]);
  if (!Number.isFinite(notBeforeMs) || notBeforeMs <= 0) throw new Error("release_start_required");
  const snapshot = JSON.parse(readFileSync(0, "utf8"));
  checkWorkerReleaseHealth(snapshot, notBeforeMs);
  process.stdout.write("worker_release_health=ok\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`worker_release_health=failed reason=${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  });
}
