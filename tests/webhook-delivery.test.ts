import type {DatabaseSync} from "node:sqlite";
import {describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import type {AppConfig} from "../src/config.js";
import {verifyWebhook} from "../src/modules/webhook-signature.js";
import {OutboxWorker} from "../src/worker/outbox-worker.js";
import {RepositoryWebhookDeliveryStore} from "../src/worker/repository-webhook-store.js";

describe("webhook delivery", () => {
  it("signs and delivers a persisted outbox event", async () => {
    const config = webhookConfig();
    const runtime = createRuntime(config);
    const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
    runtime.webhooks.emit(merchant.id, "test:webhook:1", "webhook.test", merchant.id, {message: "hello"});

    let captured: {headers: Headers; body: Buffer} | null = null;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = {headers: new Headers(init?.headers), body: Buffer.from(String(init?.body ?? ""))};
      return new Response(null, {status: 204});
    }) as typeof fetch;
    const worker = new OutboxWorker(new RepositoryWebhookDeliveryStore(runtime.repository), fakeFetch);
    expect(await worker.tick()).toBe(1);
    expect(captured).not.toBeNull();
    const delivery = captured!;
    const timestamp = Number(delivery.headers.get("x-quefa-timestamp"));
    expect(verifyWebhook(timestamp, delivery.body, config.demoWebhookSecret, delivery.headers.get("x-quefa-signature") ?? "")).toBe(true);
    expect(delivery.headers.get("x-quefa-event")).toBe("webhook.test");
    expect(await worker.tick()).toBe(0);
    runtime.close();
  });

  it("claims only a bounded due batch from SQLite", () => {
    const config = {...webhookConfig(), storageDriver: "sqlite" as const};
    const runtime = createRuntime(config);
    try {
      const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
      for (let index = 0; index < 10; index++) runtime.webhooks.emit(merchant.id, `test:webhook:bounded:${index}`, "webhook.test", merchant.id, {index});
      const db=(runtime.repository as unknown as {db:DatabaseSync}).db,prepare=vi.spyOn(db,"prepare");
      const claimed=runtime.repository.claimWebhookDeliveries(3,new Date(Date.now()+60_000));
      expect(claimed).toHaveLength(3);
      const select=prepare.mock.calls.map(call=>String(call[0])).find(sql=>sql.includes("kind='webhook_delivery'")&&sql.includes("nextAttemptAt"));
      expect(select).toContain("LIMIT ?");
      expect(select).toContain("leaseUntil");
    } finally {
      vi.restoreAllMocks();
      runtime.close();
    }
  });

  it("deduplicates an emitted event by its indexed key without loading outbox history", () => {
    const config = {...webhookConfig(), storageDriver: "sqlite" as const};
    const runtime = createRuntime(config);
    try {
      const merchant = runtime.repository.findMerchantByPartner(config.demoPartnerId)!;
      const list = vi.spyOn(runtime.repository, "listOutbox");
      const first = runtime.webhooks.emit(merchant.id, "test:webhook:exact-key", "webhook.test", merchant.id, {value: 1});
      const replay = runtime.webhooks.emit(merchant.id, "test:webhook:exact-key", "webhook.test", merchant.id, {value: 1});
      expect(replay.id).toBe(first.id);
      expect(runtime.repository.findOutboxByEventKey?.(merchant.id, "test:webhook:exact-key")?.id).toBe(first.id);
      expect(list).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      runtime.close();
    }
  });
});

function webhookConfig(): AppConfig {
  return {
    nodeEnv: "test", executionMode: "disabled", host: "127.0.0.1", port: 3200, logLevel: "silent", trustProxy: false, trustedProxyCidrs: [],
    enableSandboxRoutes: true, registrationEnabled: false, sandboxAdminToken: "local-sandbox-token-for-tests", demoPartnerId: "pt_webhook",
    platformAdminToken: "test-platform-admin-token-at-least-32-chars",
    demoKeyId: "key_webhook_01", demoClientSecret: "webhook-secret-must-be-at-least-32-characters",
    dataEncryptionKey: Buffer.alloc(32, 5), keyEncryptionKeyId: "test-key-v1", publicBaseUrl: "http://127.0.0.1:3200",
    portalTokenSecret: "test-public-portal-secret-at-least-32-chars", fulfillmentProvider: "mock",
    zovocardApiBase: "https://sandbox.zovocard.com/openapi/v1", zovocardCdkBase: "https://sandbox.zovocard.com/api/v1/cdk",
    zovocardApiKey: null, zovocardCardId: null, zovocardWebhookSecret: null,
    supplierAllowedHosts: ["sandbox.zovocard.com", "zovocard.com"],
    storageDriver: "memory", sqlitePath: ":memory:", backupHealthReportPath: null, backupRestoreMaxAgeMs: 192 * 60 * 60 * 1000,
    demoWebhookUrl: "https://agent.example.test/webhooks/quefa",
    demoWebhookSecret: "test-webhook-secret-123456",
  };
}
