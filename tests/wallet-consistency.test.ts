import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {createRuntime, type Runtime} from "../src/bootstrap.js";
import {loadConfig} from "../src/config.js";
import type {Actor} from "../src/operations/model.js";

const admin: Actor = {id: "wallet-admin", role: "platform_admin", merchantId: null};

describe("wallet transactional consistency", () => {
  let runtime: Runtime;
  let merchantId: string;
  let owner: Actor;

  beforeEach(() => {
    runtime = createRuntime(loadConfig({NODE_ENV: "test", STORAGE_DRIVER: "memory", LOG_LEVEL: "silent"}));
    merchantId = runtime.repository.findMerchantByPartner("pt_demo_a")!.id;
    owner = {id: "wallet-owner", role: "agent_owner", merchantId};
    runtime.repository.saveOperations("wallet_entry", {id: "wallet-earnings-seed", merchantId, kind: "earning_release",
      procurementDelta: 0n, earningsDelta: 5_000n, frozenDelta: 0n, reference: "seed", actorId: "test", createdAt: new Date()}, true);
  });

  afterEach(() => runtime.close());

  it("replays withdrawal review without duplicate wallet or ticket side effects", () => {
    const withdrawal = runtime.wallets.requestWithdrawal(owner, merchantId, "10.00", "withdraw-safe-replay",
      {method: "alipay", account: "agent@example.com", name: "测试代理"});
    const ticket = runtime.support.createWithdrawalTicket(owner, withdrawal);

    const approved = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "approve", "");
    runtime.support.syncWithdrawalTicket(approved);
    const approvedReplay = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "approve", "");
    runtime.support.syncWithdrawalTicket(approvedReplay);
    expect(approvedReplay.status).toBe("approved");

    const paid = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "paid", "PAYMENT-000001");
    runtime.support.syncWithdrawalTicket(paid);
    const paidReplay = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "paid", "payment-000001");
    runtime.support.syncWithdrawalTicket(paidReplay);
    expect(paidReplay.status).toBe("paid");

    const messages = runtime.repository.listOperations("ticket_message", merchantId).filter(item => item.ticketId === ticket.id);
    expect(messages.map(item => item.body)).toEqual([
      expect.stringContaining("代理商申请提现"),
      "平台已审核通过，待确认实际打款并扣减冻结。",
      "平台已确认打款，提现冻结 ¥10.00 已扣减。",
    ]);
    expect(runtime.repository.listOperations("wallet_entry", merchantId).filter(item => item.id === "withdraw_paid:" + withdrawal.id)).toHaveLength(1);
  });

  it("requires a meaningful rejection reason and replays the same rejection once", () => {
    const withdrawal = runtime.wallets.requestWithdrawal(owner, merchantId, "5.00", "withdraw-reject-replay",
      {method: "bank", account: "6222000000000000", name: "测试公司"});
    const ticket = runtime.support.createWithdrawalTicket(owner, withdrawal);
    expect(() => runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "reject", "无")).toThrow("4–120 字");

    const rejected = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "reject", "收款资料不完整");
    runtime.support.syncWithdrawalTicket(rejected, "收款资料不完整");
    const replay = runtime.wallets.reviewWithdrawal(admin, withdrawal.id, "reject", "收款资料不完整");
    runtime.support.syncWithdrawalTicket(replay, "收款资料不完整");
    expect(replay.status).toBe("rejected");
    expect(runtime.repository.listOperations("ticket_message", merchantId).filter(item => item.ticketId === ticket.id)).toHaveLength(2);
    expect(runtime.repository.listOperations("wallet_entry", merchantId).filter(item => item.id === "withdraw_release:" + withdrawal.id)).toHaveLength(1);
  });

  it("binds a manual balance adjustment to the reviewed balance snapshot", () => {
    const first = runtime.wallets.adjustBalance(admin, merchantId, {account: "procurement", direction: "credit", amount: "110.00",
      reason: "补登已核实的采购款", requestKey: "manual-adjustment-001", expectedBalance: "0.00"});
    expect(first).toMatchObject({beforeMinor: 0n, afterMinor: 11_000n, procurementDelta: 11_000n});
    expect(runtime.wallets.adjustBalance(admin, merchantId, {account: "procurement", direction: "credit", amount: "110.00",
      reason: "补登已核实的采购款", requestKey: "manual-adjustment-001", expectedBalance: "0.00"}).id).toBe(first.id);
    expect(() => runtime.wallets.adjustBalance(admin, merchantId, {account: "procurement", direction: "credit", amount: "110.00",
      reason: "补登已核实的采购款", requestKey: "manual-adjustment-001", expectedBalance: "110.00"})).toThrow("调整编号已用于不同请求");
    expect(() => runtime.wallets.adjustBalance(admin, merchantId, {account: "procurement", direction: "debit", amount: "10.00",
      reason: "核减采购余额测试", requestKey: "manual-adjustment-002", expectedBalance: "0.00"})).toThrow("余额已变动");
  });
});
