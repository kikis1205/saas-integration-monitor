import { EventStatus, Prisma, type Event } from "@prisma/client";
import { getProcessingConfig } from "../config/processing";
import { prisma } from "../db/prisma";
import type { WebhookEvent } from "../schemas/webhookEvent";
import { deliverWebhook } from "./deliverWebhook";

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** Includes the first try; FAILED rows with attemptCount >= this are exhausted. */
export const MAX_ATTEMPTS = 3;

const LAST_ERROR_MAX_LEN = 500;

const STALE_EXHAUSTED_ERROR = "Stale PROCESSING after max attempts";

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

function staleCutoff(now: Date, staleMs: number): Date {
  return new Date(now.getTime() - staleMs);
}

function isStaleProcessing(row: Event, now: Date, staleMs: number): boolean {
  if (row.status !== EventStatus.PROCESSING || !row.lastAttemptAt) {
    return false;
  }
  return row.lastAttemptAt.getTime() <= now.getTime() - staleMs;
}

/**
 * Atomically claim a row for processing:
 * - PENDING
 * - FAILED with attempts left
 * - stale PROCESSING (lastAttemptAt older than PROCESSING_STALE_MS) with attempts left
 *
 * Increments attemptCount and sets status=PROCESSING + lastAttemptAt.
 * Returns null when the claim predicate does not match (caller classifies).
 */
export async function claimEventForProcessing(id: string): Promise<Event | null> {
  const now = new Date();
  const { staleMs } = getProcessingConfig();
  const cutoff = staleCutoff(now, staleMs);

  const result = await prisma.event.updateMany({
    where: {
      id,
      OR: [
        { status: EventStatus.PENDING },
        {
          status: EventStatus.FAILED,
          attemptCount: { lt: MAX_ATTEMPTS },
        },
        {
          status: EventStatus.PROCESSING,
          attemptCount: { lt: MAX_ATTEMPTS },
          lastAttemptAt: { lte: cutoff },
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

/**
 * Mark SUCCEEDED only while still PROCESSING for this attempt.
 * Returns the current row; count=0 (lost race / already reclaimed) → re-read, no throw.
 */
export async function markEventSucceeded(
  id: string,
  expectedAttemptCount: number,
): Promise<Event> {
  await prisma.event.updateMany({
    where: {
      id,
      status: EventStatus.PROCESSING,
      attemptCount: expectedAttemptCount,
    },
    data: {
      status: EventStatus.SUCCEEDED,
      processedAt: new Date(),
      lastError: null,
    },
  });

  const row = await prisma.event.findUnique({ where: { id } });
  if (!row) {
    throw new Error(`Event ${id} not found after markEventSucceeded`);
  }
  return row;
}

/**
 * Mark FAILED only while still PROCESSING for this attempt.
 * Returns the current row; count=0 (lost race / already reclaimed) → re-read, no throw.
 */
export async function markEventFailed(
  id: string,
  errorMessage: string,
  expectedAttemptCount: number,
): Promise<Event> {
  await prisma.event.updateMany({
    where: {
      id,
      status: EventStatus.PROCESSING,
      attemptCount: expectedAttemptCount,
    },
    data: {
      status: EventStatus.FAILED,
      lastError: truncateError(errorMessage),
    },
  });

  const row = await prisma.event.findUnique({ where: { id } });
  if (!row) {
    throw new Error(`Event ${id} not found after markEventFailed`);
  }
  return row;
}

/**
 * One-shot: stale PROCESSING at max attempts → terminal FAILED (no HTTP, no attempt bump).
 * Returns the row after the transition (or current row if a peer already moved it).
 */
export async function finalizeStaleExhaustedProcessing(id: string): Promise<Event | null> {
  const now = new Date();
  const { staleMs } = getProcessingConfig();
  const cutoff = staleCutoff(now, staleMs);

  await prisma.event.updateMany({
    where: {
      id,
      status: EventStatus.PROCESSING,
      attemptCount: { gte: MAX_ATTEMPTS },
      lastAttemptAt: { lte: cutoff },
    },
    data: {
      status: EventStatus.FAILED,
      lastError: truncateError(STALE_EXHAUSTED_ERROR),
    },
  });

  return prisma.event.findUnique({ where: { id } });
}

function truncateError(message: string): string {
  if (message.length <= LAST_ERROR_MAX_LEN) {
    return message;
  }
  return message.slice(0, LAST_ERROR_MAX_LEN);
}

function isClaimable(row: Event, now: Date, staleMs: number): boolean {
  if (row.status === EventStatus.PENDING) {
    return true;
  }
  if (row.status === EventStatus.FAILED && row.attemptCount < MAX_ATTEMPTS) {
    return true;
  }
  if (
    row.status === EventStatus.PROCESSING &&
    row.attemptCount < MAX_ATTEMPTS &&
    isStaleProcessing(row, now, staleMs)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a failed claim after re-reading the row.
 * Retryable PENDING/FAILED/stale-PROCESSING is not an error — caller may re-claim.
 */
function classifyUnclaimed(
  row: Event | null,
  now: Date,
  staleMs: number,
): "not_found" | "succeeded" | "retryable" | "in_progress" | "exhausted" {
  if (!row) {
    return "not_found";
  }
  if (row.status === EventStatus.SUCCEEDED) {
    return "succeeded";
  }
  if (isClaimable(row, now, staleMs)) {
    return "retryable";
  }
  if (
    row.status === EventStatus.PROCESSING &&
    row.attemptCount >= MAX_ATTEMPTS &&
    isStaleProcessing(row, now, staleMs)
  ) {
    return "exhausted";
  }
  if (row.status === EventStatus.PROCESSING) {
    return "in_progress";
  }
  if (row.status === EventStatus.FAILED && row.attemptCount >= MAX_ATTEMPTS) {
    return "exhausted";
  }
  return "in_progress";
}

/**
 * Claim → POST outbound webhook → SUCCEEDED or FAILED.
 * Already-SUCCEEDED → idempotent no-op (same row; no HTTP).
 * Throws ProcessEventError for missing / in-flight / exhausted.
 *
 * If a peer finishes between our lost claim and re-read, leaving the row
 * claimable again (PENDING, retryable FAILED, or stale PROCESSING), we re-claim once.
 *
 * Stale PROCESSING with attemptCount >= MAX is finalized to FAILED (no HTTP) then 409.
 */
export async function processEvent(id: string): Promise<Event> {
  const existing = await getEventById(id);
  if (!existing) {
    throw new ProcessEventError("NOT_FOUND", "Event not found");
  }

  if (existing.status === EventStatus.SUCCEEDED) {
    return existing;
  }

  const now = new Date();
  const { staleMs } = getProcessingConfig();

  // Stale + exhausted: terminalize without claiming / HTTP.
  if (
    existing.status === EventStatus.PROCESSING &&
    existing.attemptCount >= MAX_ATTEMPTS &&
    isStaleProcessing(existing, now, staleMs)
  ) {
    await finalizeStaleExhaustedProcessing(id);
    throw new ProcessEventError(
      "PROCESSING_EXHAUSTED",
      `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
    );
  }

  let claimed = await claimEventForProcessing(id);

  if (!claimed) {
    const again = await getEventById(id);
    const kind = classifyUnclaimed(again, now, staleMs);
    if (kind === "not_found") {
      throw new ProcessEventError("NOT_FOUND", "Event not found");
    }
    if (kind === "succeeded") {
      return again as Event;
    }
    if (kind === "exhausted" && again?.status === EventStatus.PROCESSING) {
      await finalizeStaleExhaustedProcessing(id);
      throw new ProcessEventError(
        "PROCESSING_EXHAUSTED",
        `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
      );
    }
    if (kind === "exhausted") {
      throw new ProcessEventError(
        "PROCESSING_EXHAUSTED",
        `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
      );
    }
    if (kind === "retryable") {
      // Lost a race to a peer that already finished; row is claimable again.
      claimed = await claimEventForProcessing(id);
    }
  }

  if (!claimed) {
    const again = await getEventById(id);
    const kind = classifyUnclaimed(again, now, staleMs);
    if (kind === "not_found") {
      throw new ProcessEventError("NOT_FOUND", "Event not found");
    }
    if (kind === "succeeded") {
      return again as Event;
    }
    if (kind === "exhausted" && again?.status === EventStatus.PROCESSING) {
      await finalizeStaleExhaustedProcessing(id);
      throw new ProcessEventError(
        "PROCESSING_EXHAUSTED",
        `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
      );
    }
    if (kind === "exhausted") {
      throw new ProcessEventError(
        "PROCESSING_EXHAUSTED",
        `Event has reached the maximum of ${MAX_ATTEMPTS} processing attempts`,
      );
    }
    throw new ProcessEventError(
      "PROCESSING_IN_PROGRESS",
      "Event is already being processed",
    );
  }

  try {
    await deliverWebhook(claimed);
    return await markEventSucceeded(claimed.id, claimed.attemptCount);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown processing error";
    return await markEventFailed(claimed.id, message, claimed.attemptCount);
  }
}
