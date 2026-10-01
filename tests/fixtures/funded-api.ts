import type {Runtime} from "../../src/bootstrap.js";
// Synthetic deposits in isolated test repositories only. Never called by runtime/bootstrap.
export function fundAndApproveApi(runtime: Runtime, partnerId = "pt_demo_a", amount = "110.00") {
  const merchantId = runtime.repository.findMerchantByPartner(partnerId)!.id;
  const admin = {id: "test-admin", merchantId: null, role: "platform_admin" as const};
  const owner = {id: "test-owner-" + partnerId, merchantId, role: "agent_owner" as const};
  if (Number(amount) > 0) {
    const deposit = runtime.wallets.requestDeposit(owner, merchantId, amount, "fixture-deposit", "TEST ONLY");
    runtime.wallets.reviewDeposit(admin, deposit.id, true, "fixture:" + partnerId);
  }
  return {merchantId, owner, admin};
}
