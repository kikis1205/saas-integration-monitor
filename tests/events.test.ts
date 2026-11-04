import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";
import { MAX_ATTEMPTS } from "../src/services/events";

/**
 * Integration tests against real Postgres (DATABASE_URL / Docker sim-postgres).
 *
 * Pattern:
 * 1. POST creates a unique event_id
 * 2. Assert HTTP status + body
 * 3. afterEach deletes rows we created (by id / event_id) so runs stay non-flaky
 *
 * Process tests mock global `fetch` (outbound delivery) — no real webhook calls.
 */

const app = createApp();

const DELIVERY_ENV_KEYS = [
  "DELIVERY_WEBHOOK_URL",
  "DELIVERY_TIMEOUT_MS",
  "DELIVERY_WEBHOOK_SECRET",
] as const;

const savedDeliveryEnv: Record<string, string | undefined> = {};

/** Track rows this file created so cleanup is precise. */
const createdIds: string[] = [];
const createdEventIds: string[] = [];

function track(created: { id: string; event_id: string }): void {
  createdIds.push(created.id);
  createdEventIds.push(created.event_id);
}

function uniqueEventId(suffix: string): string {
  return `evt_test_${suffix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function validBody(eventId: string, data: Record<string, unknown> = { amount: 42, currency: "USD" }) {
  return {
    event_id: eventId,
    event_type: "invoice.paid",
    occurred_at: "2026-03-20T12:00:00.000Z",
    data,
  };
}

function jsonResponse(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (createdIds.length === 0 && createdEventIds.length === 0) {
    return;
  }

  await prisma.event.deleteMany({
    where: {
      OR: [{ id: { in: [...createdIds] } }, { eventId: { in: [...createdEventIds] } }],
    },
  });

  createdIds.length = 0;
  createdEventIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/v1/webhooks/events", () => {
  it("creates an event → 201 and persists fields", async () => {
    const eventId = uniqueEventId("create");
    const body = validBody(eventId);

    const res = await request(app).post("/api/v1/webhooks/events").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      event_id: eventId,
      event_type: "invoice.paid",
      occurred_at: "2026-03-20T12:00:00.000Z",
      payload: body,
      status: "PENDING",
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
      processed_at: null,
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.received_at).toBe("string");
    track(res.body);

    const row = await prisma.event.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    expect(row?.eventId).toBe(eventId);
    expect(row?.eventType).toBe("invoice.paid");
    expect(row?.status).toBe("PENDING");
    expect(row?.attemptCount).toBe(0);
  });

  it("rejects duplicate event_id → 409 CONFLICT", async () => {
    const eventId = uniqueEventId("dup");
    const body = validBody(eventId);

    const first = await request(app).post("/api/v1/webhooks/events").send(body);
    expect(first.status).toBe(201);
    track(first.body);

    const second = await request(app).post("/api/v1/webhooks/events").send(body);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: "CONFLICT",
      message: "An event with this event_id already exists",
    });
  });

  it("rejects invalid body → 400 VALIDATION_ERROR", async () => {
    const res = await request(app)
      .post("/api/v1/webhooks/events")
      .send({ event_id: "evt_incomplete" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe("GET /api/v1/events", () => {
  it("lists created events", async () => {
    const eventId = uniqueEventId("list");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const res = await request(app).get("/api/v1/events");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const listed = res.body.find((row: { id: string }) => row.id === created.body.id);
    expect(listed).toMatchObject({
      id: created.body.id,
      event_id: eventId,
      status: "PENDING",
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
      processed_at: null,
    });
  });
});

describe("GET /api/v1/events/:id", () => {
  it("returns 200 for an existing id", async () => {
    const eventId = uniqueEventId("get");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const res = await request(app).get(`/api/v1/events/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      event_id: eventId,
      event_type: "invoice.paid",
      status: "PENDING",
      attempt_count: 0,
      last_error: null,
      last_attempt_at: null,
      processed_at: null,
    });
  });

  it("returns 404 NOT_FOUND for a missing id", async () => {
    const res = await request(app).get(
      "/api/v1/events/cmmissing00000000000000000",
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "NOT_FOUND",
      message: "Event not found",
    });
  });
});

describe("POST /api/v1/events/:id/process", () => {
  beforeEach(() => {
    for (const key of DELIVERY_ENV_KEYS) {
      savedDeliveryEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DELIVERY_WEBHOOK_URL = "https://example.com/webhook/test";
    process.env.DELIVERY_TIMEOUT_MS = "5000";
  });

  afterEach(() => {
    for (const key of DELIVERY_ENV_KEYS) {
      const previous = savedDeliveryEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("HTTP 2xx → 200 SUCCEEDED and calls fetch once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_ok");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const res = await request(app).post(`/api/v1/events/${created.body.id}/process`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: created.body.id,
      status: "SUCCEEDED",
      attempt_count: 1,
      last_error: null,
    });
    expect(typeof res.body.processed_at).toBe("string");
    expect(typeof res.body.last_attempt_at).toBe("string");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/webhook/test");
  });

  it("HTTP 500 → 200 FAILED with last_error; retry then SUCCEEDED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_retry");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const failed = await request(app).post(`/api/v1/events/${created.body.id}/process`);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({
      id: created.body.id,
      status: "FAILED",
      attempt_count: 1,
      processed_at: null,
    });
    expect(failed.body.last_error).toContain("500");

    const ok = await request(app).post(`/api/v1/events/${created.body.id}/process`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: "SUCCEEDED",
      attempt_count: 2,
      last_error: null,
    });
    expect(typeof ok.body.processed_at).toBe("string");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("already SUCCEEDED → 200 no-op does not call fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_idem");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const first = await request(app).post(`/api/v1/events/${created.body.id}/process`);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("SUCCEEDED");
    expect(first.body.attempt_count).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();

    const second = await request(app).post(`/api/v1/events/${created.body.id}/process`);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: "SUCCEEDED",
      attempt_count: 1,
      processed_at: first.body.processed_at,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown id → 404 NOT_FOUND", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app).post(
      "/api/v1/events/cmmissing00000000000000000/process",
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "NOT_FOUND",
      message: "Event not found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing DELIVERY_WEBHOOK_URL → 200 FAILED", async () => {
    delete process.env.DELIVERY_WEBHOOK_URL;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_nourl");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const res = await request(app).post(`/api/v1/events/${created.body.id}/process`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "FAILED",
      attempt_count: 1,
      processed_at: null,
    });
    expect(res.body.last_error).toContain("DELIVERY_WEBHOOK_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exhausted retries → 409 PROCESSING_EXHAUSTED", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_exh");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const res = await request(app).post(`/api/v1/events/${created.body.id}/process`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("FAILED");
      expect(res.body.attempt_count).toBe(i);
    }

    const exhausted = await request(app).post(
      `/api/v1/events/${created.body.id}/process`,
    );
    expect(exhausted.status).toBe(409);
    expect(exhausted.body).toMatchObject({
      code: "PROCESSING_EXHAUSTED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    const row = await prisma.event.findUnique({ where: { id: created.body.id } });
    expect(row?.status).toBe("FAILED");
    expect(row?.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it("concurrent process claims → one winner; fetch once; final status not corrupted", async () => {
    // Slow resolve so the loser can still see PROCESSING while the winner delivers.
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => gate);
    vi.stubGlobal("fetch", fetchMock);

    const eventId = uniqueEventId("proc_race");
    const created = await request(app)
      .post("/api/v1/webhooks/events")
      .send(validBody(eventId));
    expect(created.status).toBe(201);
    track(created.body);

    const path = `/api/v1/events/${created.body.id}/process`;
    const pending = Promise.all([request(app).post(path), request(app).post(path)]);

    // Wait until the winner has claimed and started delivery.
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    release(jsonResponse(200));

    const [a, b] = await pending;

    const outcomes = [
      { status: a.status, body: a.body },
      { status: b.status, body: b.body },
    ];
    const oks = outcomes.filter((o) => o.status === 200);
    const conflicts = outcomes.filter((o) => o.status === 409);

    // Winner: 200 SUCCEEDED. Loser: 409 in-flight, or 200 idempotent no-op if peer already finished.
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + conflicts.length).toBe(2);

    for (const ok of oks) {
      expect(ok.body).toMatchObject({
        status: "SUCCEEDED",
        attempt_count: 1,
        last_error: null,
      });
      expect(typeof ok.body.processed_at).toBe("string");
    }

    for (const conflict of conflicts) {
      expect(conflict.body.code).toBe("PROCESSING_IN_PROGRESS");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const row = await prisma.event.findUnique({ where: { id: created.body.id } });
    expect(row?.status).toBe("SUCCEEDED");
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toBeNull();
    expect(row?.processedAt).not.toBeNull();
  });
});
