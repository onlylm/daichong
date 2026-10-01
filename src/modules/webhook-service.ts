import { randomUUID } from "node:crypto";
import type { Repository } from "../infra/repository.js";
import type { OutboxEvent } from "../domain/model.js";
import { AppError } from "../domain/errors.js";

export class WebhookService {
  constructor(private readonly repository: Repository) {}

  emit(merchantId: string, eventKey: string, eventType: string, aggregateId: string, payload: Record<string, unknown>): OutboxEvent {
    return this.repository.transaction(() => this.emitLocked(merchantId, eventKey, eventType, aggregateId, payload));
  }

  private emitLocked(merchantId: string, eventKey: string, eventType: string, aggregateId: string, payload: Record<string, unknown>): OutboxEvent {
    const existing = this.repository.listOutbox(merchantId).find((event) => event.eventKey === eventKey);
    if (existing) return existing;
    const event: OutboxEvent = {
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      merchantId,
      eventKey,
      eventType,
      aggregateId,
      payload,
      occurredAt: new Date(),
    };
    this.repository.appendOutbox(event);
    const orderId = typeof payload.order_id === "string" ? payload.order_id : aggregateId;
    const targetUrl = this.repository.findOrder(merchantId, orderId)?.notifyUrl;
    for (const endpoint of this.repository.listWebhookEndpoints(merchantId)) {
      if (targetUrl && endpoint.url !== targetUrl) continue;
      if (endpoint.status !== "active") continue;
      if (!endpoint.subscribedEvents.includes("*") && !endpoint.subscribedEvents.includes(eventType)) continue;
      this.repository.insertWebhookDelivery({
        id: `dlv_${randomUUID().replaceAll("-", "")}`,
        merchantId,
        outboxEventId: event.id,
        endpointId: endpoint.id,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(),
        leaseUntil: null,
        deliveredAt: null,
        lastErrorCode: null,
        responseStatus: null,
      });
    }
    return event;
  }

  assertRegisteredEndpoint(merchantId: string, url: string | undefined): void {
    if (!url) return;
    const registered = this.repository.listWebhookEndpoints(merchantId)
      .some((endpoint) => endpoint.status === "active" && endpoint.url === url);
    if (!registered) throw new AppError(422, "webhook_url_not_registered", "notify_url 必须先由 Quefa 登记");
  }
}
