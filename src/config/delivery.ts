/**
 * Outbound delivery settings from env (Milestone 4).
 * URL is operator-controlled — validate http(s) absolute when present.
 * Missing URL is allowed at load time; deliverWebhook fails the attempt instead.
 */

export const DEFAULT_DELIVERY_TIMEOUT_MS = 5000;

export type DeliveryConfig = {
  /** Absolute http(s) webhook URL, or null when unset. */
  webhookUrl: string | null;
  timeoutMs: number;
  /** Shared secret for X-Webhook-Secret; null when unset/empty → omit header. */
  webhookSecret: string | null;
};

/**
 * Read and validate delivery env. Throws if URL is set but not absolute http(s),
 * or if DELIVERY_TIMEOUT_MS is present but not a positive number.
 */
export function getDeliveryConfig(env: NodeJS.ProcessEnv = process.env): DeliveryConfig {
  const rawUrl = env.DELIVERY_WEBHOOK_URL?.trim() ?? "";
  const webhookUrl = rawUrl.length > 0 ? assertAbsoluteHttpUrl(rawUrl) : null;

  const timeoutMs = parseTimeoutMs(env.DELIVERY_TIMEOUT_MS);

  const rawSecret = env.DELIVERY_WEBHOOK_SECRET?.trim() ?? "";
  const webhookSecret = rawSecret.length > 0 ? rawSecret : null;

  return { webhookUrl, timeoutMs, webhookSecret };
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DELIVERY_TIMEOUT_MS;
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DELIVERY_TIMEOUT_MS must be a positive number, got: ${raw}`);
  }
  return n;
}

/** Require an absolute URL whose protocol is http: or https:. */
function assertAbsoluteHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DELIVERY_WEBHOOK_URL must be an absolute http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("DELIVERY_WEBHOOK_URL must be an absolute http(s) URL");
  }

  return value;
}
