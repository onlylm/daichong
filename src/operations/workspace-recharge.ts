import type {Repository} from "../infra/repository.js";
import type {Fulfillment, Order} from "../domain/model.js";
import {AppError} from "../domain/errors.js";
import type {Runtime} from "../bootstrap.js";
import type {RechargeCredential} from "../upstream/recharge-provider.js";
import type {Actor} from "./model.js";
import {requireTenantScope} from "./accounts.js";

export function workspaceRechargeUrl(workspaceBaseUrl: string, orderId: string): string {
  const base = workspaceBaseUrl.replace(/\/$/, "");
  const url = new URL("/workspace/app", base);
  url.searchParams.set("view", "orders");
  url.searchParams.set("recharge", orderId);
  return url.toString();
}

export function isWorkspacePortalOrder(repository: Repository, order: Order): boolean {
  return repository.listApps(order.merchantId).find(app => app.id === order.appId)?.appId === "quefa_web_portal";
}

export function postPaymentRechargeUrl(repository: Repository, order: Order, workspaceBaseUrl: string): string {
  const delivery = order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
  if (delivery === "auto_recharge" && isWorkspacePortalOrder(repository, order)) {
    return workspaceRechargeUrl(workspaceBaseUrl, order.id);
  }
  return order.fulfillmentUrl;
}

export function requireWorkspaceRechargeOrder(actor: Actor, runtime: Runtime, orderId: string): Order {
  const order = runtime.repository.findOrderInternal(orderId);
  if (!order) throw new AppError(404, "order_not_found", "订单不存在");
  requireTenantScope(actor, order.merchantId);
  const delivery = order.deliveryMode ?? (order.fulfillmentMode === "cdk" ? "cdk" : "auto_recharge");
  if (delivery !== "auto_recharge") throw new AppError(409, "auto_recharge_unavailable", "该订单不是自动直充");
  return order;
}

export function resolveAutoRechargeUpstreamCode(runtime: Runtime, order: Order): string | undefined {
  if ((order.deliveryMode ?? "cdk") !== "auto_recharge" || order.fulfillmentMode !== "cdk") return undefined;
  const voucher = runtime.repository.findCdkVoucherByOrder(order.id);
  if (!voucher || voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "充值资源尚未就绪或已使用");
  return runtime.cdk.readUpstreamCode(voucher);
}

export function workspaceSubmitRecharge(runtime: Runtime, order: Order, credential: RechargeCredential): Fulfillment {
  if (order.fulfillmentMode === "cdk") {
    const voucher = runtime.repository.findCdkVoucherByOrder(order.id);
    if (!voucher || voucher.status !== "unused") throw new AppError(409, "voucher_unavailable", "充值资源尚未就绪或已使用");
    return runtime.fulfillments.createCdkPublic(order, voucher, runtime.cdk.readUpstreamCode(voucher), credential);
  }
  return runtime.fulfillments.createDirectPublic(order, credential);
}
