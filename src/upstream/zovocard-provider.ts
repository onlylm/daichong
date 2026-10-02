import type {PreflightResult, RechargeCredential, RechargeProduct, RechargeUpstreamProvider, SubmissionCheckpoint, UpstreamOrderState} from "./recharge-provider.js";
import {UpstreamRequestError} from "./recharge-provider.js";
import {matchOrderTrades, type UpstreamCostFacts} from "./cost-facts.js";
import {safeBusinessMessage} from "../domain/safe-business-message.js";

type JsonObject = Record<string, unknown>;

export class ZovoCardRechargeProvider implements RechargeUpstreamProvider {
  readonly name = "zovocard";

  constructor(
    private readonly apiBase: string,
    private readonly cdkBase: string,
    private readonly apiKey: string,
    private readonly cardId: number | null,
    private readonly cdkFundingCapMinor = 0,
  ) {}

  async submitDirect(input: {product: RechargeProduct; plan: string; credential: RechargeCredential; clientRequestId: string; onSubmitting?: SubmissionCheckpoint}): Promise<UpstreamOrderState> {
    if (input.product !== "gpt") throw new UpstreamRequestError("upstream_product_unavailable", false);
    if (!this.cardId) throw new UpstreamRequestError("upstream_configuration_error", false);
    const plans = await this.api("GET", `/gpt-direct/plans?product=${encodeURIComponent(input.product)}`);
    const planData = asObject(plans.data);
    assertPurchasable(planData, input.product, input.plan);
    const pricingVersion = numberOrNull(planData.version);
    const region = {payment_country: "PH", payment_currency: "PHP"};
    const credential = upstreamCredential(input.credential);
    const preflight = await this.api("POST", "/gpt-direct/preflight", {product: input.product, credential, ...region});
    const preflightData = asObject(preflight.data);
    const preflightToken = stringOrNull(preflightData.preflight_token);
    // Grok validates its sso session but deliberately does not issue a preflight ticket.
    if ((input.product === "gpt" && !preflightToken) || stringOrNull(preflightData.quote_error)) {
      throw new UpstreamRequestError("upstream_quote_unavailable", true);
    }
    input.onSubmitting?.(null);
    const created = await this.api("POST", "/gpt-direct/orders", {
      card_id: this.cardId,
      product: input.product,
      plan: input.plan,
      credential,
      ...(preflightToken ? {preflight_token: preflightToken} : {}),
      client_request_id: input.clientRequestId,
      ...(pricingVersion === null ? {} : {pricing_version: pricingVersion}),
      ...region,
    }, input.clientRequestId);
    return normalizeOrder(asObject(created.data), null, stringOrNull(preflightData.email));
  }

  async preflightDirect(input: {product: RechargeProduct; plan: string; credential: RechargeCredential}): Promise<PreflightResult> {
    if (input.product !== "gpt") throw new UpstreamRequestError("upstream_product_unavailable", false);
    const plans = await this.api("GET", `/gpt-direct/plans?product=${encodeURIComponent(input.product)}`);
    const planData = asObject(plans.data);
    assertPurchasable(planData, input.product, input.plan);
    const region = {payment_country: "PH", payment_currency: "PHP"};
    const preflight = await this.api("POST", "/gpt-direct/preflight", {product: input.product, credential: upstreamCredential(input.credential), ...region});
    const preflightData = asObject(preflight.data);
    const preflightToken = stringOrNull(preflightData.preflight_token);
    if ((input.product === "gpt" && !preflightToken) || stringOrNull(preflightData.quote_error)) {
      throw new UpstreamRequestError("upstream_quote_unavailable", true);
    }
    return {accountEmail: requireAccountEmail(preflightData.email),
      currentPlan: stringOrNull(preflightData.currentPlan) ?? stringOrNull(preflightData.current_plan), targetPlan: input.plan};
  }

  async preflightCdk(input: {upstreamCode: string; credential: RechargeCredential; deviceId: string}): Promise<PreflightResult> {
    const headers = {"X-Redemption-Device": input.deviceId};
    const preview = await this.cdk("POST", "/preview", {code: input.upstreamCode}, headers);
    const previewData = asObject(preview.data);
    const redemptionToken = requireString(previewData.redemption_token, "upstream_cdk_invalid");
    const preflight = await this.cdk("POST", "/preflight", {redemption_token: redemptionToken, credential: upstreamCredential(input.credential)}, headers);
    const preflightData = asObject(preflight.data);
    requireString(preflightData.preflight_token, "upstream_preflight_failed");
    return {accountEmail: requireAccountEmail(preflightData.email),
      currentPlan: stringOrNull(preflightData.currentPlan) ?? stringOrNull(preflightData.current_plan),
      targetPlan: stringOrNull(previewData.plan)};
  }

  async submitCdk(input: {upstreamCode: string; credential: RechargeCredential; clientRequestId: string; deviceId: string; onSubmitting?: SubmissionCheckpoint}): Promise<UpstreamOrderState> {
    const headers = {"X-Redemption-Device": input.deviceId};
    const preview = await this.cdk("POST", "/preview", {code: input.upstreamCode}, headers);
    const previewData = asObject(preview.data);
    const redemptionToken = requireString(previewData.redemption_token, "upstream_cdk_invalid");
    const preflight = await this.cdk("POST", "/preflight", {redemption_token: redemptionToken, credential: upstreamCredential(input.credential)}, headers);
    const preflightData = asObject(preflight.data);
    const preflightToken = requireString(preflightData.preflight_token, "upstream_preflight_failed");
    // Persist the lookup token before redemption: a lost POST response must only be queried.
    input.onSubmitting?.(redemptionToken);
    const redeemed = await this.cdk("POST", "/redeem", {
      redemption_token: redemptionToken,
      preflight_token: preflightToken,
      client_request_id: input.clientRequestId,
    }, headers);
    return normalizeOrder(asObject(redeemed.data), redemptionToken, stringOrNull(preflightData.email));
  }

  async query(input: {mode: "direct" | "cdk"; orderId: string; lookupToken: string | null; deviceId: string; clientRequestId?: string}): Promise<UpstreamOrderState> {
    if (input.mode === "cdk") {
      if (!input.lookupToken) throw new UpstreamRequestError("upstream_reference_missing", false);
      const result = await this.cdk("GET", `/result?token=${encodeURIComponent(input.lookupToken)}`, undefined, {"X-Redemption-Device": input.deviceId});
      const data = asObject(result.data);
      return normalizeOrder(asObject(data.order ?? data), input.lookupToken, null);
    }
    if (!input.orderId) {
      // The API has no documented lookup-by-client-id endpoint. Scan a bounded set of
      // owned orders; if still unknown keep reconciliation pending, never create again.
      if (!input.clientRequestId) throw new UpstreamRequestError("upstream_reference_missing", true);
      for (let page = 1; page <= 10; page++) {
        const data = await this.listDirectOrders(page, 100);
        const list = Array.isArray(data.list) ? data.list.map(asObject) : [];
        const found = list.find((row) => row.client_request_id === input.clientRequestId);
        if (found) return normalizeOrder(found, null, null);
        if (list.length < 100 || page * 100 >= Number(data.total)) break;
      }
      throw new UpstreamRequestError("upstream_result_unknown", true);
    }
    const result = await this.api("GET", `/gpt-direct/orders/${encodeURIComponent(input.orderId)}`);
    const data = asObject(result.data);
    return normalizeOrder(asObject(data.order ?? data), null, null);
  }

  async issueCdk(input: {plan: string; idempotencyKey: string}): Promise<{id: string; code: string}> {
    // Current upstream CDKs do not accept owner_funding_cap_minor. A newly
    // issued code carries no hard funding cap and its redemption uses the
    // owner's live card-pool rules and automatic card selection.
    const response = await this.api("POST", "/gpt-direct/cdks", {
      plan: input.plan,
      count: 1,
      funding_confirmed: true,
      payment_country: "PH",
      payment_currency: "PHP",
    }, input.idempotencyKey);
    const data = asObject(response.data);
    const issued = Array.isArray(data.issued) ? data.issued.map(asObject) : [];
    const first = issued[0];
    if (!first) throw new UpstreamRequestError("upstream_cdk_issue_failed", true);
    const id = String(first.id ?? "");
    if (!id) throw new UpstreamRequestError("upstream_cdk_id_missing", true);
    return {id, code: requireString(first.code, "upstream_cdk_code_missing")};
  }

  async disableCdk(id: string): Promise<void> {
    try {
      const data = asObject((await this.api("POST", "/gpt-direct/cdks/" + encodeURIComponent(id) + "/disable", {}, "quefa-disable-" + id)).data);
      if (String(data.id) !== id || data.status !== "disabled") throw new UpstreamRequestError("upstream_disable_unknown", true);
    } catch (error) {
      // Lost response / repeat operation: only a confirmed disabled record counts.
      for (let page = 1; page <= 10; page++) {
        const data = await this.listCdks(page, 100);
        const rows = Array.isArray(data.list) ? data.list.map(asObject) : [];
        const row = rows.find(x => String(x.id) === id);
        if (row?.status === "disabled") return;
        if (row || rows.length < 100) break;
      }
      throw error;
    }
  }

  async getBalance(): Promise<JsonObject> {
    return asObject((await this.api("GET", "/balance")).data);
  }

  async costFacts(orderId: string, mode: "direct" | "cdk"): Promise<UpstreamCostFacts> {
    const response = await this.api("GET", `/gpt-direct/${mode === "cdk" ? "cdk-orders" : "orders"}/${encodeURIComponent(orderId)}`);
    const data = asObject(response.data), order = asObject(data.order ?? data);
    if (String(order.order_id ?? order.id ?? "") !== orderId) throw new UpstreamRequestError("upstream_order_mismatch", false);
    const amount = numberOrNull(order.final_amount_minor);
    // Native final amount is NOT USD expense or card settlement. Keep missing/zero pending.
    const facts:UpstreamCostFacts={amountMinor: amount !== null && Number.isSafeInteger(amount) && amount > 0 ? amount : null,
      currency: typeof order.currency === "string" && /^[A-Z]{3}$/.test(order.currency) ? order.currency : null,candidates:[],matchIssue:null};
    if(!Number.isSafeInteger(order.card_id)||Number(order.card_id)<=0){facts.matchIssue="card_missing";return facts;}
    const result=await this.api("GET",`/cards/${order.card_id}/transactions?page=1&page_size=100&sync=0`);
    const records=Array.isArray(result.data)?result.data:Array.isArray(asObject(result.data).list)?asObject(result.data).list as unknown[]:[];
    facts.candidates=matchOrderTrades(order,records);
    facts.matchIssue=facts.candidates.length===1?null:facts.candidates.length>1?"ambiguous_trades":"no_matching_trade";
    return facts;
  }

  async getPlanCatalog(product: RechargeProduct): Promise<JsonObject> {
    return asObject((await this.api("GET", `/gpt-direct/plans?product=${encodeURIComponent(product)}`)).data);
  }

  async listDirectOrders(page: number, pageSize: number): Promise<JsonObject> {
    return asObject((await this.api("GET", `/gpt-direct/orders?page=${page}&page_size=${pageSize}`)).data);
  }

  async listCdks(page: number, pageSize: number): Promise<JsonObject> {
    return asObject((await this.api("GET", `/gpt-direct/cdks?page=${page}&page_size=${pageSize}`)).data);
  }

  async listCdkOrders(page: number, pageSize: number): Promise<JsonObject> {
    return asObject((await this.api("GET", `/gpt-direct/cdk-orders?page=${page}&page_size=${pageSize}`)).data);
  }

  private api(method: string, path: string, body?: JsonObject, idempotencyKey?: string): Promise<JsonObject> {
    return requestJson(`${this.apiBase}${path}`, method, body, {
      "X-API-Key": this.apiKey,
      ...(idempotencyKey ? {"Idempotency-Key": idempotencyKey} : {}),
    });
  }

  private cdk(method: string, path: string, body?: JsonObject, headers: Record<string, string> = {}): Promise<JsonObject> {
    return requestJson(`${this.cdkBase}${path}`, method, body, headers);
  }
}

async function requestJson(url: string, method: string, body: JsonObject | undefined, headers: Record<string, string>): Promise<JsonObject> {
  let response: Response;
  try {
    const request: RequestInit = {
      method,
      redirect: "error",
      headers: {accept: "application/json", ...(body ? {"content-type": "application/json"} : {}), ...headers},
      signal: AbortSignal.timeout(15_000),
      ...(body ? {body: JSON.stringify(body)} : {}),
    };
    response = await fetch(url, request);
  } catch {
    throw new UpstreamRequestError("upstream_unavailable", true);
  }
  let payload: JsonObject;
  try {
    payload = asObject(await response.json());
  } catch {
    throw new UpstreamRequestError("upstream_invalid_response", true);
  }
  if (typeof payload.code !== "number") throw new UpstreamRequestError("upstream_invalid_response", true);
  if (!response.ok || payload.code !== 0) {
    const code = String(payload.error_code ?? "");
    throw mapUpstreamError(response.status, code, stringOrNull(payload.msg));
  }
  return payload;
}

function mapUpstreamError(status: number, code: string, message: string | null): UpstreamRequestError {
  if ([408, 409, 429, 500, 502, 503, 504].includes(status) || ["channel_unavailable", "GPT_DIRECT_UNAVAILABLE", "GPT_DIRECT_PAUSED", "GPT_PRICE_UNCONFIRMED"].includes(code)) {
    return new UpstreamRequestError("upstream_unavailable", true);
  }
  if (["GPT_SESSION_INVALID", "CLAUDE_SESSION_INVALID", "SESSION_REQUIRED"].includes(code)) {
    return new UpstreamRequestError("session_invalid", false, "账号凭据无效");
  }
  if (code === "MAILBOX_LOGIN_FAILED") {
    return new UpstreamRequestError("mailbox_login_failed", false, "邮箱登录失败，请检查邮箱和密码，或改用 Session / Access Token 后重新提交");
  }
  if (code === "PRECHECK_REJECTED") return new UpstreamRequestError("precheck_rejected", false, safeBusinessMessage(message, "账号预检未通过"));
  if (code === "GPT_PLAN_ALREADY_ACTIVE") return new UpstreamRequestError("account_has_subscription", false, "账号已有有效套餐");
  if (code === "GPT_CREDIT_REQUIRES_SUBSCRIPTION") return new UpstreamRequestError("subscription_required", false, "当前账号不支持订购此套餐：需已有有效订阅");
  if (["DIRECT_PRODUCT_DISABLED", "GPT_CREDIT_DISABLED"].includes(code)) return new UpstreamRequestError("product_unavailable", false, "当前套餐暂不支持订购");
  if (code === "ACCOUNT_UNAVAILABLE") return new UpstreamRequestError("account_unavailable", false, "当前账号不可用于本次充值");
  if (code === "GPT_DIRECT_ORDER_REJECTED") return new UpstreamRequestError("order_rejected", false, safeBusinessMessage(message, "充值请求未通过业务校验"));
  if (["INSUFFICIENT_BALANCE", "insufficient_balance", "RECHARGE_REQUIRED"].includes(code)) return new UpstreamRequestError("upstream_balance_insufficient", false);
  if ([401, 403].includes(status)) return new UpstreamRequestError("upstream_configuration_error", false);
  // An unrecognised provider code is not proof that no recharge/CDK was created.
  return new UpstreamRequestError("upstream_result_unknown", true, "充值请求结果待核对，请勿重复提交");
}

function requireAccountEmail(value: unknown): string {
  const email = stringOrNull(value);
  if (!email) throw new UpstreamRequestError("account_unavailable", false, "无法识别充值账号，请检查凭据后重试");
  return email;
}

function normalizeOrder(data: JsonObject, lookupToken: string | null, fallbackEmail: string | null): UpstreamOrderState {
  const id = String(data.id ?? data.order_id ?? "");
  if (!id || typeof data.status !== "string") throw new UpstreamRequestError("upstream_invalid_response", true);
  const status = data.status;
  return {
    orderId: id,
    lookupToken,
    status,
    stage: stringOrNull(data.stage),
    accountEmail: stringOrNull(data.account_email) ?? stringOrNull(data.email) ?? fallbackEmail,
    quotedAmountMinor: numberOrNull(data.quoted_amount_minor) ?? numberOrNull(data.final_amount_minor),
    chargedAmountMinor: numberOrNull(data.final_amount_minor),
    cardLastFour: cardLastFour(data.card_last_four ?? data.card_number_masked),
    currency: stringOrNull(data.currency),
    message: stringOrNull(data.message),
  };
}

function assertPurchasable(data: JsonObject, product: RechargeProduct, plan: string): void {
  const registry = Array.isArray(data.registry) ? data.registry.map(asObject) : [];
  const row = registry.find((item) => item.product === product && item.key === plan);
  if (!row || row.purchasable !== true) throw new UpstreamRequestError("upstream_product_unavailable", false, "商品暂不可售");
  const plans = asObject(data.plans);
  const configured = asObject(plans[String(row.acc_plan_key ?? plan)]);
  if (configured.enabled !== true) throw new UpstreamRequestError("upstream_product_unavailable", false, "商品暂不可售");
}

function upstreamCredential(value: RechargeCredential): JsonObject {
  if (value.mode === "session") return {mode: value.mode, session: value.session};
  if (value.mode === "access_token") return {mode: value.mode, accessToken: value.accessToken};
  return {mode: value.mode, email: value.email, password: value.password};
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cardLastFour(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function requireString(value: unknown, code: string): string {
  const result = stringOrNull(value);
  if (!result) throw new UpstreamRequestError(code, false);
  return result;
}
