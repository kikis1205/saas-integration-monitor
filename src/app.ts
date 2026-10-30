import express from "express";
import { ZodError } from "zod";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { webhookEventSchema } from "./schemas/webhookEvent";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  createEvent,
  getEventById,
  listEvents,
  processEvent,
  toEventResponse,
} from "./services/events";

/**
 * Parse `?limit=` for list endpoints.
 * Missing → default. Invalid / out of range → null (caller returns 400).
 */
function parseListLimit(raw: unknown): number | null {
  if (raw === undefined) {
    return DEFAULT_LIST_LIMIT;
  }

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }

  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    return null;
  }

  return n;
}

export function createApp() {
  const app = express();

  // Reject bodies larger than 100 KB; also enables JSON parsing.
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "saas-integration-monitor",
      version: "0.1.0",
    });
  });

  /**
   * Accept a webhook event, validate with Zod, persist, then acknowledge.
   * Success only after a successful DB write. Does not forward externally.
   */
  app.post("/api/v1/webhooks/events", async (req, res, next) => {
    try {
      const event = webhookEventSchema.parse(req.body);
      const created = await createEvent(event);

      // Do not log full payloads (may contain sensitive customer data).
      console.info("Webhook stored", {
        id: created.id,
        event_id: created.eventId,
        event_type: created.eventType,
      });

      res.status(201).json(toEventResponse(created));
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          details: err.errors.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }

      next(err);
    }
  });

  /** List events newest `received_at` first. Default limit 20, max 100. */
  app.get("/api/v1/events", async (req, res, next) => {
    try {
      const limit = parseListLimit(req.query.limit);
      if (limit === null) {
        res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Invalid query parameter",
          details: [
            {
              path: "limit",
              message: `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
            },
          ],
        });
        return;
      }

      const rows = await listEvents(limit);
      res.status(200).json(rows.map(toEventResponse));
    } catch (err) {
      next(err);
    }
  });

  /** Fetch one event by internal cuid `id` only. */
  app.get("/api/v1/events/:id", async (req, res, next) => {
    try {
      const row = await getEventById(req.params.id);
      if (!row) {
        res.status(404).json({
          code: "NOT_FOUND",
          message: "Event not found",
        });
        return;
      }

      res.status(200).json(toEventResponse(row));
    } catch (err) {
      next(err);
    }
  });

  /**
   * On-demand process: claim → local stub → SUCCEEDED or FAILED.
   * Stub only — does not call n8n or any external system.
   * Already SUCCEEDED → 200 no-op. Soft fail → 200 with status FAILED.
   * In-flight PROCESSING or exhausted retries → 409.
   */
  app.post("/api/v1/events/:id/process", async (req, res, next) => {
    try {
      const row = await processEvent(req.params.id);
      res.status(200).json(toEventResponse(row));
    } catch (err) {
      next(err);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
