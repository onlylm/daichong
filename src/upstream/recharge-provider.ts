import {createHash} from "node:crypto";

export type RechargeProduct = "gpt" | "claude" | "grok";

export type SubmissionCheckpoint = (lookupToken: string | null) => void;

export type RechargeCredential =
  | {mode: "session"; session: string}
  | {mode: "access_token"; accessToken: string}
  | {mode: "mailbox"; email: string; password: string};

export interface PreflightResult {
  accountEmail: string;
  currentPlan: string | null;
  targetPlan: string | null;
}

export interface UpstreamOrderState {
  orderId: string;
  lookupToken: string | null;
  status: string;
  stage: string | null;
  accountEmail: string | null;
  quotedAmountMinor: number | null;
  chargedAmountMinor?: number | null;
  cardLastFour?: string | null;
  currency: string | null;
  message: string | null;
}

export interface RechargeUpstreamProvider {
  readonly name: string;
  submitDirect(input: {
    product: RechargeProduct;
    plan: string;
    credential: RechargeCredential;
    clientRequestId: string;
    onSubmitting?: SubmissionCheckpoint;
  }): Promise<UpstreamOrderState>;
  submitCdk(input: {
    upstreamCode: string;
    credential: RechargeCredential;
    clientRequestId: string;
    deviceId: string;
    onSubmitting?: SubmissionCheckpoint;
  }): Promise<UpstreamOrderState>;
  query(input: {mode: "direct" | "cdk"; orderId: string; lookupToken: string | null; deviceId: string; clientRequestId?: string}): Promise<UpstreamOrderState>;
  preflightDirect(input: {product: RechargeProduct; plan: string; credential: RechargeCredential}): Promise<PreflightResult>;
  preflightCdk(input: {upstreamCode: string; credential: RechargeCredential; deviceId: string}): Promise<PreflightResult>;
  issueCdk(input: {plan: string; idempotencyKey: string}): Promise<{id: string; code: string}>;
  disableCdk?(id: string): Promise<void>;
}

export class UpstreamRequestError extends Error {
  constructor(
    readonly failureCode: string,
    readonly retryable: boolean,
    message = "上游服务暂时不可用",
  ) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

export class MockRechargeProvider implements RechargeUpstreamProvider {
  readonly name = "mock";
  async disableCdk(_id: string): Promise<void> {}

  async submitDirect(input: {product: RechargeProduct; plan: string; credential: RechargeCredential; clientRequestId: string}): Promise<UpstreamOrderState> {
    return mockState(input.clientRequestId, input.credential);
  }

  async submitCdk(input: {upstreamCode: string; credential: RechargeCredential; clientRequestId: string; deviceId: string}): Promise<UpstreamOrderState> {
    return mockState(input.clientRequestId, input.credential);
  }

  async query(input: {mode: "direct" | "cdk"; orderId: string; lookupToken: string | null; deviceId: string}): Promise<UpstreamOrderState> {
    return {orderId: input.orderId, lookupToken: input.lookupToken, status: "completed", stage: "completed", accountEmail: null, quotedAmountMinor: 0, currency: "USD", message: "充值成功"};
  }

  async preflightDirect(input: {product: RechargeProduct; plan: string; credential: RechargeCredential}): Promise<PreflightResult> {
    return mockPreflight(input.credential, input.plan);
  }

  async preflightCdk(_input: {upstreamCode: string; credential: RechargeCredential; deviceId: string}): Promise<PreflightResult> {
    return mockPreflight(_input.credential, "plus");
  }

  async issueCdk(input: {plan: string; idempotencyKey: string}): Promise<{id: string; code: string}> {
    const digest = createHash("sha256").update(input.idempotencyKey).digest("hex").toUpperCase();
    return {id: `mock_${digest.slice(0, 16)}`, code: `ZC-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`};
  }
}

function mockPreflight(credential: RechargeCredential, targetPlan: string): PreflightResult {
  if (credential.mode === "mailbox") return {accountEmail: credential.email, currentPlan: "free", targetPlan};
  if (JSON.stringify(credential).includes("simulate_failure")) throw new UpstreamRequestError("session_invalid", false, "账号凭据无效");
  return {accountEmail: "preview@example.com", currentPlan: "free", targetPlan};
}

function mockState(clientRequestId: string, credential: RechargeCredential): UpstreamOrderState {
  const serialized = JSON.stringify(credential);
  if (serialized.includes("simulate_failure")) {
    return {orderId: `mock_${clientRequestId}`, lookupToken: null, status: "declined", stage: "failed", accountEmail: null, quotedAmountMinor: 0, currency: "USD", message: "模拟充值失败"};
  }
  return {orderId: `mock_${clientRequestId}`, lookupToken: null, status: "completed", stage: "completed", accountEmail: credential.mode === "mailbox" ? credential.email : null, quotedAmountMinor: 0, currency: "USD", message: "模拟充值成功"};
}
