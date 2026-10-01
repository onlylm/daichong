import type { TenantContext } from "./domain/model.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    tenant?: TenantContext;
  }
}

