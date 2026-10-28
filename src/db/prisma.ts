import { PrismaClient } from "@prisma/client";

/**
 * Shared PrismaClient singleton.
 * Under `tsx watch`, modules re-evaluate on reload; stash on globalThis so we
 * do not open a new connection pool on every restart.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __simPrisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.__simPrisma ??
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__simPrisma = prisma;
}
