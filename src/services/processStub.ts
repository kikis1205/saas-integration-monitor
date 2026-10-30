import type { Event } from "@prisma/client";

/**
 * In-process stub handler for Milestone 3.
 * Deterministic: fails only when the stored payload has `data.force_fail === true`.
 * No HTTP, no Prisma, no external delivery (not n8n).
 */
export function runProcessStub(event: Event): void {
  if (payloadForcesFail(event.payload)) {
    throw new Error("Forced stub failure (data.force_fail)");
  }
}

function payloadForcesFail(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  if (!("data" in payload)) {
    return false;
  }

  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return false;
  }

  return (data as { force_fail?: unknown }).force_fail === true;
}
