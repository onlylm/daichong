import type {Repository} from "../infra/repository.js";
import type {CollectionMode, TierLevel, TierRules} from "./model.js";
import {managedGptProduct} from "../modules/gpt-products.js";

export interface TierLevelBenefits {
  supplyDiscountBps: number;
  productSupplyPrices: Record<string, bigint>;
  maxStaffAccounts: number;
  apiIncluded: boolean;
  collectionModes: CollectionMode[];
  benefits: string[];
}

/** Standard agent supply prices and platform cost floors (CNY, minor units). */
export const tierCatalogProducts = {
  chatgpt_plus_cdk_1m: {label: "Plus", costMinor: 10_800n, standardMinor: 11_000n},
  chatgpt_pro_5x_cdk_1m: {label: "Pro 5x", costMinor: 63_000n, standardMinor: 63_800n},
  chatgpt_pro_20x_cdk_1m: {label: "Pro 20x", costMinor: 96_100n, standardMinor: 100_000n},
  chatgpt_pro_50x_cdk_1m: {label: "Pro 50x", costMinor: 312_000n, standardMinor: 320_000n},
} as const;

const price = (yuan: number) => BigInt(Math.round(yuan * 100));

/** Per-tier supply prices derived from cost/margin: standard uses list price, upper tiers rebate part of margin. */
const tierPriceTable: Record<string, Record<string, bigint>> = {
  standard: {
    chatgpt_plus_cdk_1m: price(110),
    chatgpt_pro_5x_cdk_1m: price(638),
    chatgpt_pro_20x_cdk_1m: price(1000),
    chatgpt_pro_50x_cdk_1m: price(3200),
  },
  preferred: {
    chatgpt_plus_cdk_1m: price(110),
    chatgpt_pro_5x_cdk_1m: price(638),
    chatgpt_pro_20x_cdk_1m: price(1000),
    chatgpt_pro_50x_cdk_1m: price(3200),
  },
  gold: {
    chatgpt_plus_cdk_1m: price(110),
    chatgpt_pro_5x_cdk_1m: price(638),
    chatgpt_pro_20x_cdk_1m: price(1000),
    chatgpt_pro_50x_cdk_1m: price(3200),
  },
};

function tierPricesAsStrings(tierCode: string): Record<string, string> {
  return Object.fromEntries(Object.entries(tierPriceTable[tierCode] ?? {}).map(([code, minor]) => [code, minor.toString()]));
}

function formatTierBenefitPrices(tierCode: keyof typeof tierPriceTable): string[] {
  const prices = tierPriceTable[tierCode]!;
  return [
    "Plus 采购 ¥" + (Number(prices.chatgpt_plus_cdk_1m) / 100).toFixed(0),
    "Pro 5x 采购 ¥" + (Number(prices.chatgpt_pro_5x_cdk_1m) / 100).toFixed(0),
    "Pro 20x 采购 ¥" + (Number(prices.chatgpt_pro_20x_cdk_1m) / 100).toFixed(0),
    "Pro 50x 采购 ¥" + (Number(prices.chatgpt_pro_50x_cdk_1m) / 100).toFixed(0),
  ];
}

/** Upgrade thresholds in minor units. Deposit is ~2–3% of supply threshold; self-collect share caps platform-only agents. */
const tierThresholdMinor = {
  preferred: 10_000_000n, // ¥100,000 cumulative supply
  gold: 50_000_000n, // ¥500,000 cumulative supply
} as const;
const tierDepositMinor = {
  preferred: 300_000n, // ¥3,000 procurement balance (~3% of threshold)
  gold: 1_000_000n, // ¥10,000 (~2% of threshold)
} as const;
const tierAgentCollectShareBps = {
  preferred: 1500, // ≥15% supply via agent_collect; ≤85% platform_collect
  gold: 2000, // ≥20% self-collect; ≤80% platform_collect
} as const;

function formatThresholdYuan(minor: bigint): string {
  return "¥" + (Number(minor) / 100).toLocaleString("zh-CN", {maximumFractionDigits: 0});
}

export const defaultTierLevels: TierLevel[] = [
  {code: "standard", name: "标准会员", threshold: 0n, supplyDiscountBps: 0, maxStaffAccounts: 2, apiIncluded: false,
    collectionModes: ["platform_collect", "agent_collect"], productSupplyPrices: tierPricesAsStrings("standard"),
    benefits: ["平台收款分销", "余额自收款采购（需预存采购余额）", ...formatTierBenefitPrices("standard"), "工单与公告", "最多 2 个子账号"]},
  {code: "preferred", name: "优选会员", threshold: tierThresholdMinor.preferred, supplyDiscountBps: 0, maxStaffAccounts: 5, apiIncluded: false,
    minDepositMinor: tierDepositMinor.preferred.toString(), minAgentCollectShareBps: tierAgentCollectShareBps.preferred,
    collectionModes: ["platform_collect", "agent_collect"], productSupplyPrices: tierPricesAsStrings("preferred"),
    benefits: [
      "升级门槛：累计供货 " + formatThresholdYuan(tierThresholdMinor.preferred),
      "采购余额 ≥ " + formatThresholdYuan(tierDepositMinor.preferred) + "（约 3% 预存）",
      "自收款供货占比 ≥ " + (tierAgentCollectShareBps.preferred / 100) + "%（不可全靠平台代收）",
      "余额自收款采购", ...formatTierBenefitPrices("preferred"), "优先工单响应", "最多 5 个子账号"]},
  {code: "gold", name: "金牌会员", threshold: tierThresholdMinor.gold, supplyDiscountBps: 0, maxStaffAccounts: 20, apiIncluded: true,
    minDepositMinor: tierDepositMinor.gold.toString(), minAgentCollectShareBps: tierAgentCollectShareBps.gold,
    collectionModes: ["platform_collect", "agent_collect"], productSupplyPrices: tierPricesAsStrings("gold"),
    benefits: [
      "升级门槛：累计供货 " + formatThresholdYuan(tierThresholdMinor.gold),
      "采购余额 ≥ " + formatThresholdYuan(tierDepositMinor.gold) + "（约 2% 预存）",
      "自收款供货占比 ≥ " + (tierAgentCollectShareBps.gold / 100) + "%",
      "API 接入免审核", ...formatTierBenefitPrices("gold"), "余额自收款采购", "最多 20 个子账号"]},
];

export function seedDefaultTierRules(repository: Repository): void {
  if (repository.getOperations("tier_rules", "default")) return;
  repository.saveOperations("tier_rules", {
    id: "default", merchantId: null, version: 1, metric: "supply_amount", enabled: true,
    levels: defaultTierLevels.map(level => ({...level})), updatedAt: new Date(),
  });
}

function parseProductPrices(source: Record<string, string> | undefined): Record<string, bigint> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).map(([code, minor]) => [code, BigInt(minor)]));
}

export function resolveTierBenefits(tierCode: string, rules: TierRules): TierLevelBenefits {
  const level = rules.levels.find(item => item.code === tierCode);
  const preset = defaultTierLevels.find(item => item.code === tierCode);
  const parsed = parseProductPrices(level?.productSupplyPrices ?? preset?.productSupplyPrices);
  const productSupplyPrices = Object.keys(parsed).length ? parsed : (tierPriceTable[tierCode] ?? tierPriceTable.standard!);
  return {
    supplyDiscountBps: level?.supplyDiscountBps ?? preset?.supplyDiscountBps ?? 0,
    productSupplyPrices,
    maxStaffAccounts: level?.maxStaffAccounts ?? preset?.maxStaffAccounts ?? 2,
    apiIncluded: level?.apiIncluded ?? preset?.apiIncluded ?? false,
    collectionModes: level?.collectionModes ?? preset?.collectionModes ?? ["platform_collect"],
    benefits: [...(level?.benefits ?? preset?.benefits ?? ["基础工作台权限"]).filter(text => !/(采购.*[¥￥]|会员价|提货.*[¥￥])/.test(text)), "商品统一提货价，以采购页实时价格为准"],
  };
}

export function effectiveSupplyPriceMinor(baseMinor: bigint, discountBps: number, costFloorMinor = 0n): bigint {
  if (baseMinor <= 0n || discountBps <= 0) return baseMinor;
  const discounted = baseMinor * BigInt(10_000 - discountBps) / 10_000n;
  const priceMinor = discounted > 0n ? discounted : 1n;
  return costFloorMinor > 0n && priceMinor < costFloorMinor ? costFloorMinor : priceMinor;
}

export function effectiveTierSupplyPrice(productCode: string, baseMinor: bigint, tierCode: string, rules: TierRules): bigint {
  const benefits = resolveTierBenefits(tierCode, rules);
  const tierPrice = benefits.productSupplyPrices[productCode];
  if (tierPrice !== undefined) {
    const costFloor = managedGptProduct(productCode)?.costPriceMinor ?? 0n;
    return costFloor > 0n && tierPrice < costFloor ? costFloor : tierPrice;
  }
  const costFloor = managedGptProduct(productCode)?.costPriceMinor ?? 0n;
  return effectiveSupplyPriceMinor(baseMinor, benefits.supplyDiscountBps, costFloor);
}

export function tierEffectiveSupplyPrice(_merchantId: string, _productCode: string, baseMinor: bigint, _repository: Repository): bigint {
  return baseMinor;
}

export function tierSupplyDiscountBps(merchantId: string, repository: Repository): number {
  const profile = repository.getOperations("agent_profile", merchantId);
  const rules = repository.getOperations("tier_rules", "default");
  if (!profile || !rules) return 0;
  return resolveTierBenefits(profile.tier, rules).supplyDiscountBps;
}

export function mergedCollectionModes(current: CollectionMode[], tierCode: string, rules: TierRules): CollectionMode[] {
  const level = rules.levels.find(item => item.code === tierCode);
  if (!level?.collectionModes?.length) return current;
  return [...new Set([...current, ...level.collectionModes])];
}

export function membershipProgress(profileTier: string, rules: TierRules, metricValue: bigint) {
  const levels = rules.levels;
  const currentIndex = Math.max(0, levels.findIndex(level => level.code === profileTier));
  const current = levels[currentIndex] ?? levels[0]!;
  const next = levels[currentIndex + 1] ?? null;
  const benefits = resolveTierBenefits(current.code, rules);
  const progress = next && next.threshold > current.threshold
    ? Number((metricValue - current.threshold) * 1000n / (next.threshold - current.threshold)) / 10
    : 100;
  return {
    current: {code: current.code, name: current.name, benefits: benefits.benefits, supplyDiscountBps: 0,
      productSupplyPrices: {},
      apiIncluded: benefits.apiIncluded, maxStaffAccounts: benefits.maxStaffAccounts},
    next: next ? {code: next.code, name: next.name, threshold: next.threshold.toString(),
      remaining: (next.threshold > metricValue ? next.threshold - metricValue : 0n).toString()} : null,
    progressPercent: Math.max(0, Math.min(100, progress)),
    metric: rules.metric,
  };
}
