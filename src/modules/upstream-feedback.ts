import type {Fulfillment, RechargeDiagnostic, RechargeErrorCategory} from "../domain/model.js";
import {safeBusinessMessage} from "../domain/safe-business-message.js";
import {UpstreamRequestError} from "../upstream/recharge-provider.js";

const diagnosisCodes: Record<string, RechargeDiagnostic["code"]> = {
  session_invalid: "credential_invalid", mailbox_login_failed: "mailbox_login_failed",
  account_has_subscription: "account_has_subscription", precheck_rejected: "precheck_rejected",
  subscription_required: "subscription_required", account_unavailable: "account_unavailable",
  order_rejected: "order_rejected", product_unavailable: "product_unavailable", upstream_product_unavailable: "product_unavailable",
  upstream_balance_insufficient: "balance_insufficient", out_of_stock: "cdk_unavailable", upstream_configuration_error: "configuration_error",
  production_supplier_required: "configuration_error", production_execution_disabled: "configuration_error",
  upstream_unavailable: "service_unavailable", upstream_invalid_response: "invalid_response",
  upstream_quote_unavailable: "quote_unavailable", upstream_cdk_invalid: "cdk_unavailable",
  upstream_preflight_failed: "invalid_response", upstream_cdk_issue_failed: "invalid_response",
  upstream_cdk_id_missing: "invalid_response", upstream_cdk_code_missing: "invalid_response",
  upstream_reference_missing: "result_unknown", upstream_result_unknown: "result_unknown",
  payment_declined: "payment_declined", precharge_failed: "precharge_failed",
};

export function safeRechargeDiagnostic(error: unknown, phase: RechargeDiagnostic["phase"]): RechargeDiagnostic {
  return {code: error instanceof UpstreamRequestError ? diagnosisCodes[error.failureCode] ?? "unexpected_error" : "unexpected_error",
    phase, observedAt: new Date().toISOString()};
}

export function diagnosticCategory(code: RechargeDiagnostic["code"]): RechargeErrorCategory {
  if (["credential_invalid", "mailbox_login_failed"].includes(code)) return "credential";
  if (["account_has_subscription", "precheck_rejected", "subscription_required", "account_unavailable", "order_rejected", "precharge_failed"].includes(code)) return "account";
  if (code === "product_unavailable") return "product";
  if (["balance_insufficient", "cdk_unavailable", "payment_declined"].includes(code)) return "resource";
  if (["configuration_error", "service_unavailable", "invalid_response", "quote_unavailable"].includes(code)) return "service";
  if (code === "result_unknown") return "confirmation";
  return "unknown";
}

export function fulfillmentErrorCategory(value: Fulfillment): RechargeErrorCategory | null {
  if (["succeeded", "cancelled"].includes(value.status)) return null;
  if (value.errorCategory !== undefined) return value.errorCategory;
  if (value.failureCode) {
    const known = diagnosisCodes[value.failureCode];
    return known ? diagnosticCategory(known) : value.failureCode === "service_unavailable" ? "service" : "unknown";
  }
  if (value.status === "running" && ["review", "pending", "requires_action"].includes(value.upstreamStatus ?? "")) return "confirmation";
  return null;
}

export function publicFailureCode(error: UpstreamRequestError): string {
  if (["session_invalid", "mailbox_login_failed", "account_has_subscription", "precheck_rejected", "subscription_required", "account_unavailable",
    "product_unavailable", "order_rejected", "payment_blocked", "verification_timeout"].includes(error.failureCode)) return error.failureCode;
  if (error.failureCode === "upstream_product_unavailable") return "product_unavailable";
  return error.retryable ? "service_unavailable" : "other";
}

export function publicFailureMessage(code: string, detail: string | null = null): string {
  const fallback = code === "session_invalid" ? "账号凭据无效，请重新提交"
    : code === "mailbox_login_failed" ? "邮箱登录失败，请检查邮箱和密码，或改用 Session / Access Token 后重新提交"
    : code === "account_has_subscription" ? "账号已有有效订阅"
    : code === "precheck_rejected" ? "账号预检未通过"
    : code === "subscription_required" ? "当前账号不支持订购此套餐：需已有有效订阅"
    : code === "account_unavailable" ? "当前账号不可用于本次充值"
    : code === "product_unavailable" ? "当前套餐暂不支持订购"
    : code === "order_rejected" ? "充值请求未通过业务校验"
    : code === "payment_blocked" ? "充值未成功，请联系平台客服"
    : code === "verification_timeout" ? "账号验证超时，请稍后重试"
    : code === "service_unavailable" ? "充值服务暂时繁忙，系统将自动重试"
    : "充值未成功，请联系平台客服";
  return code === "mailbox_login_failed" ? fallback : safeBusinessMessage(detail, fallback);
}

export function queuedFailureMessage(diagnostic: RechargeDiagnostic): string {
  switch (diagnosticCategory(diagnostic.code)) {
    case "resource": return "充值资源暂不可用，平台正在处理，请勿重复提交";
    case "product": return "当前套餐暂不可用，请等待平台处理";
    case "unknown": case "confirmation": return "充值请求结果待核对，请勿重复提交";
    default: return "充值服务暂时繁忙，系统将自动重试";
  }
}
