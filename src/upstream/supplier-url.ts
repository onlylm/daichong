import {isIP} from "node:net";
import {AppError} from "../domain/errors.js";

export function validateSupplierBases(openApiBase: string, cdkBase: string, environment: "sandbox" | "production", allowedHosts: string[]): void {
  const api = validateBase(openApiBase, "/openapi/v1", allowedHosts);
  const cdk = validateBase(cdkBase, "/api/v1/cdk", allowedHosts);
  if (api.hostname !== cdk.hostname) throw new AppError(422, "supplier_environment_mismatch", "直充与兑换接口必须属于同一供应环境");
  if ((api.hostname === "sandbox.zovocard.com" && environment !== "sandbox") || (api.hostname === "zovocard.com" && environment !== "production")) {
    throw new AppError(422, "supplier_environment_mismatch", "环境标识与供应域名不一致");
  }
}

function validateBase(value: string, path: string, allowedHosts: string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(422, "invalid_supplier_url", "供应接口地址无效"); }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new AppError(422, "supplier_host_not_allowed", "供应接口域名不在允许名单中");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname.replace(/\/+$/, "") !== path) {
    throw new AppError(422, "invalid_supplier_url", "供应接口必须使用固定 HTTPS 基础路径，不能包含查询参数、片段或认证信息");
  }
  return url;
}
