import { Prisma, type Event } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { WebhookEvent } from "../schemas/webhookEvent";

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

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

/** Newest `receivedAt` first. Caller must pass a validated positive limit. */
export async function listEvents(limit: number): Promise<Event[]> {
  return prisma.event.findMany({
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
}

/** Lookup by internal cuid `id` only. Returns null when missing. */
export async function getEventById(id: string): Promise<Event | null> {
  return prisma.event.findUnique({ where: { id } });
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
    status: row.status,
    attempt_count: row.attemptCount,
    last_error: row.lastError,
    last_attempt_at: row.lastAttemptAt?.toISOString() ?? null,
    processed_at: row.processedAt?.toISOString() ?? null,
  };
}
