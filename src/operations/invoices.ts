import {randomUUID} from "node:crypto";
import {AppError} from "../domain/errors.js";
import {minorToMoney, moneyToMinor} from "../domain/money.js";
import {SensitivePayloadCipher} from "../infra/crypto.js";
import type {Repository} from "../infra/repository.js";
import {AuditService} from "../modules/audit-service.js";
import {isPlatform, requirePermission, requireTenantScope} from "./accounts.js";
import type {Actor, InvoiceApplication, InvoiceFeePayment} from "./model.js";
import {queryRecords} from "../infra/record-query.js";

export interface InvoiceDetailsInput {
  invoiceTitle: string;
  taxId: string;
  recipientEmail: string;
  contactName: string;
  contactPhone?: string | null | undefined;
  remark?: string | null | undefined;
}

export interface CreateInvoiceInput extends InvoiceDetailsInput {
  invoiceAmount: string;
  requestKey: string;
}

const FEE_RATE_BPS = 500n;

export class InvoiceService {
  constructor(private readonly repository: Repository, private readonly cipher: SensitivePayloadCipher,
    private readonly audit: AuditService) {}

  create(actor: Actor, orderId: string, input: CreateInvoiceInput): InvoiceApplication {
    requirePermission(actor, "invoices.write");
    if (isPlatform(actor) || !actor.merchantId) throw new AppError(403, "invoice_agent_required", "开票申请须由代理商提交");
    const details = this.normalizeDetails(input);
    const amountMinor = moneyToMinor(input.invoiceAmount);
    if (amountMinor <= 0n || amountMinor > 100_000_000n) throw new AppError(422, "invoice_amount_invalid", "开票金额须在 0.01 至 100 万元之间");
    const feeAmountMinor = (amountMinor * FEE_RATE_BPS + 9_999n) / 10_000n;
    return this.repository.transaction(() => {
      const order = this.repository.findOrder(actor.merchantId!, orderId);
      if (!order) throw new AppError(404, "order_not_found", "订单不存在");
      if(order.paymentPurpose==="payment_test")throw new AppError(409,"invoice_payment_test_denied","1 元支付联调订单不能申请开票");
      if (!["paid", "partially_refunded"].includes(order.paymentStatus)) {
        throw new AppError(409, "invoice_order_not_paid", "只有已付款且未全额退款的订单可以申请开票");
      }
      const idempotent = queryRecords(this.repository,"invoice_application",{merchantId:actor.merchantId!,
        filters:[{field:"requestKey",value:input.requestKey}],limit:1,count:false}).data[0];
      if (idempotent) {
        if (!this.matchesApplication(idempotent, orderId, amountMinor, details)) {
          throw new AppError(409, "invoice_request_conflict", "申请号已用于不同的开票资料");
        }
        return idempotent;
      }
      const existing = queryRecords(this.repository,"invoice_application",{merchantId:actor.merchantId!,
        filters:[{field:"orderId",value:orderId}],limit:1,count:false}).data[0];
      if (existing) {
        if (!this.matchesApplication(existing, orderId, amountMinor, details)) {
          throw new AppError(409, "invoice_order_conflict", "该订单已有不同资料的开票申请，请打开原申请继续处理");
        }
        return existing;
      }
      const id = "inv_" + randomUUID().replaceAll("-", "");
      const now = new Date();
      const value: InvoiceApplication = {
        id, merchantId: actor.merchantId!, orderId, requestKey: input.requestKey,
        titleType: "enterprise", invoiceTitle: details.invoiceTitle,
        taxIdEncrypted: this.cipher.encrypt(details.taxId, "invoice-tax:" + id),
        recipientEmail: details.recipientEmail, contactName: details.contactName,
        contactPhone: details.contactPhone, remark: details.remark,
        invoiceAmountMinor: amountMinor, feeRateBps: 500, feeAmountMinor,
        category: "技术服务费", status: "awaiting_payment", paymentId: null, providerRef: null,
        paidAt: null, submittedAt: null, reviewNote: null, invoiceNo: null, issuedAt: null,
        version: 0, createdBy: actor.id, createdAt: now, updatedAt: now,
      };
      this.repository.saveOperations("invoice_application", value, true);
      this.log(actor, "invoice.application.create", value.id);
      return value;
    });
  }

  list(actor: Actor, merchantId?: string): ReturnType<InvoiceService["view"]>[] {
    requirePermission(actor, "invoices.read");
    const scopedMerchant = isPlatform(actor) ? merchantId : actor.merchantId ?? undefined;
    if (merchantId) requireTenantScope(actor, merchantId);
    return this.repository.listOperations("invoice_application", scopedMerchant)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(item => this.view(actor, item));
  }

  page(actor: Actor, input: {merchantId?: string; status?: InvoiceApplication["status"] | "all"; page: number; limit: number}) {
    requirePermission(actor, "invoices.read");
    const scopedMerchant = isPlatform(actor) ? input.merchantId : actor.merchantId ?? undefined;
    if (input.merchantId) requireTenantScope(actor, input.merchantId);
    const result = queryRecords(this.repository, "invoice_application", {
      ...(scopedMerchant ? {merchantId: scopedMerchant} : {}),
      filters: input.status && input.status !== "all" ? [{field: "status", value: input.status}] : [],
      page: input.page, limit: input.limit, orderBy: "updatedAt", direction: "desc",
    });
    return {...result, data: result.data.map(item => this.view(actor, item))};
  }

  pendingPage(actor: Actor, limit = 8) {
    requirePermission(actor, "invoices.manage");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台可查看待开票队列");
    const page = queryRecords(this.repository, "invoice_application", {filters: [{field: "status", op: "in", value: ["submitted", "processing"]}],
      page: 1, limit, orderBy: "updatedAt", direction: "asc"});
    return {...page, data: page.data.map(item => this.view(actor, item))};
  }

  get(actor: Actor, id: string) {
    requirePermission(actor, "invoices.read");
    const item = this.application(id);
    requireTenantScope(actor, item.merchantId);
    return this.view(actor, item);
  }

  forOrder(actor: Actor, orderId: string) {
    const order = isPlatform(actor) ? this.repository.findOrderInternal(orderId)
      : actor.merchantId ? this.repository.findOrder(actor.merchantId, orderId) : null;
    if (!order) throw new AppError(404, "order_not_found", "订单不存在");
    requireTenantScope(actor, order.merchantId);
    const item = queryRecords(this.repository,"invoice_application",{merchantId:order.merchantId,
      filters:[{field:"orderId",value:orderId}],limit:1,count:false}).data[0];
    return item ? this.view(actor, item) : null;
  }

  revise(actor: Actor, id: string, input: InvoiceDetailsInput & {version: number}) {
    requirePermission(actor, "invoices.write");
    if (isPlatform(actor)) throw new AppError(403, "invoice_agent_required", "开票资料须由代理商修改");
    const details = this.normalizeDetails(input);
    return this.repository.transaction(() => {
      const current = this.application(id);
      requireTenantScope(actor, current.merchantId);
      if (current.status !== "needs_correction") throw new AppError(409, "invoice_not_editable", "当前开票申请不能修改");
      if (current.version !== input.version) throw new AppError(409, "invoice_changed", "开票申请已变化，请刷新后重试");
      const value: InvoiceApplication = {...current, titleType: "enterprise", invoiceTitle: details.invoiceTitle,
        taxIdEncrypted: this.cipher.encrypt(details.taxId, "invoice-tax:" + current.id),
        recipientEmail: details.recipientEmail, contactName: details.contactName, contactPhone: details.contactPhone,
        remark: details.remark, status: "submitted", reviewNote: null, submittedAt: new Date(),
        version: current.version + 1, updatedAt: new Date()};
      this.repository.saveOperations("invoice_application", value);
      this.log(actor, "invoice.application.resubmit", value.id);
      return this.view(actor, value);
    });
  }

  review(actor: Actor, id: string, input: {action: "processing" | "needs_correction" | "issued"; version: number; note?: string | undefined; invoiceNo?: string | undefined}) {
    requirePermission(actor, "invoices.manage");
    if (!isPlatform(actor)) throw new AppError(403, "permission_denied", "仅平台可处理开票申请");
    const note = input.note?.trim() || null;
    if (input.action === "needs_correction" && (!note || note.length < 2)) throw new AppError(422, "invoice_note_required", "请填写需要补充的资料");
    const invoiceNo = input.invoiceNo?.trim() || null;
    if (input.action === "issued" && (!invoiceNo || invoiceNo.length < 4)) throw new AppError(422, "invoice_number_required", "请填写发票号码");
    return this.repository.transaction(() => {
      const current = this.application(id);
      if (current.version !== input.version) throw new AppError(409, "invoice_changed", "开票申请已变化，请刷新后重试");
      if (input.action === "processing" && current.status !== "submitted") throw new AppError(409, "invoice_status_invalid", "只有已提交申请可以开始处理");
      if (input.action === "needs_correction" && !["submitted", "processing"].includes(current.status)) throw new AppError(409, "invoice_status_invalid", "当前申请不能退回补充资料");
      if (input.action === "issued" && current.status !== "processing") throw new AppError(409, "invoice_status_invalid", "请先开始处理，再登记开票完成");
      const now = new Date();
      const value: InvoiceApplication = {...current, status: input.action, reviewNote: note,
        invoiceNo: input.action === "issued" ? invoiceNo : current.invoiceNo,
        issuedAt: input.action === "issued" ? now : current.issuedAt,
        version: current.version + 1, updatedAt: now};
      this.repository.saveOperations("invoice_application", value);
      this.log(actor, "invoice.application." + input.action, value.id);
      return this.view(actor, value);
    });
  }

  markPaid(paymentId: string, providerRef: string, receivedMinor: bigint): InvoiceApplication {
    return this.repository.transaction(() => {
      const payment = this.repository.getOperations("invoice_fee_payment", paymentId);
      if (!payment) throw new AppError(404, "invoice_payment_not_found", "补差价支付单不存在");
      if (receivedMinor !== payment.amountMinor) throw new AppError(409, "invoice_payment_mismatch", "补差价支付金额不匹配");
      const duplicate = queryRecords(this.repository,"invoice_fee_payment",{filters:[{field:"providerRef",value:providerRef},
        {field:"id",op:"ne",value:payment.id}],limit:1,count:false}).data[0];
      if (duplicate) throw new AppError(409, "invoice_payment_reference_reused", "支付宝流水已绑定其他补差价支付单");
      const current = this.application(payment.applicationId);
      if (payment.status === "paid") {
        if (payment.providerRef !== providerRef) throw new AppError(409, "invoice_payment_reference_mismatch", "补差价支付单已绑定其他支付宝流水");
        return current;
      }
      if(payment.status==="closed"&&payment.closedReason!=="application_paid")
        throw new AppError(409,"invoice_payment_closed","支付宝已明确关闭该补差价支付单，不能登记到账");
      const now = new Date();
      const paid: InvoiceFeePayment = {...payment, status: "paid", providerRef, paidAt: now, updatedAt: now};
      if (current.paidAt && current.paymentId) {
        if (current.paymentId === payment.id) {
          if (current.providerRef !== providerRef) throw new AppError(409,"invoice_payment_reference_mismatch","开票申请已绑定其他支付宝流水");
          this.repository.saveOperations("invoice_fee_payment", paid);
          return current;
        }
        const canonical = this.repository.getOperations("invoice_fee_payment", current.paymentId);
        if (!canonical || canonical.status !== "paid" || !current.providerRef) {
          throw new AppError(409,"invoice_payment_binding_invalid","开票申请首笔付款关联异常，须人工核对");
        }
        this.repository.saveOperations("invoice_fee_payment", paid);
        const reviewId = `invoice-payment-reconciliation:${current.id}:${payment.id}`;
        const review = this.repository.getOperations("invoice_payment_reconciliation", reviewId);
        if (!review) {
          this.repository.saveOperations("invoice_payment_reconciliation", {id: reviewId, merchantId: current.merchantId,
            applicationId: current.id, canonicalPaymentId: canonical.id, duplicatePaymentId: payment.id,
            canonicalProviderRef: current.providerRef, duplicateProviderRef: providerRef, amountMinor: payment.amountMinor,
            reason: "duplicate_collection", status: "reviewing", version: 1, detectedAt: now, updatedAt: now,
            resolvedAt: null}, true);
          this.audit.record({merchantId: current.merchantId, actorId: "payment:alipay", actorType: "system",
            action: "invoice.fee.duplicate_collected", targetType: "invoice_payment_reconciliation", targetId: reviewId,
            requestId: providerRef});
        }
        return current;
      }
      const submitted: InvoiceApplication = {...current, status: current.status === "awaiting_payment" ? "submitted" : current.status,
        paymentId: payment.id, providerRef, paidAt: now, submittedAt: current.submittedAt ?? now,
        version: current.version + (current.status === "awaiting_payment" ? 1 : 0), updatedAt: now};
      this.repository.saveOperations("invoice_fee_payment", paid);
      for (const sibling of queryRecords(this.repository,"invoice_fee_payment",{merchantId:current.merchantId,
        filters:[{field:"applicationId",value:current.id},{field:"status",value:"pending"},{field:"id",op:"ne",value:payment.id}],
        limit:500,count:false}).data) {
        this.repository.saveOperations("invoice_fee_payment", {...sibling, status:"closed", closedReason:"application_paid",
          nextCheckAt:null, precreateLeaseToken:null, precreateLeaseUntil:null, updatedAt:now});
      }
      this.repository.saveOperations("invoice_application", submitted);
      this.audit.record({merchantId: current.merchantId, actorId: "payment:alipay", actorType: "system",
        action: "invoice.fee.paid", targetType: "invoice_application", targetId: current.id, requestId: providerRef});
      return submitted;
    });
  }

  attachPayment(applicationId: string, paymentId: string): InvoiceApplication {
    return this.repository.transaction(() => {
      const current = this.application(applicationId);
      if (current.status !== "awaiting_payment") return current;
      const value = {...current, paymentId, version: current.version + 1, updatedAt: new Date()};
      this.repository.saveOperations("invoice_application", value);
      return value;
    });
  }

  application(id: string): InvoiceApplication {
    const value = this.repository.getOperations("invoice_application", id);
    if (!value) throw new AppError(404, "invoice_not_found", "开票申请不存在");
    return value;
  }

  private view(actor: Actor, item: InvoiceApplication) {
    requireTenantScope(actor, item.merchantId);
    const merchant = this.repository.findMerchantById(item.merchantId);
    let taxId: string | null = null;
    if (item.taxIdEncrypted) {
      try { taxId = String(this.cipher.decrypt(item.taxIdEncrypted, "invoice-tax:" + item.id)); } catch { taxId = null; }
    }
    return {...item, taxIdEncrypted: undefined, taxId, merchantName: merchant?.name ?? "",
      invoiceAmount: minorToMoney(item.invoiceAmountMinor), feeAmount: minorToMoney(item.feeAmountMinor)};
  }

  private normalizeDetails(input: InvoiceDetailsInput) {
    const invoiceTitle = input.invoiceTitle.trim();
    const taxId = input.taxId.trim().toUpperCase();
    const recipientEmail = input.recipientEmail.trim().toLowerCase();
    const contactName = input.contactName.trim();
    const contactPhone = input.contactPhone?.trim() || null;
    const remark = input.remark?.trim() || null;
    if (invoiceTitle.length < 2 || invoiceTitle.length > 120) throw new AppError(422, "invoice_title_invalid", "发票抬头须为 2 至 120 个字符");
    if (!/^[0-9A-Z]{15,20}$/.test(taxId)) throw new AppError(422, "invoice_tax_id_invalid", "税号须为 15 至 20 位数字或大写字母");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254) throw new AppError(422, "invoice_email_invalid", "请填写有效的收票邮箱");
    if (contactName.length < 2 || contactName.length > 80) throw new AppError(422, "invoice_contact_invalid", "联系人须为 2 至 80 个字符");
    if (contactPhone && !/^[0-9+() -]{6,30}$/.test(contactPhone)) throw new AppError(422, "invoice_phone_invalid", "联系电话格式无效");
    if (remark && remark.length > 500) throw new AppError(422, "invoice_remark_invalid", "备注不能超过 500 个字符");
    return {invoiceTitle, taxId, recipientEmail, contactName, contactPhone, remark};
  }

  private matchesApplication(existing: InvoiceApplication, orderId: string, amountMinor: bigint,
    details: ReturnType<InvoiceService["normalizeDetails"]>): boolean {
    let existingTaxId = "";
    try { existingTaxId = String(this.cipher.decrypt(existing.taxIdEncrypted, "invoice-tax:" + existing.id)); } catch { return false; }
    return existing.orderId === orderId && existing.invoiceAmountMinor === amountMinor
      && existing.invoiceTitle === details.invoiceTitle && existingTaxId === details.taxId
      && existing.recipientEmail === details.recipientEmail && existing.contactName === details.contactName
      && existing.contactPhone === details.contactPhone && existing.remark === details.remark;
  }

  private log(actor: Actor, action: string, id: string): void {
    this.audit.record({merchantId: actor.merchantId, actorId: actor.id,
      actorType: isPlatform(actor) ? "platform_user" : "merchant_user", action,
      targetType: "invoice_application", targetId: id, requestId: randomUUID()});
  }
}
