import {randomBytes} from "node:crypto";
import type {FastifyInstance, FastifyRequest} from "fastify";
import type {AppConfig} from "../config.js";
import type {Runtime} from "../bootstrap.js";
import {AppError} from "../domain/errors.js";
import {usdtCheckoutPage} from "./usdt-page.js";
import {postPaymentRechargeUrl} from "../operations/workspace-recharge.js";

export function registerUsdtRoutes(app: FastifyInstance, config: AppConfig, runtime: Runtime): void {
  const service = runtime.dujiaopay;
  const workspaceBaseUrl = config.publicBaseUrl;
  if (!service) return;
  type Params = {Params: {orderId: string}; Querystring: {token?: string}};
  const verify = (id: string, token?: string) => {
    if (!runtime.portalTokens.verifyPayment(id, token ?? "")) throw new AppError(404, "payment_not_found", "支付入口不存在");
    return service.status(id);
  };
  const origin = (request: FastifyRequest) => {
    if (request.headers.origin !== new URL(config.publicBaseUrl).origin) throw new AppError(403, "origin_denied", "请求来源无效");
  };
  app.get<Params>("/usdt-payments/:orderId", async (request, reply) => {
    verify(request.params.orderId, request.query.token);
    const nonce = randomBytes(18).toString("base64");
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
      .send(usdtCheckoutPage(nonce));
  });
  app.get<Params>("/usdt-payments/:orderId/status", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const status = verify(request.params.orderId, request.query.token);
    const order = runtime.repository.findOrderInternal(request.params.orderId);
    if (order && status.recharge_url && ["paid", "partially_refunded"].includes(order.paymentStatus)) {
      return {...status, recharge_url: postPaymentRechargeUrl(runtime.repository, order, workspaceBaseUrl)};
    }
    return status;
  });
  app.post<Params>("/usdt-payments/:orderId/start", async (request, reply) => {
    origin(request); verify(request.params.orderId, request.query.token);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    return service.start(request.params.orderId);
  });
  app.post<Params>("/usdt-payments/:orderId/refresh", async (request, reply) => {
    origin(request); verify(request.params.orderId, request.query.token);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    await service.reconcile(request.params.orderId);
    return service.status(request.params.orderId);
  });
  app.post<{Params: {revisionId: string}}>("/internal/webhooks/dujiaopay/:revisionId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      if (!request.rawBody || !request.headers["content-type"]?.startsWith("application/json")) return reply.code(400).send({ok: false});
      const h = (name: string) => typeof request.headers[name] === "string" ? request.headers[name] as string : "";
      service.receiveWebhook(request.params.revisionId, {id: h("djp-webhook-id"), timestamp: h("djp-webhook-timestamp"), signature: h("djp-webhook-signature")}, request.rawBody);
      return {ok: true};
    } catch {return reply.code(400).send({ok: false});}
  });
}
