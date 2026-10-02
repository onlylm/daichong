import type {Fulfillment} from "../domain/model.js";
import {canResubmitFulfillment} from "../domain/recharge-policy.js";
import {defaultOrderVisibility, type OrderVisibilityField} from "../operations/model.js";
import {safeBusinessMessage} from "../domain/safe-business-message.js";
import {fulfillmentErrorCategory} from "./upstream-feedback.js";

/** Strip upstream provider tokens from text shown to agents, API partners, or end users. */
export function safeResultMessage(value: string | null | undefined, fallback: string): string {
  return safeBusinessMessage(value, fallback);
}

export function partnerFulfillmentMessage(value: Fulfillment): string | null {
  if (value.failureCode === "mailbox_login_failed") return "邮箱登录失败，请检查邮箱和密码，或改用 Session / Access Token 后重新提交";
  const fallback = rechargeStageLabel(value.upstreamStage, value.upstreamStatus)
    ?? (value.status === "failed" ? "充值未完成" : value.status === "succeeded" ? "充值成功" : value.status === "cancelled" ? "充值已取消" : "充值处理中");
  return safeResultMessage(value.message, fallback);
}

export const rechargeProgressStepDefs = [
  {id: "submit", label: "提交凭据"},
  {id: "login", label: "正在登录"},
  {id: "funds", label: "准备资金"},
  {id: "dispatch", label: "正在充值"},
  {id: "done", label: "完成"},
] as const;

const stageLabels: Record<string, string> = {
  queued: "排队中",
  logging_in: "正在登录",
  preparing_funds: "正在准备资金",
  funding_pending: "正在准备资金",
  awaiting_card: "正在分配充值资源",
  dispatching: "充值正在派发",
  payment_review: "充值结果确认中",
  plus_paid: "基础套餐已支付，升级处理中",
  requires_action: "需要进一步确认",
  pending: "充值结果确认中",
  review: "充值结果待人工对账",
  completed: "充值完成",
  declined: "充值失败",
  cancelled: "充值已取消",
};

export function rechargeStageLabel(stage: string | null | undefined, resultCode?: string | null): string | null {
  const token = stage?.trim().toLowerCase() || resultCode?.trim().toLowerCase() || "";
  return stageLabels[token] ?? null;
}

export function rechargeProgressView(input: {
  status?: string | null;
  failure_code?: string | null;
  message?: string | null;
  result_code?: string | null;
  result_stage?: string | null;
} | null): {steps: Array<{id: string; label: string; state: "done" | "current" | "pending" | "failed"}>; message: string} {
  const status = input?.status ?? "";
  const stage = input?.result_stage ?? "";
  const code = input?.result_code ?? "";
  const failed = status === "failed" || status === "cancelled" || code === "declined" || code === "failed_precharge";
  const done = status === "succeeded" || code === "completed";
  let index = 0;
  if (done) index = 4;
  else if (failed) index = 4;
  else if (stage === "logging_in") index = 1;
  else if (stage === "preparing_funds" || code === "funding_pending") index = 2;
  else if (["awaiting_card", "dispatching", "payment_review", "plus_paid", "requires_action", "pending", "review"].includes(stage)
      || ["awaiting_card", "dispatching", "plus_paid", "requires_action", "pending", "review"].includes(code)) index = 3;
  else if (status === "running" || code === "running") index = Math.max(index, 1);
  else if (status === "queued") index = 0;
  const steps = rechargeProgressStepDefs.map((step, stepIndex) => ({
    id: step.id,
    label: step.label,
    state: failed && stepIndex === 4 ? "failed" as const
      : stepIndex < index ? "done" as const
        : stepIndex === index && !done ? "current" as const
          : done && stepIndex === 4 ? "done" as const
            : "pending" as const,
  }));
  const message = input?.message
    || rechargeStageLabel(stage, code)
    || (status === "queued" ? "充值任务已进入队列" : status === "running" ? "充值处理中…" : failed ? "充值未完成" : done ? "充值成功" : "等待提交");
  return {steps, message};
}

/** Exposes business result state without leaking provider identity or references. */
export function publicFulfillmentResult(value: Fulfillment) {
  return {
    result_code: publicResultToken(value.upstreamStatus),
    result_stage: publicResultToken(value.upstreamStage),
  };
}

/** Stable, always-public stages. Never return an arbitrary supplier stage as a progress label. */
export function partnerProgressStage(value: Fulfillment): string {
  if (value.status === "succeeded") return "completed";
  if (value.status === "failed") return "failed";
  if (value.status === "cancelled") return "cancelled";
  const stages: Record<string, string> = {
    queued: "queued", logging_in: "logging_in", preparing_funds: "preparing_funds",
    funding_pending: "preparing_funds", awaiting_card: "awaiting_card",
    submission_pending: "dispatching", dispatching: "dispatching", running: "processing",
    processing: "processing", requires_action: "requires_action", pending: "confirming",
    payment_review: "confirming", review: "review", plus_paid: "upgrading",
  };
  return stages[value.upstreamStage ?? ""] ?? stages[value.upstreamStatus ?? ""]
    ?? (value.status === "queued" ? "queued" : "processing");
}

export function partnerFulfillmentProgress(value: Fulfillment) {
  return {
    progress_stage: partnerProgressStage(value),
    progress_version: value.progressVersion ?? 0,
    progress_updated_at: (value.progressUpdatedAt ?? value.finishedAt ?? value.createdAt).toISOString(),
    recovery_action: value.recoveryAction ?? null,
    error_category: fulfillmentErrorCategory(value),
  };
}

/** Query responses and webhooks must agree; this field is not an independent retry authorization. */
export function partnerNextAction(value: Fulfillment, retryAllowed = canResubmitFulfillment(value)): "none" | "resubmit" | "wait" {
  if (value.status === "succeeded" || (value.recoveryAction === "refund" && ["failed", "cancelled"].includes(value.status))) return "none";
  return retryAllowed ? "resubmit" : "wait";
}

export function partnerFulfillmentSnapshot(value: Fulfillment, configured?: OrderVisibilityField[], retryAllowed = canResubmitFulfillment(value)) {
  return {
    status: value.status,
    attempt_no: value.attemptNo,
    ...(value.completionSource === "manual" ? {completion_source: "manual"} : {}),
    ...partnerFulfillmentProgress(value),
    retry_allowed: retryAllowed,
    next_action: partnerNextAction(value, retryAllowed),
    failure_code: value.failureCode,
    message: partnerFulfillmentMessage(value),
    account_email_masked: value.accountEmailMasked,
    ...partnerFulfillmentDetails(value, configured),
  };
}

export function partnerFulfillmentDetails(value: Fulfillment, configured?: OrderVisibilityField[]) {
  const fields = new Set(configured ?? defaultOrderVisibility), result: Record<string, unknown> = {};
  const basic = publicFulfillmentResult(value);
  if (fields.has("result_code")) result.result_code = basic.result_code;
  if (fields.has("result_stage")) result.result_stage = basic.result_stage;
  if (fields.has("card_last_four")) result.card_last_four = publicLastFour(value.upstreamCardLastFour);
  if (fields.has("charge_amount")) {
    result.charge_amount_minor = value.upstreamChargedMinor ?? null;
    result.charge_currency = value.upstreamChargedMinor === null || value.upstreamChargedMinor === undefined ? null : value.upstreamCurrency;
  }
  if (fields.has("upstream_order_id")) result.upstream_order_id = value.completionSource === "manual" ? null : publicReference(value.upstreamOrderId);
  return result;
}

export function platformFulfillmentDetails(value: Fulfillment) {
  return {
    diagnostic: value.diagnostic ?? null,
    ...publicFulfillmentResult(value),
    upstream_order_id: value.upstreamOrderId,
    card_last_four: publicLastFour(value.upstreamCardLastFour),
    quoted_amount_minor: value.upstreamQuoteMinor,
    charge_amount_minor: value.upstreamChargedMinor ?? null,
    charge_currency: value.upstreamCurrency,
  };
}

function publicResultToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null;
}

function publicLastFour(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}$/.test(value)) return null;
  return value;
}

function publicReference(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : null;
}
