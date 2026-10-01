import {randomUUID} from "node:crypto";
import type {Repository} from "../infra/repository.js";
import type {WorkerHealth, WorkerLaneHealth} from "../operations/model.js";

export const WORKER_HEALTH_ID = "primary";
export const WORKER_HEARTBEAT_STALE_MS = 15_000;
export const WORKER_LANE_STUCK_MS = 120_000;

export type WorkerHealthStatus = "healthy" | "degraded" | "missing" | "stale" | "stopped";

export interface WorkerHealthView {
  status: WorkerHealthStatus;
  heartbeatAt: Date | null;
  heartbeatAgeMs: number | null;
  startedAt: Date | null;
  instanceId: string | null;
  failedLanes: string[];
  stuckLanes: string[];
  lanes: WorkerLaneHealth[];
}

function emptyLane(name: string): WorkerLaneHealth {
  return {name, inFlight: false, totalRuns: 0, consecutiveFailures: 0,
    lastStartedAt: null, lastCompletedAt: null, lastSucceededAt: null, lastFailedAt: null, lastErrorCode: null};
}

/**
 * Keeps detailed lane state in memory and writes one compact snapshot at the
 * heartbeat interval. Error messages are deliberately discarded because SDK
 * exceptions may contain credentials or signed upstream requests.
 */
export class WorkerHealthReporter {
  private readonly instanceId = randomUUID();
  private readonly startedAt: Date;
  private readonly lanes = new Map<string, WorkerLaneHealth>();

  constructor(private readonly repository: Repository, laneNames: readonly string[], private readonly now: () => Date = () => new Date()) {
    this.startedAt = this.now();
    for (const name of laneNames) this.lanes.set(name, emptyLane(name));
  }

  start(name: string): void {
    const current = this.lane(name), at = this.now();
    this.lanes.set(name, {...current, inFlight: true, totalRuns: current.totalRuns + 1, lastStartedAt: at});
  }

  succeed(name: string): void {
    const current = this.lane(name), at = this.now();
    this.lanes.set(name, {...current, inFlight: false, consecutiveFailures: 0,
      lastCompletedAt: at, lastSucceededAt: at, lastErrorCode: null});
  }

  fail(name: string): void {
    const current = this.lane(name), at = this.now();
    this.lanes.set(name, {...current, inFlight: false, consecutiveFailures: current.consecutiveFailures + 1,
      lastCompletedAt: at, lastFailedAt: at, lastErrorCode: "task_failed"});
  }

  persist(state: WorkerHealth["state"] = "running"): WorkerHealth {
    const value: WorkerHealth = {id: WORKER_HEALTH_ID, merchantId: null, instanceId: this.instanceId,
      state, startedAt: this.startedAt, heartbeatAt: this.now(), lanes: [...this.lanes.values()].map(item => ({...item}))};
    this.repository.saveOperations("worker_health", value);
    return value;
  }

  private lane(name: string): WorkerLaneHealth {
    const value = this.lanes.get(name);
    if (!value) throw new Error("unknown_worker_lane");
    return value;
  }
}

export function readWorkerHealth(repository: Repository, now = new Date(), staleAfterMs = WORKER_HEARTBEAT_STALE_MS,
  stuckAfterMs = WORKER_LANE_STUCK_MS): WorkerHealthView {
  const value = repository.getOperations("worker_health", WORKER_HEALTH_ID);
  if (!value) return {status: "missing", heartbeatAt: null, heartbeatAgeMs: null, startedAt: null,
    instanceId: null, failedLanes: [], stuckLanes: [], lanes: []};
  const heartbeatAgeMs = Math.max(0, now.getTime() - value.heartbeatAt.getTime());
  const failedLanes = value.lanes.filter(item => item.consecutiveFailures > 0).map(item => item.name);
  const stuckLanes = value.lanes.filter(item => item.inFlight && item.lastStartedAt
    && now.getTime() - item.lastStartedAt.getTime() > stuckAfterMs).map(item => item.name);
  const status: WorkerHealthStatus = value.state === "stopping" ? "stopped"
    : heartbeatAgeMs > staleAfterMs ? "stale"
      : failedLanes.length || stuckLanes.length ? "degraded" : "healthy";
  return {status, heartbeatAt: value.heartbeatAt, heartbeatAgeMs, startedAt: value.startedAt,
    instanceId: value.instanceId, failedLanes, stuckLanes, lanes: value.lanes};
}

/** Public health responses expose no lane names or process identity. */
export function publicWorkerHealth(view: WorkerHealthView): {status: WorkerHealthStatus; heartbeat_age_ms: number | null; failures: number; stuck: number} {
  return {status: view.status, heartbeat_age_ms: view.heartbeatAgeMs, failures: view.failedLanes.length, stuck: view.stuckLanes.length};
}
