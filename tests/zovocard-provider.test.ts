import {afterEach, describe, expect, it, vi} from "vitest";
import {ZovoCardRechargeProvider} from "../src/upstream/zovocard-provider.js";

describe("recharge supplier adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses plans, preflight and idempotent order creation for direct recharge", async () => {
    const requests: Array<{url: string; init: RequestInit}> = [];
    const replies = [
      {code: 0, data: {version: 2, registry: [{product: "gpt", key: "plus", acc_plan_key: "plus", purchasable: true}], plans: {plus: {enabled: true}}}},
      {code: 0, data: {email: "buyer@example.com", preflight_token: "pf_direct", quote_error: ""}},
      {code: 0, data: {id: 981, status: "queued", stage: "queued", quoted_amount_minor: 98214, currency: "PHP"}},
    ];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({url: String(input), init});
      return Response.json(replies.shift(), {status: requests.length === 3 ? 202 : 200});
    });
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret-api-key", 123);
    const state = await provider.submitDirect({
      product: "gpt", plan: "plus", credential: {mode: "session", session: "private-session"}, clientRequestId: "ful_001",
    });

    expect(requests.map((item) => item.url)).toEqual([
      "https://supplier.test/openapi/v1/gpt-direct/plans?product=gpt",
      "https://supplier.test/openapi/v1/gpt-direct/preflight",
      "https://supplier.test/openapi/v1/gpt-direct/orders",
    ]);
    expect(new Headers(requests[2]!.init.headers).get("x-api-key")).toBe("secret-api-key");
    expect(new Headers(requests[2]!.init.headers).get("idempotency-key")).toBe("ful_001");
    expect(JSON.parse(String(requests[2]!.init.body))).toMatchObject({
      card_id: 123, product: "gpt", plan: "plus", preflight_token: "pf_direct", client_request_id: "ful_001", pricing_version: 2,
      payment_country: "PH", payment_currency: "PHP", credential: {mode: "session", session: "private-session"},
    });
    expect(state).toMatchObject({orderId: "981", status: "queued", accountEmail: "buyer@example.com", currency: "PHP"});
  });

  it("returns the account email from CDK preflight without redeeming", async () => {
    const requests: Array<{url: string; init: RequestInit}> = [];
    const replies = [
      {code: 0, data: {redemption_token: "redeem_token", plan: "pro_5x"}},
      {code: 0, data: {preflight_token: "pf_cdk", email: "buyer@example.com", currentPlan: "free"}},
    ];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({url: String(input), init});
      return Response.json(replies.shift());
    });
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret-api-key", 123);
    const result = await provider.preflightCdk({
      upstreamCode: "ZC-AAAA-BBBB-CCCC-DDDD", credential: {mode: "session", session: "private-session"}, deviceId: "quefa-device-001",
    });
    expect(result).toEqual({accountEmail: "buyer@example.com", currentPlan: "free", targetPlan: "pro_5x"});
    expect(requests.map((item) => item.url)).toEqual([
      "https://supplier.test/api/v1/cdk/preview",
      "https://supplier.test/api/v1/cdk/preflight",
    ]);
    expect(requests.some((item) => item.url.includes("/redeem"))).toBe(false);
  });

  it("treats a mailbox login rejection as a definite credential failure without redeeming or exposing the supplier message", async () => {
    const requests: string[] = [];
    const replies = [Response.json({code: 0, data: {redemption_token: "private-preview-ticket"}}),
      Response.json({code: 400, error_code: "MAILBOX_LOGIN_FAILED", msg: "supplier secret password=private-password"}, {status: 400})];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {requests.push(String(input)); return replies.shift()!;});
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", 123);
    await expect(provider.preflightCdk({upstreamCode: "test-cdk", deviceId: "test-device",
      credential: {mode: "mailbox", email: "buyer@example.com", password: "private-password"}})).rejects.toMatchObject({
      failureCode: "mailbox_login_failed", retryable: false,
      message: "邮箱登录失败，请检查邮箱和密码，或改用 Session / Access Token 后重新提交",
    });
    expect(requests).toHaveLength(2);
    expect(requests.some(url => url.endsWith("/redeem"))).toBe(false);
  });

  it("keeps one device identity through CDK redemption and reads the nested result order", async () => {
    const requests: Array<{url: string; init: RequestInit}> = [];
    const replies = [
      {code: 0, data: {redemption_token: "redeem_token"}},
      {code: 0, data: {preflight_token: "pf_cdk", email: "buyer@example.com"}},
      {code: 0, data: {id: 2001, status: "queued", stage: "queued"}},
      {code: 0, data: {order: {id: 2001, status: "completed", stage: "completed", message: "ok"}, events: []}},
      {code: 0, data: {requested: 1, issued: [{id: 88, code: "ZC-AAAA-BBBB-CCCC-DDDD", plan: "plus"}]}},
    ];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({url: String(input), init});
      return Response.json(replies.shift(), {status: 200});
    });
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret-api-key", 123);
    const submitted = await provider.submitCdk({
      upstreamCode: "ZC-AAAA-BBBB-CCCC-DDDD", credential: {mode: "access_token", accessToken: "private-token"},
      clientRequestId: "ful_cdk_001", deviceId: "quefa-device-001",
    });
    const completed = await provider.query({mode: "cdk", orderId: submitted.orderId, lookupToken: submitted.lookupToken, deviceId: "quefa-device-001"});
    const issued = await provider.issueCdk({plan: "plus", idempotencyKey: "quefa-cdk-order-001"});

    expect(requests.slice(0, 4).map((item) => new Headers(item.init.headers).get("x-redemption-device"))).toEqual([
      "quefa-device-001", "quefa-device-001", "quefa-device-001", "quefa-device-001",
    ]);
    expect(requests[3]!.url).toBe("https://supplier.test/api/v1/cdk/result?token=redeem_token");
    expect(completed).toMatchObject({orderId: "2001", status: "completed", lookupToken: "redeem_token"});
    expect(issued).toEqual({id: "88", code: "ZC-AAAA-BBBB-CCCC-DDDD"});
    expect(new Headers(requests[4]!.init.headers).get("idempotency-key")).toBe("quefa-cdk-order-001");
  });

  it("rejects non-GPT direct products before sending an upstream request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", 123);
    await expect(provider.submitDirect({product: "grok", plan: "monthly", credential: {mode: "session", session: "sso-cookie"}, clientRequestId: "grok-1"}))
      .rejects.toMatchObject({failureCode: "upstream_product_unavailable", retryable: false});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not treat a malformed success response as an accepted order", async () => {
    vi.stubGlobal("fetch", async () => Response.json({data: {order: {id: 12, status: "completed"}}}));
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", 123);
    await expect(provider.query({mode: "direct", orderId: "12", lookupToken: null, deviceId: "device"})).rejects.toMatchObject({failureCode: "upstream_invalid_response", retryable: true});
  });

  it("keeps a safe actionable preflight reason without exposing the supplier", async () => {
    const replies = [
      Response.json({code: 0, data: {version: 2, registry: [{product: "gpt", key: "plus", acc_plan_key: "plus", purchasable: true}], plans: {plus: {enabled: true}}}}),
      Response.json({code: 400, error_code: "PRECHECK_REJECTED", msg: "该账号需要先完成人机核验"}, {status: 400}),
    ];
    vi.stubGlobal("fetch", async () => replies.shift()!);
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", 123);
    await expect(provider.submitDirect({product: "gpt", plan: "plus", credential: {mode: "session", session: "session"}, clientRequestId: "preflight-1"}))
      .rejects.toMatchObject({failureCode: "precheck_rejected", retryable: false, message: "该账号需要先完成人机核验"});
  });

  it("recovers an uncertain direct submission by client request id using only GET", async () => {
    const fetcher = vi.fn(async () => Response.json({code: 0, data: {total: 1, list: [{id: 33, client_request_id: "lost-response", status: "review"}]}}));
    vi.stubGlobal("fetch", fetcher);
    const provider = new ZovoCardRechargeProvider("https://supplier.test/openapi/v1", "https://supplier.test/api/v1/cdk", "secret", 123);
    const state = await provider.query({mode: "direct", orderId: "", lookupToken: null, deviceId: "device", clientRequestId: "lost-response"});
    expect(state).toMatchObject({orderId: "33", status: "review"});
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/gpt-direct/orders?page=1"), expect.objectContaining({method: "GET"}));
  });
});
