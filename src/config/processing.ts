/**
 * On-demand stuck-PROCESSING reclaim settings.
 * Stale threshold must be ≫ DELIVERY_TIMEOUT_MS so a healthy in-flight
 * delivery is not stolen by a concurrent process call.
 */

export const DEFAULT_PROCESSING_STALE_MS = 300_000;

export type ProcessingConfig = {
  /** Age of lastAttemptAt after which PROCESSING may be re-claimed (ms). */
  staleMs: number;
};

/**
 * Read and validate PROCESSING_STALE_MS.
 * Throws if the env value is present but not a positive integer.
 */
export function getProcessingConfig(env: NodeJS.ProcessEnv = process.env): ProcessingConfig {
  return { staleMs: parseStaleMs(env.PROCESSING_STALE_MS) };
}

function parseStaleMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PROCESSING_STALE_MS;
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`PROCESSING_STALE_MS must be a positive integer, got: ${raw}`);
  }
  return n;
}
