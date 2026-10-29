import { defineConfig } from "vitest/config";

/**
 * Vitest for the Express + TypeScript API on Windows.
 * - Node environment (no browser/DOM)
 * - setupFiles loads .env and fails fast without DATABASE_URL
 * - fileParallelism off so shared Postgres rows do not race
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
  },
});
