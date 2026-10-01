import {describe, expect, it} from "vitest";
import {isAgentRechargeCancelled, orderSyncMark} from "../src/domain/order-sync-mark.js";

describe("orderSyncMark", () => {
  it("marks cancelled + refunded for partner sync", () => {
    expect(orderSyncMark("refunded", {status: "cancelled", failureCode: null})).toBe("cancelled_refunded");
    expect(orderSyncMark("partially_refunded", {status: "failed", failureCode: "agent_cancelled"})).toBe("cancelled_refunded");
  });

  it("does not mark paid cancel or ordinary failure refunds", () => {
    expect(orderSyncMark("paid", {status: "cancelled", failureCode: null})).toBeNull();
    expect(orderSyncMark("refunded", {status: "failed", failureCode: "session_invalid"})).toBeNull();
    expect(orderSyncMark("refunded", {status: "succeeded", failureCode: null})).toBeNull();
    expect(orderSyncMark("refunded", null)).toBeNull();
  });

  it("detects agent recharge cancel outcomes", () => {
    expect(isAgentRechargeCancelled({status: "cancelled", failureCode: null})).toBe(true);
    expect(isAgentRechargeCancelled({status: "failed", failureCode: "agent_cancelled"})).toBe(true);
    expect(isAgentRechargeCancelled({status: "failed", failureCode: "other"})).toBe(false);
  });
});
