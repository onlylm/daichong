import {safeWebhookFetch} from "../infra/safe-webhook.js";
import {signWebhook} from "../modules/webhook-signature.js";

export const webhookRetryDelaysSeconds = [60, 300, 900, 3600, 21_600, 86_400] as const;

export function nextWebhookAttempt(attemptCount: number, now = new Date(), jitter = 0): Date | null {
  const base = webhookRetryDelaysSeconds[attemptCount];
  if (base === undefined) return null;
  const boundedJitter = Math.max(0, Math.min(0.3, jitter));
  return new Date(now.getTime() + Math.round(base * (1 + boundedJitter)) * 1000);
}

export interface WebhookDeliveryJob {
  deliveryId: string;
  eventId: string;
  endpoint: string;
  eventType: string;
  rawBody: Buffer;
  secret: string;
  attemptCount: number;
}

export interface WebhookDeliveryStore {
  claim(limit: number, leaseSeconds: number): Promise<WebhookDeliveryJob[]>;
  markDelivered(deliveryId: string, responseStatus: number): Promise<void>;
  reschedule(deliveryId: string, nextAttemptAt: Date | null, errorCode: string): Promise<void>;
}

export class OutboxWorker {
  constructor(private readonly store: WebhookDeliveryStore, private readonly fetcher: (url: string, init: RequestInit) => Promise<{ok: boolean; status: number}> = safeWebhookFetch) {}

  async tick(): Promise<number> {
    const jobs = await this.store.claim(5, 60);
    for (const job of jobs) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await this.fetcher(job.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-quefa-event": job.eventType,
            "x-quefa-event-id": job.eventId,
            "x-quefa-delivery": job.deliveryId,
            "x-quefa-timestamp": String(timestamp),
            "x-quefa-signature": signWebhook(timestamp, job.rawBody, job.secret),
          },
          body: job.rawBody.toString("utf8"),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        await this.store.markDelivered(job.deliveryId, response.status);
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 120) : "delivery_failed";
        await this.store.reschedule(job.deliveryId, nextWebhookAttempt(job.attemptCount), code);
      }
    }
    return jobs.length;
  }
}
