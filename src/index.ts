import "dotenv/config";
import { createApp } from "./app";
import { prisma } from "./db/prisma";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is missing. Copy .env.example to .env and set DATABASE_URL (see README), then retry.",
    );
    process.exit(1);
  }

  try {
    await prisma.$connect();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      "Database connection failed. Ensure Postgres is running (`docker compose up -d`) and DATABASE_URL is correct.",
    );
    console.error(detail);
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 3000;
  const app = createApp();

  app.listen(port, () => {
    console.info(`saas-integration-monitor listening on port ${port}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
