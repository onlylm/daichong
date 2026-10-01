import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";

export async function issueCdkForOrder(runtime: Runtime, orderId: string, timeoutMs = 30_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runtime.cdk.issueOne();
    const order = runtime.repository.findOrderInternal(orderId);
    if (order?.voucherCode) return order.voucherCode;
    const voucher = runtime.repository.findCdkVoucherByOrder(orderId);
    if (voucher?.status === "failed") throw new AppError(503, "cdk_issue_failed", "兑换码签发失败，请稍后在订单页查看或联系平台");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return runtime.repository.findOrderInternal(orderId)?.voucherCode ?? null;
}
