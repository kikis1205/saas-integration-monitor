import express from "express";
import { ZodError } from "zod";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { webhookEventSchema } from "./schemas/webhookEvent";
import { createEvent, toEventResponse } from "./services/events";

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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
