import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/db/prisma";

/**
 * Integration tests against real Postgres (DATABASE_URL / Docker sim-postgres).
 *
 * Pattern:
 * 1. POST creates a unique event_id
 * 2. Assert HTTP status + body
 * 3. afterEach deletes rows we created (by id / event_id) so runs stay non-flaky
 */

const app = createApp();

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

function validBody(eventId: string) {
  return {
    event_id: eventId,
    event_type: "invoice.paid",
    occurred_at: "2026-03-20T12:00:00.000Z",
    data: { amount: 42, currency: "USD" },
  };
}

afterEach(async () => {
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
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.received_at).toBe("string");
    track(res.body);

    const row = await prisma.event.findUnique({ where: { id: res.body.id } });
    expect(row).not.toBeNull();
    expect(row?.eventId).toBe(eventId);
    expect(row?.eventType).toBe("invoice.paid");
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
    expect(res.body.some((row: { id: string }) => row.id === created.body.id)).toBe(
      true,
    );
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
