import type {Order} from "../domain/model.js";
import type {Repository} from "../infra/repository.js";
import type {TierRules} from "./model.js";
import {defaultTierLevels} from "./tier-benefits.js";

export interface TierUpgradeRequirement {
  minDepositMinor: bigint;
  minAgentCollectShareBps: number;
}

export interface TierUpgradeMetrics {
  completedSupplyMinor: bigint;
  agentCollectSupplyMinor: bigint;
  agentCollectShareBps: number;
  procurementBalanceMinor: bigint;
  creditedDepositMinor: bigint;
  requiredSupplyMinor: bigint;
  requiredDepositMinor: bigint;
  requiredAgentCollectShareBps: number;
}

export interface TierUpgradeEligibility {
  eligible: boolean;
  targetTier: string;
  missing: string[];
  metrics: TierUpgradeMetrics;
}

export function listCompletedTierOrders(repository: Repository, merchantId: string): Order[] {
  return repository.listOrders(merchantId).filter(order => {
    if (order.liveTest || !["paid", "partially_refunded"].includes(order.paymentStatus) || order.ordinaryRefundedMinor > 0n) return false;
    const attempt = repository.findPaymentAttemptByOrder(merchantId, order.id);
    return attempt?.status === "paid" && ["alipay_page", "dujiaopay", "agent_wallet"].includes(attempt.provider)
      && repository.listFulfillments(merchantId, order.id).some(f => f.status === "succeeded" && !!f.upstreamProvider && f.upstreamProvider !== "mock");
  });
}

export function completedTierOrderMetrics(repository: Repository, merchantId: string): {
  completedOrders: number;
  completedSupplyMinor: bigint;
  agentCollectSupplyMinor: bigint;
} {
  if (repository.tierOrderMetrics) return repository.tierOrderMetrics(merchantId);
  const orders = listCompletedTierOrders(repository, merchantId);
  return {
    completedOrders: orders.length,
    completedSupplyMinor: orders.reduce((sum, order) => sum + order.supplyAmountMinor, 0n),
    agentCollectSupplyMinor: orders.filter(order => (order.collectionMode ?? "platform_collect") === "agent_collect")
      .reduce((sum, order) => sum + order.supplyAmountMinor, 0n),
  };
}

export function resolveTierUpgradeRequirement(tierCode: string, rules: TierRules): TierUpgradeRequirement | null {
  const level = rules.levels.find(item => item.code === tierCode);
  if (!level || level.code === "standard") return null;
  const preset = defaultTierLevels.find(item => item.code === tierCode);
  const minDepositMinor = level.minDepositMinor ?? preset?.minDepositMinor;
  const minAgentCollectShareBps = level.minAgentCollectShareBps ?? preset?.minAgentCollectShareBps ?? 0;
  if (minDepositMinor === undefined && minAgentCollectShareBps <= 0) return null;
  return {minDepositMinor: BigInt(minDepositMinor ?? "0"), minAgentCollectShareBps};
}

function procurementBalanceMinor(repository: Repository, merchantId: string): bigint {
  if (repository.walletTotals) return repository.walletTotals(merchantId).procurement;
  return repository.listOperations("wallet_entry", merchantId).reduce((sum, entry) => sum + entry.procurementDelta, 0n);
}

function creditedDepositMinor(repository: Repository, merchantId: string): bigint {
  if(repository.creditedDepositTotal)return repository.creditedDepositTotal(merchantId);
  return repository.listOperations("wallet_deposit", merchantId).filter(deposit => deposit.status === "credited")
    .reduce((sum, deposit) => sum + deposit.amountMinor, 0n);
}

export function evaluateTierUpgradeEligibility(repository: Repository, merchantId: string, targetTier: string, rules: TierRules): TierUpgradeEligibility {
  const level = rules.levels.find(item => item.code === targetTier);
  if (!level) return {eligible: false, targetTier, missing: ["目标等级无效"], metrics: emptyMetrics()};
  const requirement = resolveTierUpgradeRequirement(targetTier, rules);
  const completed = completedTierOrderMetrics(repository, merchantId);
  const completedSupplyMinor = completed.completedSupplyMinor;
  const completedOrders = BigInt(completed.completedOrders);
  const progressValue = rules.metric === "supply_amount" ? completedSupplyMinor : completedOrders;
  const agentCollectSupplyMinor = completed.agentCollectSupplyMinor;
  const agentCollectShareBps = completedSupplyMinor > 0n ? Number(agentCollectSupplyMinor * 10_000n / completedSupplyMinor) : 0;
  const metrics: TierUpgradeMetrics = {
    completedSupplyMinor,
    agentCollectSupplyMinor,
    agentCollectShareBps,
    procurementBalanceMinor: procurementBalanceMinor(repository, merchantId),
    creditedDepositMinor: creditedDepositMinor(repository, merchantId),
    requiredSupplyMinor: level.threshold,
    requiredDepositMinor: requirement?.minDepositMinor ?? 0n,
    requiredAgentCollectShareBps: requirement?.minAgentCollectShareBps ?? 0,
  };
  const missing: string[] = [];
  if (progressValue < level.threshold) {
    missing.push(rules.metric === "supply_amount"
      ? "累计有效供货额未达 " + formatYuan(level.threshold)
      : "有效完成订单未达 " + level.threshold.toString() + " 单");
  }
  if (requirement && requirement.minDepositMinor > 0n) {
    if (metrics.procurementBalanceMinor < requirement.minDepositMinor) {
      missing.push("采购余额需 ≥ " + formatYuan(requirement.minDepositMinor) + "（当前 " + formatYuan(metrics.procurementBalanceMinor) + "）");
    }
  }
  if (requirement && requirement.minAgentCollectShareBps > 0) {
    if (agentCollectShareBps < requirement.minAgentCollectShareBps) {
      missing.push("自收款（余额采购）供货占比需 ≥ " + (requirement.minAgentCollectShareBps / 100).toFixed(1) + "%（当前 "
        + (agentCollectShareBps / 100).toFixed(1) + "%），不能全部依赖平台代收");
    }
  }
  return {eligible: missing.length === 0, targetTier, missing, metrics};
}

function formatYuan(minor: bigint): string {
  return "¥" + (Number(minor) / 100).toLocaleString("zh-CN", {maximumFractionDigits: 0});
}

function emptyMetrics(): TierUpgradeMetrics {
  return {completedSupplyMinor: 0n, agentCollectSupplyMinor: 0n, agentCollectShareBps: 0, procurementBalanceMinor: 0n,
    creditedDepositMinor: 0n, requiredSupplyMinor: 0n, requiredDepositMinor: 0n, requiredAgentCollectShareBps: 0};
}

export function wireTierUpgradeEligibility(value: TierUpgradeEligibility) {
  return {
    eligible: value.eligible,
    targetTier: value.targetTier,
    missing: value.missing,
    metrics: {
      completedSupplyMinor: value.metrics.completedSupplyMinor.toString(),
      agentCollectSupplyMinor: value.metrics.agentCollectSupplyMinor.toString(),
      agentCollectShareBps: value.metrics.agentCollectShareBps,
      procurementBalanceMinor: value.metrics.procurementBalanceMinor.toString(),
      creditedDepositMinor: value.metrics.creditedDepositMinor.toString(),
      requiredSupplyMinor: value.metrics.requiredSupplyMinor.toString(),
      requiredDepositMinor: value.metrics.requiredDepositMinor.toString(),
      requiredAgentCollectShareBps: value.metrics.requiredAgentCollectShareBps,
    },
  };
}
