import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import {InvoiceAlipayService} from "../src/modules/invoice-alipay.js";
import type {Actor} from "../src/operations/model.js";
import {publishTestRechargeProduct} from "./fixtures/recharge-catalog.js";

const admin: Actor = {id: "invoice-integrity-admin", role: "platform_admin", merchantId: null};
const identity = {appId: "2026000000000000", sellerId: "2088000000000000"};
const details = {invoiceTitle: "真实订单测试有限公司", taxId: "91310000MA12345678",
  recipientEmail: "finance@example.com", contactName: "测试财务", requestKey: "invoice-order-integrity"};

describe.each(["memory", "sqlite"] as const)("%s invoice order integrity", storage => {
  let runtime: Runtime, owner: Actor, orderId: string, directory: string | undefined;
  beforeEach(async () => {
    directory = storage === "sqlite" ? mkdtempSync(join(tmpdir(), "quefa-invoice-integrity-")) : undefined;
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: storage, LOG_LEVEL: "silent",
      ...(directory ? {SQLITE_PATH: join(directory, "invoice.sqlite")} : {})}));
    publishTestRechargeProduct(runtime);
    const credential = runtime.repository.findCredential("pt_demo_a", "key_demo_a_01")!;
    owner = {id: "invoice-integrity-owner", role: "agent_owner", merchantId: credential.merchant.id};
    const order = await runtime.orders.create({merchantId: credential.merchant.id, partnerId: credential.merchant.partnerId,
      appId: credential.app.id, keyId: credential.key.keyId}, {merchantOrderNo: "invoice-integrity-order",
      productCode: "chatgpt_plus_cdk_1m", quantity: 1, saleAmount: "135.00", collectionMode: "platform_collect"});
    runtime.payment.markPaid(order.merchantId, order.id, {providerRef: "invoice-integrity-paid", receivedMinor: 13_500n});
    orderId = order.id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    runtime.close();
    if (directory) rmSync(directory, {recursive: true, force: true});
  });

  const refundOrder = (runtime: Runtime, id: string, full = false) => {
    const order = runtime.repository.findOrderInternal(id)!;
    runtime.repository.updateOrder({...order, paymentStatus: full ? "refunded" : "partially_refunded",
      ordinaryRefundedMinor: full ? order.saleAmountMinor : 1_000n, updatedAt: new Date()});
  };
  const gateway = (exec = vi.fn(async () => ({code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/invoice-integrity"}))) =>
    new InvoiceAlipayService(runtime.repository, runtime.paymentSettings, runtime.invoices, "https://pay.example.com",
      runtime.portalTokens, {client: {pageExecute: () => "", exec, checkNotifySignV2: () => true}, identity});
  const notify = (service: InvoiceAlipayService, paymentId: string) => service.handleNotification({out_trade_no: paymentId,
    total_amount: "6.75", trade_no: "2026100200007701", trade_status: "TRADE_SUCCESS", sign_type: "RSA2",
    sign: "test", app_id: identity.appId, seller_id: identity.sellerId});

  it("derives the customer-paid face value and rejects a supplied purchase price or arbitrary amount", () => {
    expect(runtime.invoices.canApplyToOrder(runtime.repository.findOrderInternal(orderId)!)).toBe(true);
    for (const invoiceAmount of ["110.00", "1000.00"]) {
      expect(() => runtime.invoices.create(owner, orderId, {...details, invoiceAmount}))
        .toThrow("发票金额必须与关联订单已确认的客户实付金额一致");
    }
    expect(runtime.repository.listOperations("invoice_application", owner.merchantId!)).toHaveLength(0);
    const application = runtime.invoices.create(owner, orderId, details);
    expect(application).toMatchObject({invoiceAmountMinor: 13_500n, feeAmountMinor: 675n});
    expect(runtime.invoices.get(owner, application.id)).toMatchObject({requiresReview: false,
      expectedInvoiceAmount: "135.00", invoiceAmount: "135.00", feeAmount: "6.75"});
    expect(runtime.invoices.create(owner, orderId, {...details, invoiceAmount: "135.00"}).id).toBe(application.id);
  });

  it("requires matching confirmed order and channel payment rather than a paid status alone", () => {
    const payment = runtime.repository.findPaymentAttemptByOrder(owner.merchantId!, orderId)!;
    runtime.repository.updatePaymentAttempt({...payment, receivedMinor: 11_000n});
    expect(() => runtime.invoices.create(owner, orderId, details)).toThrow("开票申请待核对");
    expect(runtime.repository.listOperations("invoice_application", owner.merchantId!)).toHaveLength(0);
  });

  it("does not treat self-collected purchase payment as proof of customer payment", () => {
    const order = runtime.repository.findOrderInternal(orderId)!;
    runtime.repository.updateOrder({...order, collectionMode: "agent_collect"});
    expect(runtime.invoices.canApplyToOrder(runtime.repository.findOrderInternal(orderId)!)).toBe(false);
    expect(() => runtime.invoices.create(owner, orderId, details)).toThrow("客户实付未经平台确认");
  });

  it("rejects a new application after a partial refund instead of silently invoicing the original amount", () => {
    refundOrder(runtime, orderId);
    expect(runtime.invoices.canApplyToOrder(runtime.repository.findOrderInternal(orderId)!)).toBe(false);
    expect(() => runtime.invoices.create(owner, orderId, details)).toThrow("关联订单已发生退款");
    expect(runtime.repository.listOperations("invoice_application", owner.merchantId!)).toHaveLength(0);
  });

  it("preserves historical mismatched face value and blocks collection until it is reviewed", async () => {
    const application = runtime.invoices.create(owner, orderId, details);
    runtime.repository.saveOperations("invoice_application", {...application, invoiceAmountMinor: 100_000n, feeAmountMinor: 5_000n});
    const original = runtime.repository.getOperations("invoice_application", application.id);
    expect(runtime.invoices.get(owner, application.id)).toMatchObject({status: "awaiting_payment", requiresReview: true,
      reviewReasonCodes: ["invoice_amount_mismatch"], invoiceAmount: "1000.00", expectedInvoiceAmount: "135.00"});
    expect(() => gateway().ensurePayment(owner, application.id)).toThrow("历史申请票面金额");
    expect(runtime.repository.getOperations("invoice_application", application.id)).toEqual(original);
    expect(runtime.repository.listOperations("invoice_fee_payment", owner.merchantId!)).toHaveLength(0);
  });

  it("flags a historical fee inconsistent with the invoice without recalculating the stored payment", () => {
    const application = runtime.invoices.create(owner, orderId, details);
    runtime.repository.saveOperations("invoice_application", {...application, feeAmountMinor: 500n});
    expect(runtime.invoices.get(owner, application.id)).toMatchObject({requiresReview: true,
      reviewReasonCodes: ["invoice_fee_mismatch"], invoiceAmount: "135.00", feeAmount: "5.00"});
    expect(() => gateway().ensurePayment(owner, application.id)).toThrow("历史补差金额");
  });

  it("blocks collection and issuance while a failed refund remains retryable", () => {
    const application = runtime.invoices.create(owner, orderId, details), service = gateway();
    const {payment} = service.ensurePayment(owner, application.id);
    runtime.repository.insertRefund({id: "refund-invoice-pending", merchantId: owner.merchantId!, orderId,
      merchantRefundNo: "refund-invoice-pending", type: "partial", amountMinor: 100n, status: "failed",
      reason: "等待核查", failureCode: "legacy_failure", createdAt: new Date(), refundedAt: null});
    expect(() => service.ensurePayment(owner, application.id)).toThrow("待处理或可重试的退款");
    notify(service, payment.id);
    const submitted = runtime.invoices.get(admin, application.id);
    expect(submitted.reviewReasonCodes).toContain("invoice_order_refund_pending");
    expect(() => runtime.invoices.review(admin, application.id, {action: "processing", version: submitted.version}))
      .toThrow("待处理或可重试的退款");
  });

  it("blocks an existing payment code after refund but records a verified late payment as review-required", async () => {
    const application = runtime.invoices.create(owner, orderId, details), service = gateway();
    const {payment} = service.ensurePayment(owner, application.id);
    await service.precreate(payment.id);
    refundOrder(runtime, orderId);
    expect(() => service.ensurePayment(owner, application.id)).toThrow("开票申请待核对");
    await expect(service.precreate(payment.id)).rejects.toMatchObject({code: "invoice_review_required"});
    notify(service, payment.id);
    notify(service, payment.id);
    const current = runtime.invoices.get(admin, application.id);
    expect(current).toMatchObject({status: "submitted", requiresReview: true, paymentId: payment.id,
      feeAmount: "6.75", providerRef: "2026100200007701"});
    expect(current.reviewReasonCodes).toContain("invoice_order_refunded");
    expect(runtime.repository.getOperations("invoice_fee_payment", payment.id)).toMatchObject({status: "paid", amountMinor: 675n});
    expect(() => runtime.invoices.review(admin, application.id, {action: "processing", version: current.version})).toThrow("开票申请待核对");
    expect(runtime.repository.listRefundsForOrder(owner.merchantId!, orderId)).toHaveLength(0);
    expect(runtime.repository.listAudit(owner.merchantId!).filter(row => row.action === "invoice.fee.paid")).toHaveLength(1);
  });

  it("preserves a QR generated during a refund race without returning a payable code", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const exec = vi.fn(async () => { await wait; return {code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/invoice-race"}; });
    const application = runtime.invoices.create(owner, orderId, details), service = gateway(exec);
    const {payment} = service.ensurePayment(owner, application.id), pending = service.precreate(payment.id);
    await Promise.resolve();
    refundOrder(runtime, orderId, true);
    release();
    await expect(pending).rejects.toMatchObject({code: "invoice_review_required"});
    expect(runtime.repository.getOperations("invoice_fee_payment", payment.id)).toMatchObject({status: "pending",
      qrPayload: "https://qr.alipay.com/invoice-race", precreateLeaseToken: null});
    notify(service, payment.id);
    expect(runtime.invoices.get(admin, application.id)).toMatchObject({requiresReview: true, status: "submitted", paidAt: expect.any(Date)});
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rechecks refund facts in the same transaction that records manual invoice issuance", () => {
    const application = runtime.invoices.create(owner, orderId, details), service = gateway();
    const {payment} = service.ensurePayment(owner, application.id);
    notify(service, payment.id);
    const submitted = runtime.invoices.get(admin, application.id);
    const processing = runtime.invoices.review(admin, application.id, {action: "processing", version: submitted.version});
    const transaction = runtime.repository.transaction.bind(runtime.repository);
    vi.spyOn(runtime.repository, "transaction").mockImplementationOnce(action => {
      refundOrder(runtime, orderId, true);
      return transaction(action);
    });
    expect(() => runtime.invoices.review(admin, application.id, {action: "issued", version: processing.version,
      invoiceNo: "INV-RACE-0001"})).toThrow("开票申请待核对");
    expect(runtime.invoices.get(admin, application.id)).toMatchObject({status: "processing", requiresReview: true, invoiceNo: null});
  });

  it("flags an already issued invoice after refund without deleting the number or payment", () => {
    const application = runtime.invoices.create(owner, orderId, details), service = gateway();
    const {payment} = service.ensurePayment(owner, application.id);
    notify(service, payment.id);
    const submitted = runtime.invoices.get(admin, application.id);
    const processing = runtime.invoices.review(admin, application.id, {action: "processing", version: submitted.version});
    runtime.invoices.review(admin, application.id, {action: "issued", version: processing.version, invoiceNo: "INV-DONE-0001"});
    refundOrder(runtime, orderId);
    expect(runtime.invoices.get(owner, application.id)).toMatchObject({status: "issued", requiresReview: true,
      invoiceNo: "INV-DONE-0001", paymentId: payment.id, providerRef: "2026100200007701"});
  });
});
