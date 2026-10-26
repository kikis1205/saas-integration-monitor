import express from "express";
import { ZodError } from "zod";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { webhookEventSchema } from "./schemas/webhookEvent";

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
   * Accepts a webhook event, validates with Zod, and acknowledges it.
   * Milestone 1 does not persist events — that comes later.
   */
  app.post("/api/v1/webhooks/events", (req, res, next) => {
    try {
      const event = webhookEventSchema.parse(req.body);

      // Do not log full payloads (may contain sensitive customer data).
      console.info("Webhook accepted", {
        event_id: event.event_id,
        event_type: event.event_type,
      });

      res.status(202).json({
        status: "accepted",
        event_id: event.event_id,
      });
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
