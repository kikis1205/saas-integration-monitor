import { Prisma, type Event } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { WebhookEvent } from "../schemas/webhookEvent";

/**
 * Persist a validated webhook event.
 * `payload` stores the full validated body (event_id, event_type, occurred_at, data).
 */
export async function createEvent(event: WebhookEvent): Promise<Event> {
  return prisma.event.create({
    data: {
      eventId: event.event_id,
      eventType: event.event_type,
      occurredAt: new Date(event.occurred_at),
      payload: event as Prisma.InputJsonValue,
    },
  });
}

/** Map a Prisma Event row to the public snake_case JSON shape. */
export function toEventResponse(row: Event) {
  return {
    id: row.id,
    event_id: row.eventId,
    event_type: row.eventType,
    occurred_at: row.occurredAt.toISOString(),
    payload: row.payload,
    received_at: row.receivedAt.toISOString(),
  };
}
