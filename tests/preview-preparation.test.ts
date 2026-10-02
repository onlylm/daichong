import {spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {backup, DatabaseSync} from "node:sqlite";
import {pathToFileURL} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {SensitivePayloadCipher} from "../src/infra/crypto.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";
// The deploy-only ESM script intentionally has no TypeScript/business-code dependency.
// @ts-expect-error JavaScript deployment entry has no declaration file.
import {preparePreview} from "../deploy/preview/prepare-preview.mjs";

const folders: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const folder of folders.splice(0)) rmSync(folder, {recursive: true, force: true}); });
const modules = {createRuntime, loadConfig};
const oldPassword = "OldPreviewPassword-Secret-907!";
const oldPublicCode = "QF-REAL-FIXTURE-CODE-ONLY-123456789";
const encrypted = {ciphertext: "old-ciphertext-fixture", iv: "old-iv", authTag: "old-auth-tag", keyVersion: "old-key", clearedAt: null};

function environment(output: string): NodeJS.ProcessEnv {
  return {ISOLATED_PREVIEW: "true", NODE_ENV: "development", EXECUTION_MODE: "disabled", PAYMENT_PROVIDER: "mock",
    FULFILLMENT_PROVIDER: "mock", ENABLE_SANDBOX_ROUTES: "false", STORAGE_DRIVER: "sqlite", SQLITE_PATH: output,
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PORTAL_TOKEN_SECRET: randomBytes(48).toString("base64url"),
    PLATFORM_ADMIN_TOKEN: randomBytes(48).toString("base64url"), DEMO_CLIENT_SECRET: randomBytes(48).toString("base64url"),
    PREVIEW_ADMIN_USERNAME: "preview_admin", PREVIEW_ADMIN_PASSWORD: "NewPreviewPassword-Secret-908!",
    PUBLIC_BASE_URL: "http://127.0.0.1:3200", LOG_LEVEL: "silent", KEY_ENCRYPTION_KEY_ID: "preview-key"};
}
function records(path: string) {
  const db = new DatabaseSync(path, {readOnly: true});
  try { return db.prepare("SELECT kind,id,payload FROM sandbox_records ORDER BY kind,id").all().map(row => ({
    kind: String(row.kind), id: String(row.id), payload: JSON.parse(String(row.payload)),
  })); } finally { db.close(); }
}
async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "quefa-preview-test-")); folders.push(folder);
  const live = join(folder, "fixture.sqlite"), source = join(folder, "source.sqlite"), output = join(folder, "preview.sqlite");
  const runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: live, LOG_LEVEL: "silent",
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"), ZOVOCARD_API_KEY: "old-supplier-key-fixture-only-123456"}));
  let orderId: string, merchantId: string;
  try {
    const account = await runtime.accounts.bootstrap("old_admin", oldPassword);
    runtime.accounts.issueSessionFor(account);
    publishTestRechargeProduct(runtime);
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    merchantId = credential.merchant.id;
    const order = await runtime.orders.create({merchantId, partnerId: credential.merchant.partnerId,
      appId: credential.app.id, keyId: credential.key.keyId}, {merchantOrderNo: "preview-fixture-order", productCode: "chatgpt_plus_cdk_1m",
      quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    orderId = order.id;
    runtime.payment.markPaid(merchantId, orderId, {providerRef: "old-payment-reference", receivedMinor: 13500n});
    const paid = runtime.repository.findOrderInternal(orderId)!;
    runtime.repository.updateOrder({...paid, voucherCode: oldPublicCode, fulfillmentUrl: "https://real.invalid/redeem?token=old-portal-token",
      qrPayload: "https://qr.alipay.com/old-real-fixture", notifyUrl: "https://real.invalid/callback",
      metadata: {payUrl: "https://real.invalid/pay", accessToken: "old-session-access-token"}});
    runtime.repository.saveOperations("wallet_entry", {id: "wallet-preserve", merchantId, kind: "adjustment", procurementDelta: 10000n,
      earningsDelta: 2300n, frozenDelta: -100n, reference: orderId, actorId: account.id, createdAt: new Date()});
    runtime.repository.insertRefund({id: "refund-preserve", merchantId, orderId, merchantRefundNo: "refund-reference", type: "partial",
      amountMinor: 300n, status: "succeeded", reason: "必须保留的退款事实", failureCode: null, createdAt: new Date(), refundedAt: new Date()});
    runtime.repository.appendAudit({id: "audit-preserve", merchantId, actorId: account.id, actorType: "platform_user", action: "refund.recorded",
      targetType: "refund", targetId: "refund-preserve", requestId: "audit-request-preserve", createdAt: new Date()});
  } finally { runtime.close(); }
  const db = new DatabaseSync(live);
  try {
    const insert = (kind: string, id: string, payload: Record<string, unknown>) => db.prepare(
      "INSERT INTO sandbox_records(kind,id,merchant_id,unique_key,payload,updated_at) VALUES(?,?,?,?,?,?)")
      .run(kind, id, merchantId, id, JSON.stringify({id, merchantId, ...payload}), new Date().toISOString());
    for (const kind of ["ops_mfa_challenge", "idempotency", "webhook_endpoint", "webhook_delivery", "ops_worker_health",
      "ops_payment_settings", "ops_payment_revision", "ops_payment_check", "supplier_webhook_event"]) {
      insert(kind, "old-" + kind, {secret: "old-plaintext-secret", encrypted, url: "https://real.invalid/secret"});
    }
    insert("cdk_voucher", "voucher-preserve", {orderId, publicCode: oldPublicCode, status: "unused", upstreamCodePayload: encrypted});
    insert("fulfillment", "fulfillment-preserve", {orderId, status: "failed", sessionPayload: encrypted,
      lookupPayload: encrypted, upstreamLookupToken: "old-upstream-token", leaseToken: "old-lease-token", message: "历史失败记录"});
    insert("ops_invoice_application", "invoice-preserve", {orderId, invoiceAmountMinor: {__bigint: "13500"}, feeAmountMinor: {__bigint: "675"},
      feeRateBps: 500, status: "issued", invoiceNo: "INVOICE-KEEP-001", taxIdEncrypted: encrypted, invoiceTitle: "历史票据抬头"});
    insert("ops_invoice_fee_payment", "invoice-payment-preserve", {applicationId: "invoice-preserve", amountMinor: {__bigint: "675"},
      status: "paid", qrPayload: "alipays://old-code", providerRef: "old-invoice-payment-ref"});
    insert("ops_daily_settlement", "settlement-preserve", {status: "paid", payableMinor: {__bigint: "2300"},
      platformProfitMinor: {__bigint: "200"}, payoutReference: "KEEP-PAYOUT-EVIDENCE"});
    db.prepare("INSERT INTO request_nonces(nonce_key,expires_at) VALUES(?,?)").run("old-nonce", Date.now() + 99999);
    await backup(db, source);
  } finally { db.close(); }
  return {folder, source, output, orderId, merchantId};
}

describe("isolated preview preparation", () => {
  it("restores only a new scrubbed copy, preserves finance/audit, and creates a separate admin without channel calls", async () => {
    const f = await fixture(), before = readFileSync(f.source), env = environment(f.output);
    const fetcher = vi.fn(() => { throw new Error("network_forbidden_in_preview_test"); }); vi.stubGlobal("fetch", fetcher);
    const report = await preparePreview(f.source, f.output, env, modules), result = records(f.output), beforeRows = records(f.source);
    expect(readFileSync(f.source)).toEqual(before);
    expect(report).toMatchObject({status: "ok", sourceUnchanged: true, financialSummaryUnchanged: true, workerStarted: false,
      executionMode: "disabled", paymentProvider: "mock", fulfillmentProvider: "mock", previewAdmin: {username: "preview_admin", displayName: "隔离验收管理员"}});
    expect(report.cleanup.publicCodesReplaced).toBe(1); expect(report.cleanup.encryptedPayloadsCleared).toBeGreaterThanOrEqual(4);
    expect(fetcher).not.toHaveBeenCalled();
    for (const kind of ["ops_session", "ops_mfa_challenge", "idempotency", "api_key", "partner_app", "webhook_endpoint", "outbox",
      "webhook_delivery", "ops_worker_health", "ops_payment_settings", "ops_payment_revision", "ops_payment_check"]) {
      expect(result.filter(row => row.kind === kind), kind).toHaveLength(0);
    }
    expect(result.filter(row => row.kind === "ops_account")).toHaveLength(1);
    expect(result.find(row => row.kind === "ops_account")!.payload).toMatchObject({username: "preview_admin", displayName: "隔离验收管理员"});
    const order = result.find(row => row.id === f.orderId && row.kind === "order")!.payload;
    expect(order).toMatchObject({qrPayload: null, notifyUrl: null, fulfillmentUrl: "", metadata: {payUrl: null, accessToken: null},
      saleAmountMinor: {__bigint: "13500"}, supplyAmountMinor: {__bigint: "11000"}, paymentStatus: "paid", paymentProviderRef: "old-payment-reference"});
    const voucher = result.find(row => row.kind === "cdk_voucher")!.payload;
    expect(voucher.publicCode).toMatch(/^PREVIEW-[A-F0-9]{48}$/); expect(order.voucherCode).toBe(voucher.publicCode);
    expect(voucher.upstreamCodePayload).toMatchObject({ciphertext: null, iv: null, authTag: null, keyVersion: "preview-cleared"});
    expect(result.find(row => row.kind === "fulfillment")!.payload).toMatchObject({status: "failed", message: "历史失败记录",
      upstreamLookupToken: null, leaseToken: null, sessionPayload: {ciphertext: null}, lookupPayload: {ciphertext: null}});
    for (const id of ["refund-preserve", "wallet-preserve", "settlement-preserve", "audit-preserve"]) {
      expect(result.find(row => row.id === id)).toEqual(beforeRows.find(row => row.id === id));
    }
    expect(result.find(row => row.id === "invoice-preserve")!.payload).toMatchObject({invoiceNo: "INVOICE-KEEP-001",
      invoiceAmountMinor: {__bigint: "13500"}, feeAmountMinor: {__bigint: "675"}, status: "issued", taxIdEncrypted: {ciphertext: null}});
    const supplier = result.find(row => row.kind === "supplier_connection")!.payload;
    expect(supplier.enabled).toBe(false); expect(supplier.openApiBase).toBe("https://supplier.invalid/openapi/v1");
    const cipher = new SensitivePayloadCipher(Buffer.from(env.DATA_ENCRYPTION_KEY!, "base64"), "preview-key");
    expect(cipher.decrypt(supplier.secretPayload, "supplier-connection:supplier_primary"))
      .toEqual({apiKey: null, webhookSecret: null, directPaymentResourceId: null});
    const serialized = JSON.stringify(report) + JSON.stringify(result);
    for (const secret of [oldPublicCode, "old-session-access-token", "old-ciphertext-fixture", "old-plaintext-secret", "real.invalid", "qr.alipay.com",
      env.PREVIEW_ADMIN_PASSWORD!, env.DATA_ENCRYPTION_KEY!, env.PORTAL_TOKEN_SECRET!]) expect(serialized).not.toContain(secret);
    expect(readFileSync(f.output).includes(Buffer.from("old-ciphertext-fixture"))).toBe(false);
    expect(readdirSync(f.folder).filter(name => name.startsWith(".isolated-preview-"))).toEqual([]);
  });

  it("rejects source/output identity before any writes and keeps all source bytes", async () => {
    const f = await fixture(), before = readFileSync(f.source);
    await expect(preparePreview(f.source, f.source, environment(f.source), modules)).rejects.toThrow("preview_source_output_conflict");
    expect(readFileSync(f.source)).toEqual(before); expect(existsSync(f.output)).toBe(false);
  });

  it("accepts a self-contained WAL-header backup without opening or creating sidecars beside the original", async () => {
    const f = await fixture(), sourceDb = new DatabaseSync(f.source);
    sourceDb.exec("PRAGMA journal_mode=WAL;"); sourceDb.close();
    const before = readFileSync(f.source), filesBefore = readdirSync(f.folder).sort();
    expect(before[18]).toBe(2); expect(before[19]).toBe(2);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(f.source + suffix)).toBe(false);
    const report = await preparePreview(f.source, f.output, environment(f.output), modules);
    expect(report).toMatchObject({sourceUnchanged: true, financialSummaryUnchanged: true});
    expect(readFileSync(f.source)).toEqual(before);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(f.source + suffix)).toBe(false);
    expect(readdirSync(f.folder).sort()).toEqual([...filesBefore, "preview.sqlite"].sort());
  });

  it.each(["", "-wal", "-shm", "-journal"])("refuses an existing output or sidecar %s without changing either file", async suffix => {
    const f = await fixture(), before = readFileSync(f.source); writeFileSync(f.output + suffix, "existing-do-not-overwrite");
    await expect(preparePreview(f.source, f.output, environment(f.output), modules)).rejects.toThrow("preview_output_exists");
    expect(readFileSync(f.source)).toEqual(before); expect(readFileSync(f.output + suffix, "utf8")).toBe("existing-do-not-overwrite");
  });

  it("rejects a symlink/junction output ancestor and leaves the target empty", async () => {
    const f = await fixture(), actual = join(f.folder, "actual"), linked = join(f.folder, "linked");
    mkdirSync(actual); symlinkSync(actual, linked, process.platform === "win32" ? "junction" : "dir");
    const output = join(linked, "preview.sqlite"), before = readFileSync(f.source);
    await expect(preparePreview(f.source, output, environment(output), modules)).rejects.toThrow("preview_symlink_forbidden");
    expect(readdirSync(actual)).toEqual([]); expect(readFileSync(f.source)).toEqual(before);
  });

  it("rejects a source requiring live WAL recovery rather than treating it as an online backup", async () => {
    const f = await fixture(), before = readFileSync(f.source); writeFileSync(f.source + "-wal", "uncheckpointed-wal");
    await expect(preparePreview(f.source, f.output, environment(f.output), modules)).rejects.toThrow("preview_self_contained_backup_required");
    expect(readFileSync(f.source)).toEqual(before); expect(existsSync(f.output)).toBe(false);
  });

  it.each([
    {ISOLATED_PREVIEW: "false"}, {EXECUTION_MODE: "production"}, {PAYMENT_PROVIDER: "managed"}, {FULFILLMENT_PROVIDER: "zovocard"},
    {ENABLE_SANDBOX_ROUTES: "true"}, {STORAGE_DRIVER: "memory"}, {DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64")},
    {PORTAL_TOKEN_SECRET: "replace-public-portal-secret-32-chars"}, {PREVIEW_ADMIN_PASSWORD: ""},
  ])("rejects unsafe environment before reading data: %j", async invalid => {
    const folder = mkdtempSync(join(tmpdir(), "quefa-preview-guard-")); folders.push(folder);
    const output = join(folder, "preview.sqlite");
    await expect(preparePreview(join(folder, "does-not-exist.sqlite"), output, {...environment(output), ...invalid}, modules)).rejects.toThrow(/^preview_/);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("does not publish a copy when startup changes a historical financial amount", async () => {
    const f = await fixture(), before = readFileSync(f.source);
    const changingModules = {loadConfig, createRuntime: (config: ReturnType<typeof loadConfig>) => {
      const runtime = createRuntime(config), order = runtime.repository.findOrderInternal(f.orderId)!;
      runtime.repository.updateOrder({...order, saleAmountMinor: order.saleAmountMinor + 1n}); return runtime;
    }};
    await expect(preparePreview(f.source, f.output, environment(f.output), changingModules)).rejects.toThrow("preview_financial_summary_changed");
    expect(existsSync(f.output)).toBe(false); expect(readFileSync(f.source)).toEqual(before);
    expect(readdirSync(f.folder).filter(name => name.startsWith(".isolated-preview-"))).toEqual([]);
  });

  it("CLI refuses missing isolation and prints neither password nor environment keys", () => {
    const output = resolve("preview.sqlite"), env: NodeJS.ProcessEnv = {...process.env, ...environment(output), ISOLATED_PREVIEW: "false"};
    const cli = spawnSync(process.execPath, ["deploy/preview/prepare-preview.mjs", "missing-backup.sqlite", output], {env, encoding: "utf8"});
    expect(cli.status).toBe(1); expect(cli.stdout).toBe(""); expect(cli.stderr).toContain("preview_explicit_isolation_required");
    expect(cli.stderr).not.toContain(env.PREVIEW_ADMIN_PASSWORD!); expect(cli.stderr).not.toContain(env.DATA_ENCRYPTION_KEY!);
  });

  it("runs the fixed two-path CLI successfully with APP_ROOT modules and prints only a scrubbed report", async () => {
    const f = await fixture(), appRoot = join(f.folder, "app"), moduleDir = join(appRoot, "dist"); mkdirSync(moduleDir, {recursive: true});
    // The CLI exercises its normal APP_ROOT imports against current TS sources through
    // tsx, so this regression never silently tests an old pre-existing dist build.
    for (const [file, symbol] of [["bootstrap", "createRuntime"], ["config", "loadConfig"]]) {
      writeFileSync(join(moduleDir, file + ".js"), `export {${symbol}} from ${JSON.stringify(pathToFileURL(resolve("src/" + file + ".ts")).href)};\n`);
    }
    writeFileSync(join(appRoot, "package.json"), '{"type":"module"}');
    const env: NodeJS.ProcessEnv = {...process.env, ...environment(f.output), APP_ROOT: appRoot}, before = readFileSync(f.source);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "deploy/preview/prepare-preview.mjs", f.source, f.output], {env, encoding: "utf8"});
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({status: "ok", financialSummaryUnchanged: true, sourceUnchanged: true,
      previewAdmin: {username: "preview_admin"}, workerStarted: false});
    expect(readFileSync(f.source)).toEqual(before); expect(existsSync(f.output)).toBe(true);
    for (const value of [env.PREVIEW_ADMIN_PASSWORD!, env.DATA_ENCRYPTION_KEY!, env.PORTAL_TOKEN_SECRET!, oldPublicCode, f.orderId]) {
      expect(cli.stdout + cli.stderr).not.toContain(value);
    }
  });
});
