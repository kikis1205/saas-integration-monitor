import "dotenv/config";

/**
 * Tests talk to real Postgres via DATABASE_URL (local Docker sim-postgres).
 * Do not point this at a production database.
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is missing. Copy .env.example to .env, start Docker (`docker compose up -d`), then run `npm test`.",
  );
}
