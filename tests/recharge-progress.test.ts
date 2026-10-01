import {describe, expect, it} from "vitest";
import {rechargeProgressView, rechargeStageLabel} from "../src/modules/fulfillment-public.js";

describe("recharge progress", () => {
  it("maps upstream stages to Chinese labels", () => {
    expect(rechargeStageLabel("logging_in")).toBe("正在登录");
    expect(rechargeStageLabel("preparing_funds")).toBe("正在准备资金");
  });

  it("builds a five-step progress view", () => {
    const running = rechargeProgressView({status: "running", result_stage: "logging_in", message: null, result_code: "running"});
    expect(running.steps.find(s => s.id === "login")?.state).toBe("current");
    expect(running.message).toContain("登录");

    const done = rechargeProgressView({status: "succeeded", result_code: "completed", result_stage: "completed", message: "充值成功"});
    expect(done.steps.every(s => s.state === "done" || s.id === "done")).toBe(true);
  });
});
