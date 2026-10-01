import type { TenantContext } from "./domain/model.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    tenant?: TenantContext;
    apiRateLimit?: {limit: number; remaining: number; resetAt: number};
  }
}
