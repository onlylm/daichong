import { randomUUID } from "node:crypto";
import type { DeliveryMode, Order, TenantContext } from "../domain/model.js";
import type { Repository } from "../infra/repository.js";
import { AppError, notFound } from "../domain/errors.js";
import { merchantMargin, moneyToMinor } from "../domain/money.js";
import { CatalogService } from "./catalog-service.js";
import type { PaymentProvider, PaymentCreation } from "./payment-service.js";
import type {PaymentChannel} from "../operations/model.js";
import { PortalTokenService } from "./portal-token.js";
import {LiveTestPolicy} from "./live-test-policy.js";
import type {WalletService} from "../operations/wallet.js";
import {effectiveCollectionModes} from "../operations/agents.js";

export class OrderService {
  constructor(
    private readonly repository: Repository,
    private readonly catalog: CatalogService,
    private readonly payment: PaymentProvider,
    private readonly publicBaseUrl: string,
    private readonly portalTokens: PortalTokenService,
    private readonly livePolicy?: LiveTestPolicy,
    private readonly wallets?: WalletService,
  ) {}

  async create(tenant: TenantContext, input: {merchantOrderNo: string; productCode: string; quantity: number; saleAmount: string; collectionMode?: "platform_collect" | "agent_collect"; deliveryMode?: DeliveryMode | undefined; paymentChannel?: PaymentChannel | undefined; notifyUrl?: string | undefined; metadata?: Record<string, string | number | boolean | null>}): Promise<Order> {
    const collectionMode = input.collectionMode ?? "platform_collect";
    if (input.paymentChannel && (collectionMode === "agent_collect" || (this.payment.name !== "managed" && this.payment.name !== input.paymentChannel))) {
      throw new AppError(422, "payment_channel_unavailable", "此订单不可使用所选支付通道");
    }
    const existing = this.repository.findOrderByMerchantNo(tenant.merchantId, input.merchantOrderNo);
    if (existing) {
      const requestedDelivery = input.deliveryMode ?? (existing.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
      const same = existing.productCode === input.productCode && existing.quantity === input.quantity && existing.saleAmountMinor === moneyToMinor(input.saleAmount) && (existing.collectionMode ?? "platform_collect") === collectionMode
        && deliveryMode(existing) === requestedDelivery && (existing.notifyUrl ?? null) === (input.notifyUrl ?? null);
      if (!same || (input.paymentChannel && this.repository.findPaymentAttemptByOrder(tenant.merchantId, existing.id)?.provider !== input.paymentChannel)) throw new AppError(409, "merchant_order_conflict", "代理商订单号已用于不同请求");
      return existing;
    }
    const grant = this.catalog.requireGrant(tenant.merchantId, input.productCode);
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > grant.maxQuantity) {
      throw new AppError(422, "invalid_quantity", "商品数量超出允许范围");
    }
    const saleAmountMinor = moneyToMinor(input.saleAmount);
    const supplyAmountMinor = grant.supplyPriceMinor * BigInt(input.quantity);
    if (saleAmountMinor < supplyAmountMinor) {
      throw new AppError(422, "price_out_of_range", "销售金额不能低于代理供货价");
    }
    const now = new Date();
    const costEntry = this.repository.getOperations("global_product_catalog", "default")?.products.find(p => p.productCode === grant.productCode);
    const mapping = this.repository.findSupplierProductMapping(grant.productCode);
    const quote = mapping ? this.repository.listSupplierPlanSnapshots(mapping.connectionId).find(p => p.plan === mapping.supplierPlan && p.product === "gpt") : null;
    const requestedDelivery = grant.fulfillmentMode === "cdk" ? input.deliveryMode ?? "cdk" : "auto_recharge";
    const id = this.repository.transaction(() => this.repository.allocatePublicOrderNo());
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const payment: Omit<PaymentCreation, "qrPayload"> & {qrPayload: string | null} = collectionMode === "agent_collect" ? {providerRef: "wallet:" + id, qrPayload: null, expiresAt}
      : await this.payment.create(id, saleAmountMinor, expiresAt, input.paymentChannel);
    const order: Order = {
      id, merchantId: tenant.merchantId, appId: tenant.appId, merchantOrderNo: input.merchantOrderNo, collectionMode,
      deliveryMode: requestedDelivery, fallbackRechargeAvailable: false,
      productCode: input.productCode, quantity: input.quantity, saleAmountMinor, supplyAmountMinor,
      ordinaryRefundedMinor: 0n, priceAdjustmentRefundedMinor: 0n, currency: "CNY",
      costTerms: {standardUsdMinor: costEntry?.refundBenchmarkUsdMinor ?? null,
        refundBenchmarkUsdMinor: costEntry?.refundBenchmarkUsdMinor ?? null,
        standardCnyMinor: costEntry?.standardCostCnyMinor ?? null, retainedUsdMinor: costEntry?.retainedFeeUsdMinor ?? 15n,
        productVersion: costEntry?.priceVersion ?? grant.priceVersion, quoteCurrency: quote?.checkoutCurrency ?? null,
        quoteAmountMinor: quote?.checkoutAmountMinor ?? null, quoteVersion: quote?.pricingVersion ?? null,
        quoteAt: quote?.syncedAt?.toISOString() ?? null, serviceFeeUsdMinor: quote?.serviceFeeUsdMinor ?? null,
        standardSource: costEntry?.refundBenchmarkUsdMinor != null ? "operator_verified_baseline" : null,
        standardAt: costEntry?.refundBenchmarkAt ?? null},
      metadata: input.metadata ?? {}, notifyUrl: input.notifyUrl ?? null,
      paymentStatus: "pending", paymentProviderRef: payment.providerRef, paymentReceivedMinor: null, paymentFeeMinor: null,
      qrPayload: payment.qrPayload, qrImageUrl: null,
      fulfillmentMode: grant.fulfillmentMode,
      upstreamProduct: grant.upstreamProduct,
      upstreamPlan: grant.upstreamPlan,
      fulfillmentUrl: this.portalTokens.url(id),
      voucherCode: null,
      settlementId: null,
      paidAt: null, expiresAt: payment.expiresAt, createdAt: now, updatedAt: now,
    };
    return this.repository.transaction(() => {
    const concurrent = this.repository.findOrderByMerchantNo(tenant.merchantId, input.merchantOrderNo);
    if (concurrent) {
      if (input.paymentChannel && this.repository.findPaymentAttemptByOrder(tenant.merchantId, concurrent.id)?.provider !== input.paymentChannel) throw new AppError(409, "merchant_order_conflict", "代理商订单号已用于不同支付通道");
      if (concurrent.productCode !== input.productCode || concurrent.quantity !== input.quantity || concurrent.saleAmountMinor !== saleAmountMinor || (concurrent.collectionMode ?? "platform_collect") !== collectionMode
          || deliveryMode(concurrent) !== requestedDelivery || (concurrent.notifyUrl ?? null) !== (input.notifyUrl ?? null)) {
        throw new AppError(409, "merchant_order_conflict", "代理商订单号已用于不同请求");
      }
      return concurrent;
    }
    // Configuration may have changed while creating the payment attempt.
    const currentGrant = this.catalog.requireGrant(tenant.merchantId, input.productCode);
    const currentCostEntry = this.repository.getOperations("global_product_catalog", "default")?.products.find(p => p.productCode === currentGrant.productCode);
    if ((currentCostEntry?.priceVersion ?? null) !== (costEntry?.priceVersion ?? null)) {
      throw new AppError(409, "product_terms_changed", "商品核算口径已更新，请重新读取商品后下单");
    }
    if (currentGrant.supplyPriceMinor !== grant.supplyPriceMinor
        || currentGrant.upstreamPlan !== grant.upstreamPlan || currentGrant.upstreamProduct !== grant.upstreamProduct
        || currentGrant.fulfillmentMode !== grant.fulfillmentMode || currentGrant.maxQuantity < input.quantity) {
      throw new AppError(409, "product_terms_changed", "商品价格或履约配置已更新，请重新读取商品后下单");
    }
    const profile = this.repository.getOperations("agent_profile", tenant.merchantId);
    const configured = profile?.collectionModes ?? ["platform_collect"];
    const modes = effectiveCollectionModes(this.repository, tenant.merchantId, profile ?? undefined);
    if (!modes.includes(collectionMode)) {
      if (collectionMode === "agent_collect" && configured.includes("agent_collect")) {
        throw new AppError(403, "collection_mode_denied", "采购余额不足，请先充值后再使用余额支付");
      }
      throw new AppError(403, "collection_mode_denied", "代理商未获此销售模式授权");
    }
    order.liveTest = this.livePolicy?.assertNewOrder(tenant, saleAmountMinor) ?? false;
    if (collectionMode !== "agent_collect") this.payment.validateCreation?.(payment as PaymentCreation);
    this.repository.insertOrder(order);
    const paymentNow = new Date();
    this.repository.insertPaymentAttempt({
      id: `pay_${randomUUID().replaceAll("-", "")}`,
      merchantId: tenant.merchantId,
      orderId: id,
      provider: collectionMode === "agent_collect" ? "agent_wallet" : payment.channel ?? this.payment.name,
      ...(payment.paymentConfigId ? {paymentConfigId: payment.paymentConfigId} : {}),
      status: "pending",
      providerRef: payment.providerRef,
      requestedMinor: saleAmountMinor,
      receivedMinor: null,
      feeMinor: null,
      qrPayload: payment.qrPayload,
      expiresAt: payment.expiresAt,
      paidAt: null,
      createdAt: paymentNow,
      updatedAt: paymentNow,
    });
    if (collectionMode === "agent_collect") {
      if (!this.wallets) throw new AppError(503, "wallet_unavailable", "采购钱包未配置");
      return this.wallets.purchase(order);
    }
    return order;
    });
  }

  get(merchantId: string, orderId: string): Order {
    const order = this.repository.findOrder(merchantId, orderId);
    if (!order) throw notFound("order");
    return order;
  }

  margin(order: Order): bigint {
    return order.collectionMode === "agent_collect" ? 0n : merchantMargin(order);
  }
}

function deliveryMode(order: Order): DeliveryMode {
  return order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
}
