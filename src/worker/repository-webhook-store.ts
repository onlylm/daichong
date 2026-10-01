import type {Repository} from "../infra/repository.js";
import type {WebhookDeliveryJob, WebhookDeliveryStore} from "./outbox-worker.js";

export class RepositoryWebhookDeliveryStore implements WebhookDeliveryStore {
  constructor(private readonly repository: Repository) {}

  async claim(limit: number, leaseSeconds: number): Promise<WebhookDeliveryJob[]> {
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000);
    return this.repository.claimWebhookDeliveries(limit, leaseUntil).map(({delivery, endpoint, event}) => ({
      deliveryId: delivery.id,
      eventId: event.id,
      endpoint: endpoint.url,
      eventType: event.eventType,
      secret: endpoint.secret,
      attemptCount: delivery.attemptCount - 1,
      rawBody: Buffer.from(JSON.stringify({
        event_id: event.id,
        event: event.eventType,
        occurred_at: event.occurredAt.toISOString(),
        data: event.payload,
      })),
    }));
  }

  async markDelivered(deliveryId: string, responseStatus: number): Promise<void> {
    this.repository.markWebhookDelivered(deliveryId, responseStatus, new Date());
  }

  async reschedule(deliveryId: string, nextAttemptAt: Date | null, errorCode: string): Promise<void> {
    this.repository.rescheduleWebhookDelivery(deliveryId, nextAttemptAt, errorCode);
  }
}
