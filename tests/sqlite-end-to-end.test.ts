import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {buildApp} from "../src/app.js";
import {signRequest} from "../src/auth/signature.js";
import {createRuntime} from "../src/bootstrap.js";
import type {Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {AppConfig} from "../src/config.js";
import type {UpstreamOrderState} from "../src/upstream/recharge-provider.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

describe("persistent SQLite business flow", () => {
  const temporaryDirectories: string[] = [];
  const admin = {id: "e2e-admin", role: "platform_admin" as const, merchantId: null};

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
  });

  it("survives restarts from signed order through CDK fulfilment and manual daily settlement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quefa-sqlite-e2e-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: join(directory, "flow.sqlite"), LOG_LEVEL: "silent"});
    const merchantOrderNo = "sqlite-e2e-" + randomUUID();
    const rawSession = "synthetic-e2e-session-never-send-upstream";
    let merchantId = "", orderId = "", voucherCode = "", upstreamCode = "", redemptionId = "";

    // Phase 1: an authenticated partner creates and pays an order, the worker
    // issues the platform CDK, and the partner submits a white-label redemption.
    {
      const runtime = createRuntime(config);
      publishTestRechargeProduct(runtime);
      const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
      merchantId = credential.merchant.id;
      const profile = runtime.agents.profile(merchantId);
      runtime.agents.saveProfile(admin, merchantId, {...profile, customRedemptionEnabled: true});
      const app = await buildApp(config, runtime);
      try {
        const created = await signed(app, config, "POST", "/v1/orders", {
          merchant_order_no: merchantOrderNo,
          product_code: "chatgpt_plus_cdk_1m",
          quantity: 1,
          sale_amount: "135.00",
          collection_mode: "platform_collect",
          delivery_mode: "cdk",
        }, "sqlite-e2e-order");
        expect(created.statusCode).toBe(201);
        orderId = created.json().data.order_id;

        const order = runtime.repository.findOrderInternal(orderId)!;
        runtime.payment.markPaid(merchantId, orderId, {
          providerRef: "test-alipay-sqlite-e2e",
          receivedMinor: order.saleAmountMinor,
        });
        const attempt = runtime.repository.findPaymentAttemptByOrder(merchantId, orderId)!;
        // The isolated mock payment endpoint stands in for a verified Alipay
        // callback; this marker exercises the production earnings eligibility.
        runtime.repository.updatePaymentAttempt({...attempt, provider: "alipay_page", status: "paid"});

        const voucher = await runtime.cdk.issueOne();
        expect(voucher).not.toBeNull();
        voucherCode = voucher!.publicCode;
        upstreamCode = runtime.cdk.readUpstreamCode(voucher!);
        const redeemed = await signed(app, config, "POST", "/v1/redemptions", {
          mode: "cdk",
          code: voucherCode,
          credential: {mode: "session", session: rawSession},
          customer_confirmed_email: true,
        }, "sqlite-e2e-redemption");
        expect(redeemed.statusCode).toBe(202);
        expect(redeemed.json().data).toMatchObject({order_id: orderId, status: "queued", attempt_no: 1});
        redemptionId = redeemed.json().data.redemption_id;

        const task = runtime.repository.findFulfillment(merchantId, redemptionId)!;
        expect(task.sessionPayload.ciphertext).toBeTruthy();
        expect(JSON.stringify(task)).not.toContain(rawSession);
        expect(JSON.stringify(task)).not.toContain(upstreamCode);
        expect(runtime.repository.findCdkVoucherByOrder(orderId)?.status).toBe("reserved");

        const foreignOrder = await signed(app, config, "GET", "/v1/orders/" + orderId, undefined, "foreign-order-read", true);
        const foreignRedemption = await signed(app, config, "GET", "/v1/redemptions/" + redemptionId, undefined, "foreign-redemption-read", true);
        expect(foreignOrder.statusCode).toBe(404);
        expect(foreignRedemption.statusCode).toBe(404);
      } finally {
        await app.close();
        runtime.close();
      }
    }

    // Phase 2: after a full process restart, the worker resumes the persisted
    // task, records one terminal result, consumes the CDK and credits earnings.
    {
      const runtime = createRuntime(config);
      const app = await buildApp(config, runtime);
      try {
        expect(runtime.repository.findOrderInternal(orderId)?.paymentStatus).toBe("paid");
        expect(runtime.repository.findFulfillment(merchantId, redemptionId)?.status).toBe("queued");
        Object.defineProperty(runtime.upstream, "name", {value: "configured_supplier", configurable: true});
        const submit = vi.spyOn(runtime.upstream, "submitCdk").mockImplementation(async input => {
          input.onSubmitting?.("private-sqlite-e2e-lookup");
          return completedState(input.clientRequestId);
        });
        const completed = await runtime.fulfillments.processOne();
        expect(completed).toMatchObject({id: redemptionId, status: "succeeded", upstreamProvider: "configured_supplier"});
        expect(submit).toHaveBeenCalledTimes(1);
        expect(runtime.repository.findCdkVoucherByOrder(orderId)).toMatchObject({status: "consumed"});
        expect(runtime.repository.findCdkVoucherByOrder(orderId)?.upstreamCodePayload.ciphertext).toBeNull();

        const releases = () => runtime.repository.listOperations("wallet_entry", merchantId)
          .filter(entry => entry.kind === "earning_release" && entry.reference === orderId);
        expect(releases()).toHaveLength(1);
        expect(releases()[0]).toMatchObject({earningsDelta: 2_500n, actorId: "system"});
        expect(runtime.wallets.summary({id: "e2e-agent", role: "agent_owner", merchantId}, merchantId))
          .toMatchObject({earningsAvailable: "25.00", pendingReviewEarnings: "0.00"});

        expect(runtime.fulfillments.applyUpstreamEvent(redemptionId, completedState(redemptionId))?.status).toBe("succeeded");
        expect(releases()).toHaveLength(1);
        const status = await signed(app, config, "GET", "/v1/redemptions/" + redemptionId, undefined, "redemption-status");
        expect(status.statusCode).toBe(200);
        expect(status.json().data).toMatchObject({order_id: orderId, status: "succeeded", next_action: "none"});
        expect(status.body).not.toContain(rawSession);
        expect(status.body).not.toContain(upstreamCode);
        expect(status.body).not.toContain("private-sqlite-e2e-lookup");
        expect(status.body).not.toContain("configured_supplier");

        // Move the isolated facts into a stable historical accounting window so
        // daily settlement is deterministic regardless of the test run date.
        const accountedAt = new Date("2020-01-01T12:00:00.000Z");
        const storedOrder = runtime.repository.findOrderInternal(orderId)!;
        runtime.repository.updateOrder({...storedOrder, paidAt: accountedAt, createdAt: accountedAt, updatedAt: accountedAt});
        const payment = runtime.repository.findPaymentAttemptByOrder(merchantId, orderId)!;
        runtime.repository.updatePaymentAttempt({...payment, paidAt: accountedAt, createdAt: accountedAt, updatedAt: accountedAt});
        const credit = runtime.repository.getOperations("wallet_credit", orderId)!;
        runtime.repository.saveOperations("wallet_credit", {...credit, createdAt: accountedAt});
      } finally {
        await app.close();
        runtime.close();
      }
    }

    // Phase 3: another restart creates a read-only settlement, then an explicit
    // administrator action records an external payout and reconciles it.
    {
      const runtime = createRuntime(config);
      try {
        expect(runtime.dailySettlements.generate("2020-01-01")).toMatchObject({generated: true, count: 1});
        expect(runtime.dailySettlements.generate("2020-01-01")).toMatchObject({generated: false, count: 0});
        const statement = runtime.repository.getOperations("daily_settlement", `ds_20200101_${merchantId}`)!;
        expect(statement).toMatchObject({status: "pending_payment", orderIds: [orderId], orderCount: 1,
          supplyAmountMinor: 11_000n, agentEarningsMinor: 2_500n, platformCostMinor: 10_800n,
          platformProfitMinor: 200n, payableMinor: 2_500n});
        const payout = {method: "other" as const, reference: "TEST-E2E-PAYOUT-0001",
          evidence: "隔离测试付款凭证，不代表真实资金操作", note: "SQLite 端到端验收"};
        expect(runtime.dailySettlements.confirmPaid(admin, statement.id, payout).status).toBe("paid");
        expect(runtime.dailySettlements.confirmPaid(admin, statement.id, payout).status).toBe("paid");
        expect(runtime.repository.listOperations("wallet_entry", merchantId)
          .filter(entry => entry.kind === "settlement_payout" && entry.id === "settlement_payout:" + statement.id)).toHaveLength(1);
        expect(runtime.dailySettlements.reconcile(admin, statement.id, "代理到账与流水已核对").status).toBe("reconciled");
      } finally {
        runtime.close();
      }
    }

    // Phase 4: terminal financial state and its exactly-once ledger survive yet
    // another restart; no in-memory state is required to reconstruct the result.
    {
      const runtime = createRuntime(config);
      try {
        expect(runtime.repository.findOrderInternal(orderId)?.paymentStatus).toBe("paid");
        expect(runtime.repository.findFulfillment(merchantId, redemptionId)?.status).toBe("succeeded");
        expect(runtime.repository.findCdkVoucherByOrder(orderId)?.status).toBe("consumed");
        expect(runtime.repository.getOperations("daily_settlement", `ds_20200101_${merchantId}`)?.status).toBe("reconciled");
        expect(runtime.repository.listOperations("wallet_entry", merchantId)
          .filter(entry => entry.kind === "earning_release" && entry.reference === orderId)).toHaveLength(1);
        expect(runtime.repository.listOperations("wallet_entry", merchantId)
          .filter(entry => entry.kind === "settlement_payout")).toHaveLength(1);
        expect(runtime.wallets.summary({id: "e2e-agent", role: "agent_owner", merchantId}, merchantId))
          .toMatchObject({earningsAvailable: "0.00", pendingReviewEarnings: "0.00"});
      } finally {
        runtime.close();
      }
    }
  });
});

async function signed(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: AppConfig,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  idempotencyKey: string = randomUUID(),
  partnerB = false,
) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const keyId = partnerB ? "key_demo_b_01" : config.demoKeyId;
  const headers = {
    "x-partner-id": partnerB ? "pt_demo_b" : config.demoPartnerId,
    "x-key-id": keyId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "idempotency-key": idempotencyKey,
    "x-signature": signRequest({method, path, rawQuery: "", timestamp, nonce, keyId, idempotencyKey,
      rawBody: Buffer.from(body)}, partnerB ? "demo-secret-b-must-be-at-least-32-characters" : config.demoClientSecret),
    ...(payload === undefined ? {} : {"content-type": "application/json"}),
  };
  return app.inject({method, url: path, headers, ...(payload === undefined ? {} : {payload: body})});
}

function completedState(orderId: string): UpstreamOrderState {
  return {orderId, lookupToken: "private-sqlite-e2e-lookup", status: "completed", stage: "completed",
    accountEmail: "sqlite-e2e@example.com", quotedAmountMinor: 1_576, chargedAmountMinor: 1_576,
    cardLastFour: "1234", currency: "USD", message: "充值成功"};
}
