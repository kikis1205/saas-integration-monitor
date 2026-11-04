import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@prisma/client";
import { EventStatus } from "@prisma/client";
import { deliverWebhook } from "../src/services/deliverWebhook";

const ENV_KEYS = [
  "DELIVERY_WEBHOOK_URL",
  "DELIVERY_TIMEOUT_MS",
  "DELIVERY_WEBHOOK_SECRET",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function sampleEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "cldeliverytest000000000001",
    eventId: "evt_delivery_1",
    eventType: "invoice.paid",
    occurredAt: new Date("2026-03-20T12:00:00.000Z"),
    payload: {
      event_id: "evt_delivery_1",
      event_type: "invoice.paid",
      occurred_at: "2026-03-20T12:00:00.000Z",
      data: { amount: 10 },
    },
    receivedAt: new Date("2026-03-20T12:01:00.000Z"),
    status: EventStatus.PROCESSING,
    attemptCount: 1,
    lastError: null,
    lastAttemptAt: new Date("2026-03-20T12:02:00.000Z"),
    processedAt: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DELIVERY_WEBHOOK_URL = "https://example.com/webhook/test";
  process.env.DELIVERY_TIMEOUT_MS = "5000";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

describe("deliverWebhook", () => {
  it("POSTs full public event JSON and resolves on HTTP 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const event = sampleEvent();
    await expect(deliverWebhook(event)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/webhook/test");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      id: event.id,
      event_id: event.eventId,
      event_type: event.eventType,
      occurred_at: "2026-03-20T12:00:00.000Z",
      payload: event.payload,
      received_at: "2026-03-20T12:01:00.000Z",
      status: "PROCESSING",
      attempt_count: 1,
      last_error: null,
      last_attempt_at: "2026-03-20T12:02:00.000Z",
      processed_at: null,
    });
  });

  it("throws on non-2xx without embedding response body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { secret: "should-not-leak" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow("Delivery failed: HTTP 502");
  });

  it("throws a clear timeout error when fetch aborts with TimeoutError", async () => {
    process.env.DELIVERY_TIMEOUT_MS = "50";
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow(
      "Delivery timed out after 50ms",
    );
  });

  it("sets Idempotency-Key and X-Event-Id to event_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhook(sampleEvent({ eventId: "evt_header_check" }));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBe("evt_header_check");
    expect(headers.get("X-Event-Id")).toBe("evt_header_check");
  });

  it("omits X-Webhook-Secret when DELIVERY_WEBHOOK_SECRET is unset", async () => {
    delete process.env.DELIVERY_WEBHOOK_SECRET;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhook(sampleEvent());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has("X-Webhook-Secret")).toBe(false);
  });

  it("includes X-Webhook-Secret when DELIVERY_WEBHOOK_SECRET is set", async () => {
    process.env.DELIVERY_WEBHOOK_SECRET = "test-shared-secret";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await deliverWebhook(sampleEvent());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("X-Webhook-Secret")).toBe("test-shared-secret");
  });

  it("throws when DELIVERY_WEBHOOK_URL is missing", async () => {
    delete process.env.DELIVERY_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow(
      "DELIVERY_WEBHOOK_URL is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when DELIVERY_WEBHOOK_URL is not absolute http(s)", async () => {
    process.env.DELIVERY_WEBHOOK_URL = "ftp://example.com/hook";
    vi.stubGlobal("fetch", vi.fn());

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow(
      "DELIVERY_WEBHOOK_URL must be an absolute http(s) URL",
    );
  });

  it("throws on network errors with the underlying message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow("fetch failed");
  });

  it("throws on unexpected redirect (3xx with redirect: manual)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/elsewhere" },
        }),
      ),
    );

    await expect(deliverWebhook(sampleEvent())).rejects.toThrow(
      "Delivery failed: unexpected redirect (HTTP 302)",
    );
  });
});
