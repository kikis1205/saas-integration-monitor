import { EventStatus, Prisma, type Event } from "@prisma/client";
import { prisma } from "../db/prisma";
import type { WebhookEvent } from "../schemas/webhookEvent";
import { runProcessStub } from "./processStub";

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** Includes the first try; FAILED rows with attemptCount >= this are exhausted. */
export const MAX_ATTEMPTS = 3;

const LAST_ERROR_MAX_LEN = 500;

export type ProcessEventErrorCode =
  | "NOT_FOUND"
  | "PROCESSING_IN_PROGRESS"
  | "PROCESSING_EXHAUSTED";

/** Domain error for the process endpoint (mapped to HTTP in the route / error handler). */
export class ProcessEventError extends Error {
  readonly code: ProcessEventErrorCode;

  constructor(code: ProcessEventErrorCode, message: string) {
    super(message);
    this.name = "ProcessEventError";
    this.code = code;
  }
}

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

/**
 * Atomically claim a row for processing: PENDING, or FAILED with attempts left.
 * Increments attemptCount and sets status=PROCESSING + lastAttemptAt.
 * Returns null when the claim predicate does not match (caller classifies).
 */
export async function claimEventForProcessing(id: string): Promise<Event | null> {
  const now = new Date();
  const result = await prisma.event.updateMany({
    where: {
      id,
      OR: [
        { status: EventStatus.PENDING },
        {
          status: EventStatus.FAILED,
          attemptCount: { lt: MAX_ATTEMPTS },
        },
      ],
    },
    data: {
      status: EventStatus.PROCESSING,
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
    },
  });

  if (result.count === 0) {
    return null;
  }

  return prisma.event.findUnique({ where: { id } });
}

export async function markEventSucceeded(id: string): Promise<Event> {
  return prisma.event.update({
    where: { id },
    data: {
      status: EventStatus.SUCCEEDED,
      processedAt: new Date(),
      lastError: null,
    },
  });
}

export async function markEventFailed(id: string, errorMessage: string): Promise<Event> {
  return prisma.event.update({
    where: { id },
    data: {
      status: EventStatus.FAILED,
      lastError: truncateError(errorMessage),
    },
  });
}

function truncateError(message: string): string {
  if (message.length <= LAST_ERROR_MAX_LEN) {
    return message;
  }
  return message.slice(0, LAST_ERROR_MAX_LEN);
}

/**
 * Claim → run local stub → SUCCEEDED or FAILED.
 * Already-SUCCEEDED → idempotent no-op (same row).
 * Throws ProcessEventError for missing / in-flight / exhausted.
 */
export async function processEvent(id: string): Promise<Event> {
  const existing = await getEventById(id);
  if (!existing) {
    throw new ProcessEventError("NOT_FOUND", "Event not found");
  }

  if (existing.status === EventStatus.SUCCEEDED) {
    return existing;
  }

  const claimed = await claimEventForProcessing(id);
  if (!claimed) {
    const again = await getEventById(id);
    if (!again) {
      throw new ProcessEventError("NOT_FOUND", "Event not found");
    }
    if (again.status === EventStatus.SUCCEEDED) {
      return again;
    }
    if (again.status === EventStatus.PROCESSING) {
      throw new ProcessEventError(
        "PROCESSING_IN_PROGRESS",
        "Event is already being processed",
      );
    }
    if (
      again.status === EventStatus.FAILED &&
      again.attemptCount >= MAX_ATTEMPTS
    ) {
      throw new ProcessEventError(
        "PROCESSING_EXHAUSTED",
        `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
      );
    }
    throw new ProcessEventError(
      "PROCESSING_IN_PROGRESS",
      "Event could not be claimed for processing",
    );
  }

  try {
    runProcessStub(claimed);
    return await markEventSucceeded(claimed.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    return await markEventFailed(claimed.id, message);
  }
}
