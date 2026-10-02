import {randomUUID} from "node:crypto";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/bootstrap.js";
import type {Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";
import type {Actor} from "../src/operations/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const invoiceIdentity = {appId: "2026000000000000", sellerId: "2088000000000000"};

describe("persistent SQLite invoice flow", () => {
  const temporaryDirectories: string[] = [];
  const admin: Actor = {id: "invoice-e2e-admin", role: "platform_admin", merchantId: null};
  const taxId = "91310000MA12345678";

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
  });

  it("keeps the separate five-percent payment and manual issuance consistent across restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "quefa-invoice-e2e-"));
    temporaryDirectories.push(directory);
    const database = join(directory, "invoice.sqlite");
    const config = loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "sqlite", SQLITE_PATH: database, LOG_LEVEL: "silent"});
    let merchantId = "", orderId = "", applicationId = "", paymentId = "";

    // Phase 1: the agent requests an invoice for its customer's face value and
    // receives a separate 5% difference-payment QR code.
    {
      const runtime = createRuntime(config);
      try {
        publishTestRechargeProduct(runtime);
        const credential = runtime.repository.findCredential(config.demoPartnerId, config.demoKeyId)!;
        merchantId = credential.merchant.id;
        const owner: Actor = {id: "invoice-e2e-owner", role: "agent_owner", merchantId};
        const order = await runtime.orders.create({merchantId, partnerId: credential.merchant.partnerId,
          appId: credential.app.id, keyId: credential.key.keyId}, {merchantOrderNo: "invoice-e2e-" + randomUUID(),
          productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "1000.00", collectionMode: "platform_collect"});
        runtime.payment.markPaid(merchantId, order.id, {providerRef: "invoice-e2e-order-paid", receivedMinor: order.saleAmountMinor});
        orderId = order.id;

        const application = runtime.invoices.create(owner, orderId, {invoiceTitle: "持久化测试科技有限公司", taxId,
          recipientEmail: "invoice-e2e@example.com", contactName: "测试财务", contactPhone: "13800138000",
          invoiceAmount: "1000.00", requestKey: "invoice-e2e-application"});
        applicationId = application.id;
        expect(application).toMatchObject({status: "awaiting_payment", category: "技术服务费",
          invoiceAmountMinor: 100_000n, feeRateBps: 500, feeAmountMinor: 5_000n});

        let precreateRequest: Record<string, unknown> | null = null;
        const gateway = invoiceGateway(runtime, async (method, input) => {
          expect(method).toBe("alipay.trade.precreate");
          precreateRequest = input;
          return {code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/sqlite-invoice-e2e"};
        });
        const payment = gateway.ensurePayment(owner, application.id).payment;
        paymentId = payment.id;
        expect(await gateway.precreate(payment.id)).toBe("https://qr.alipay.com/sqlite-invoice-e2e");
        expect(precreateRequest).toMatchObject({bizContent: {out_trade_no: payment.id,
          total_amount: "50.00", subject: "订单补差价"}});
        expect(runtime.invoices.get(owner, application.id)).toMatchObject({status: "awaiting_payment",
          invoiceAmount: "1000.00", feeAmount: "50.00", taxId});
      } finally {
        runtime.close();
      }
    }
    expect(readFileSync(database).includes(Buffer.from(taxId))).toBe(false);

    // Phase 2: a verified provider notification after restart is the only event
    // that submits the application. Repeated notification remains idempotent.
    {
      const runtime = createRuntime(config);
      try {
        const owner: Actor = {id: "invoice-e2e-owner", role: "agent_owner", merchantId};
        const gateway = invoiceGateway(runtime, async () => ({code: "40004", msg: "Business Failed", sub_code: "ACQ.TRADE_NOT_EXIST"}));
        const notice = {out_trade_no: paymentId, total_amount: "50.00", trade_no: "2026100100007701",
          trade_status: "TRADE_SUCCESS", sign_type: "RSA2", sign: "verified",
          app_id: invoiceIdentity.appId, seller_id: invoiceIdentity.sellerId};
        gateway.handleNotification(notice);
        gateway.handleNotification(notice);

        expect(runtime.repository.getOperations("invoice_fee_payment", paymentId))
          .toMatchObject({status: "paid", providerRef: "2026100100007701", amountMinor: 5_000n});
        expect(runtime.invoices.get(owner, applicationId)).toMatchObject({status: "submitted", paymentId,
          providerRef: "2026100100007701", invoiceAmount: "1000.00", feeAmount: "50.00"});
        expect(() => gateway.ensurePayment(owner, applicationId)).toThrow("开票申请已提交");
        expect(runtime.repository.listOperations("invoice_fee_payment", merchantId)).toHaveLength(1);

        const foreignMerchant = runtime.repository.findMerchantByPartner("pt_demo_b")!;
        const foreign: Actor = {id: "invoice-e2e-foreign", role: "agent_owner", merchantId: foreignMerchant.id};
        expect(() => runtime.invoices.get(foreign, applicationId)).toThrow();
      } finally {
        runtime.close();
      }
    }

    // Phase 3: the sole platform administrator manually processes and records
    // the issued invoice; no automatic issuing or second reviewer is involved.
    {
      const runtime = createRuntime(config);
      try {
        const submitted = runtime.invoices.get(admin, applicationId);
        expect(submitted.taxId).toBe(taxId);
        const processing = runtime.invoices.review(admin, applicationId,
          {action: "processing", version: submitted.version, note: "资料与补差价到账已核对"});
        const issued = runtime.invoices.review(admin, applicationId,
          {action: "issued", version: processing.version, invoiceNo: "INV-SQLITE-E2E-001", note: "电子发票已人工开具"});
        expect(issued).toMatchObject({status: "issued", invoiceNo: "INV-SQLITE-E2E-001"});
      } finally {
        runtime.close();
      }
    }

    // Phase 4: the agent-visible terminal state, fee payment and audit trail all
    // survive another restart, while the encrypted tax number stays off disk.
    {
      const runtime = createRuntime(config);
      try {
        const owner: Actor = {id: "invoice-e2e-owner", role: "agent_owner", merchantId};
        expect(runtime.invoices.get(owner, applicationId)).toMatchObject({orderId, status: "issued",
          invoiceNo: "INV-SQLITE-E2E-001", invoiceAmount: "1000.00", feeAmount: "50.00", taxId});
        expect(runtime.repository.getOperations("invoice_fee_payment", paymentId))
          .toMatchObject({status: "paid", amountMinor: 5_000n, providerRef: "2026100100007701"});
        const actions = runtime.repository.listAudit(merchantId).map(item => item.action);
        expect(actions.filter(action => action === "invoice.fee.paid")).toHaveLength(1);
        expect(actions).toEqual(expect.arrayContaining(["invoice.application.create", "invoice.application.processing",
          "invoice.application.issued"]));
      } finally {
        runtime.close();
      }
    }
    expect(readFileSync(database).includes(Buffer.from(taxId))).toBe(false);
  });
});

function invoiceGateway(runtime: Runtime, exec: (method: string, input: Record<string, unknown>) => Promise<{
  code: string; msg: string; qr_code?: string; sub_code?: string;
}>) {
  const client = {pageExecute: () => "", exec, checkNotifySignV2: () => true};
  return new InvoiceAlipayService(runtime.repository, runtime.paymentSettings, runtime.invoices,
    "https://pay.example.com", runtime.portalTokens, {client, identity: invoiceIdentity});
}
