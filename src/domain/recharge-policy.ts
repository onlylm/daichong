import type {Fulfillment} from "./model.js";

/** Never infer permission to retry from a local timeout or a terminal label alone. */
export function canResubmitFulfillment(task: Fulfillment): boolean {
  return task.recoveryAction !== "refund" && isConfirmedUnsuccessfulFulfillment(task);
}

/** A refund choice disables retry, but does not undo evidence that an attempt ended safely. */
export function isConfirmedUnsuccessfulFulfillment(task: Fulfillment): boolean {
  return ["failed", "cancelled"].includes(task.status) && (
    task.retryAllowed === true || ["declined", "failed_precharge"].includes(task.upstreamStatus ?? "")
  );
}
