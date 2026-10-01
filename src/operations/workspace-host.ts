import type {FastifyRequest} from "fastify";
import type {AppConfig} from "../config.js";
import {AppError} from "../domain/errors.js";
import {isPlatform} from "./accounts.js";
import type {Account} from "./model.js";

export type WorkspaceHost = "admin" | "partner";

export function workspaceHostSplitEnabled(config: AppConfig): boolean {
  const admin = config.adminBaseUrl ?? config.publicBaseUrl;
  return new URL(admin).origin !== new URL(config.publicBaseUrl).origin;
}

export function resolveWorkspaceHost(request: FastifyRequest, config: AppConfig): WorkspaceHost {
  const adminOrigin = new URL(config.adminBaseUrl ?? config.publicBaseUrl).origin;
  const partnerOrigin = new URL(config.publicBaseUrl).origin;
  const origin = String(request.headers.origin ?? "");
  if (origin) {
    if (origin === adminOrigin) return "admin";
    if (origin === partnerOrigin) return "partner";
    throw new AppError(403, "origin_denied", "请求来源无效");
  }
  const host = (String(request.headers.host ?? "").split(":")[0] || "").toLowerCase();
  const adminHost = new URL(adminOrigin).hostname.toLowerCase();
  const partnerHost = new URL(partnerOrigin).hostname.toLowerCase();
  if (host === adminHost) return "admin";
  if (host === partnerHost || host === "127.0.0.1" || host === "localhost") return "partner";
  throw new AppError(403, "host_denied", "无法识别的工作台域名");
}

export function assertWorkspaceRoleHost(account: Account, host: WorkspaceHost, config: AppConfig): void {
  if (!workspaceHostSplitEnabled(config)) return;
  if (isPlatform(account) && host !== "admin") {
    throw new AppError(403, "admin_workspace_required", "无法登录");
  }
  if (!isPlatform(account) && host === "admin") {
    throw new AppError(403, "partner_workspace_required", "无法登录");
  }
}

export function assertPartnerWorkspaceHost(host: WorkspaceHost, config: AppConfig): void {
  if (!workspaceHostSplitEnabled(config)) return;
  if (host !== "partner") throw new AppError(403, "partner_workspace_required", "无法注册");
}

export function assertAdminWorkspaceHost(host: WorkspaceHost, config: AppConfig): void {
  if (!workspaceHostSplitEnabled(config)) return;
  if (host !== "admin") throw new AppError(403, "admin_workspace_required", "无法登录");
}
