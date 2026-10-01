import type {FulfillmentMode, ProductGrant, SupplierPlanSnapshot} from "../domain/model.js";
import {UNBOUNDED_MAX_SALE_PRICE_MINOR} from "../domain/money.js";

export interface ManagedGptProduct {
  productCode: string;
  name: string;
  fulfillmentMode: FulfillmentMode;
  upstreamPlan: string;
  /** Previous direct product whose commercial terms should be carried over
   * once when this CDK-backed replacement is first introduced. */
  legacyProductCode?: string;
  /** Platform cost floor; tier pricing must not go below this. */
  costPriceMinor: bigint;
  supplyPriceMinor: bigint;
  /** Operator-confirmed USD basis for difference refunds, never an actual cost. */
  refundBenchmarkUsdMinor: bigint;
  maxSalePriceMinor: bigint;
  matchPlan: (plan: SupplierPlanSnapshot) => boolean;
}

const text = (plan: SupplierPlanSnapshot) => `${plan.plan} ${plan.accPlanKey} ${plan.name}`.toLowerCase();
const hasNumber = (value: string, amount: number) => new RegExp(`(^|\\D)${amount}(\\D|$)`).test(value);
const isRenewal = (value: string) => /renew|续费/.test(value);

/**
 * The only products Quefa publishes. Supplier plan keys are suggestions only;
 * after a GPT catalogue sync, disabled mappings are reconciled to the actual
 * upstream key by matchPlan.
 */
/** Subscription GPT products sold via platform-issued CDK and agent redemption pages. */
export const managedGptProducts: readonly ManagedGptProduct[] = [
  {
    productCode: "chatgpt_plus_cdk_1m", name: "ChatGPT Plus 一个月·CDK 兑换", fulfillmentMode: "cdk", upstreamPlan: "plus",
    legacyProductCode: "chatgpt_plus_1m",
    costPriceMinor: 10_800n, supplyPriceMinor: 11_000n, refundBenchmarkUsdMinor: 1_576n, maxSalePriceMinor: 15_900n, matchPlan: plan => /(^|\W)plus(\W|$)/.test(text(plan)),
  },
  {
    productCode: "chatgpt_pro_5x_cdk_1m", name: "ChatGPT Pro 5x 一个月·CDK 兑换", fulfillmentMode: "cdk", upstreamPlan: "pro_5x",
    legacyProductCode: "chatgpt_pro_5x_1m",
    costPriceMinor: 63_000n, supplyPriceMinor: 63_800n, refundBenchmarkUsdMinor: 9_298n, maxSalePriceMinor: 79_900n, matchPlan: plan => /pro/.test(text(plan)) && hasNumber(text(plan), 5) && !isRenewal(text(plan)),
  },
  {
    productCode: "chatgpt_pro_20x_cdk_1m", name: "ChatGPT Pro 20x 一个月·CDK 兑换", fulfillmentMode: "cdk", upstreamPlan: "pro_20x",
    legacyProductCode: "chatgpt_pro_20x_1m",
    costPriceMinor: 96_100n, supplyPriceMinor: 100_000n, refundBenchmarkUsdMinor: 14_312n, maxSalePriceMinor: 129_900n, matchPlan: plan => /pro/.test(text(plan)) && hasNumber(text(plan), 20) && !isRenewal(text(plan)),
  },
  {
    productCode: "chatgpt_pro_50x_cdk_1m", name: "ChatGPT Pro 50x 一个月·菲律宾 CDK", fulfillmentMode: "cdk", upstreamPlan: "pro_50x",
    // PH/PHP is fixed by the current CDK issuer. Never infer a selling price from an upstream reference quote.
    costPriceMinor: 312_000n, supplyPriceMinor: 320_000n, refundBenchmarkUsdMinor: 46_544n, maxSalePriceMinor: 0n,
    matchPlan: plan => plan.product === "gpt" && plan.plan === "pro_50x" && plan.accPlanKey === "pro_50x",
  },
];

export function managedGptProduct(productCode: string): ManagedGptProduct | null {
  return managedGptProducts.find(item => item.productCode === productCode) ?? null;
}

export function newProductGrant(merchantId: string, product: ManagedGptProduct, available = false): ProductGrant {
  return {
    merchantId,
    productCode: product.productCode,
    name: product.name,
    supplyPriceMinor: product.supplyPriceMinor,
    maxSalePriceMinor: UNBOUNDED_MAX_SALE_PRICE_MINOR,
    currency: "CNY",
    maxQuantity: 1,
    available: available && product.supplyPriceMinor > 0n,
    priceVersion: 1,
    fulfillmentMode: product.fulfillmentMode,
    upstreamProduct: "gpt",
    upstreamPlan: product.upstreamPlan,
  };
}
