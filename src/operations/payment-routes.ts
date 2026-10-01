import type {FastifyInstance, FastifyRequest} from "fastify";
import {z} from "zod";
import type {Runtime} from "../bootstrap.js";
import type {Actor} from "./model.js";
import {paymentConfigInput, requirePaymentAdmin} from "../modules/payment-settings.js";

const channel = z.literal("alipay_page");
const action = z.object({channel, version: z.number().int().nonnegative()}).strict();
export function registerPaymentSettingsRoutes(app: FastifyInstance, runtime: Runtime, actor: (request: FastifyRequest) => Actor): void {
  // Runs under the workspace session, password-change, same-origin and CSRF hook.
  app.get("/workspace/api/payment-settings", async request => ({data: runtime.paymentSettings.list(actor(request))}));
  app.put("/workspace/api/payment-settings", async request => {
    const user = actor(request); requirePaymentAdmin(user);
    return {data: runtime.paymentSettings.save(user, paymentConfigInput.parse(request.body))};
  });
  app.post("/workspace/api/payment-settings/check", async request => {
    const user = actor(request); requirePaymentAdmin(user); const body = action.parse(request.body);
    return {data: await runtime.paymentSettings.check(user, body.channel, body.version)};
  });
  app.post("/workspace/api/payment-settings/enable", async request => {
    const user = actor(request); requirePaymentAdmin(user);
    const body = action.extend({confirmRealPayments: z.literal(true), confirmCallbackConfigured: z.literal(true)}).parse(request.body);
    return {data: runtime.paymentSettings.activate(user, body.channel, body.version)};
  });
  app.post("/workspace/api/payment-settings/disable", async request => {
    const user = actor(request); requirePaymentAdmin(user);
    const body = z.object({channels: z.array(action).length(1)}).strict().parse(request.body);
    return {data: runtime.paymentSettings.pauseMany(user, body.channels)};
  });
}
