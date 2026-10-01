import { loadConfig } from "./config.js";
import { createRuntime } from "./bootstrap.js";
import {OutboxWorker} from "./worker/outbox-worker.js";
import {RepositoryWebhookDeliveryStore} from "./worker/repository-webhook-store.js";
import {WorkerHealthReporter} from "./worker/worker-health.js";

const config = loadConfig();
const runtime = createRuntime(config);
const outboxWorker = new OutboxWorker(new RepositoryWebhookDeliveryStore(runtime.repository));

// Each lane can wait on its own upstream without blocking unrelated work.
const inFlight = new Set<string>();
let stopping = false;
const lanes: Array<[string, () => unknown | Promise<unknown>]> = [
  ["retail-payment", () => runtime.alipay?.reconcileOne()],
  ["wallet-payment", () => runtime.walletAlipay?.reconcileOne()],
  ["invoice-payment", () => runtime.invoiceAlipay?.reconcileOne()],
  ["usdt-payment", () => runtime.dujiaopay?.reconcileOne()],
  ["cdk-issuance", () => runtime.cdk.issueOne()],
  ["cdk-refund-cleanup", () => runtime.cdk.reconcileRefundedOne()],
  ["fulfillment", () => runtime.fulfillments.processOne()],
  ["refund-recovery", () => runtime.refunds.reconcileOne()],
  ["webhook", () => outboxWorker.tick()],
  ["notifications", () => runtime.notifications.tick()],
  ["cost-readback", () => runtime.costs.syncOne()],
  ["supplier-quotes", () => runtime.supplierManagement.syncQuotesOne()],
  ["daily-settlement", () => runtime.dailySettlements.tick()],
];
const health = new WorkerHealthReporter(runtime.repository, lanes.map(([name]) => name));
function persistHealth(state: "running" | "stopping" = "running") {
  try { health.persist(state); }
  catch { console.error("后台任务心跳暂未写入，将重试"); }
}
persistHealth();
async function runLane(name: string, tick: () => unknown | Promise<unknown>) {
  if (stopping || inFlight.has(name)) return;
  inFlight.add(name);
  health.start(name);
  try {
    await tick();
    health.succeed(name);
  } catch {
    health.fail(name);
    // SDK exceptions can contain credentials; only log the internal lane name.
    console.error("后台任务暂未完成，将重试：" + name);
  } finally {
    inFlight.delete(name);
    if (stopping && !inFlight.size) { runtime.close(); process.exit(0); }
  }
}
const timer = setInterval(() => { for (const [name, tick] of lanes) void runLane(name, tick); }, 1000);
const healthTimer = setInterval(() => persistHealth(), 5000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(healthTimer);
    stopping = true;
    persistHealth("stopping");
    if (!inFlight.size) { runtime.close(); process.exit(0); }
  });
}
