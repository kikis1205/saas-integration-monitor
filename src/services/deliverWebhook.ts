import type { Event } from "@prisma/client";
import { getDeliveryConfig } from "../config/delivery";

/**
 * POST the public event JSON to DELIVERY_WEBHOOK_URL (native fetch).
 * Resolves on HTTP 2xx; throws on missing URL, timeout, network, redirect, or non-2xx.
 * No Prisma — callers own claim / mark success / fail.
 */
export async function deliverWebhook(event: Event): Promise<void> {
  const config = getDeliveryConfig();

  if (!config.webhookUrl) {
    throw new Error("DELIVERY_WEBHOOK_URL is not configured");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": event.eventId,
    "X-Event-Id": event.eventId,
  };

  if (config.webhookSecret) {
    headers["X-Webhook-Secret"] = config.webhookSecret;
  }

  const body = JSON.stringify(toDeliveryBody(event));

  let response: Response;
  try {
    response = await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`Delivery timed out after ${config.timeoutMs}ms`);
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    throw new Error(message);
  }

  // redirect: "manual" — do not follow; treat 3xx / opaqueredirect as failure
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const statusLabel = response.status > 0 ? String(response.status) : "opaque";
    throw new Error(`Delivery failed: unexpected redirect (HTTP ${statusLabel})`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Delivery failed: HTTP ${response.status}`);
  }
}

/** Same snake_case shape as GET /events/:id (status is PROCESSING at send time). */
function toDeliveryBody(event: Event) {
  return {
    id: event.id,
    event_id: event.eventId,
    event_type: event.eventType,
    occurred_at: event.occurredAt.toISOString(),
    payload: event.payload,
    received_at: event.receivedAt.toISOString(),
    status: event.status,
    attempt_count: event.attemptCount,
    last_error: event.lastError,
    last_attempt_at: event.lastAttemptAt?.toISOString() ?? null,
    processed_at: event.processedAt?.toISOString() ?? null,
  };
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const named = err as { name?: string; cause?: unknown };
  if (named.name === "TimeoutError") {
    return true;
  }

  if (named.cause && typeof named.cause === "object") {
    const causeName = (named.cause as { name?: string }).name;
    if (causeName === "TimeoutError") {
      return true;
    }
  }

  return false;
}
