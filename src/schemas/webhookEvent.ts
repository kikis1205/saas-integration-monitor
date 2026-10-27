import { z } from "zod";

/**
 * Expected JSON body for POST /api/v1/webhooks/events.
 * Keep field names and rules easy to explain in an interview.
 */
export const webhookEventSchema = z.object({
  event_id: z.string().min(1, "event_id must be a non-empty string"),
  event_type: z.string().min(1, "event_type must be a non-empty string"),
  occurred_at: z
    .string()
    .datetime({ message: "occurred_at must be a valid ISO 8601 datetime" }),
  data: z.record(z.unknown()),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;
