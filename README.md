# saas-integration-monitor

Minimal webhook API for a SaaS integration monitoring portfolio project.

## What it does

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — validate a webhook event, **persist** it, then return the created resource
- `GET /api/v1/events` — list stored events (newest `received_at` first; default limit **20**, max **100**)
- `GET /api/v1/events/:id` — fetch one event by **internal** cuid `id`

Events are stored locally in Postgres. This API does **not** forward or deliver events to external systems.

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm (comes with Node)
- **Docker Desktop** (recommended) for local PostgreSQL 16 — see below

## Install

```powershell
npm install
```

## Local PostgreSQL

### 1. Install / start Docker Desktop (if needed)

If `docker` is not recognized in PowerShell:

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/).
2. Enable the WSL 2 backend if prompted; reboot if Docker asks.
3. Start **Docker Desktop** and wait until it reports running.
4. Confirm:

```powershell
docker --version
docker compose version
```

Do **not** silently switch to a native PostgreSQL Windows installer as a substitute without deciding that path explicitly. Prefer Docker so the repo’s `docker-compose.yml` matches your local DB.

### 2. Start Postgres 16

From the repo root:

```powershell
cd C:\Users\kikis\Cursor\saas-integration-monitor
docker compose up -d
docker compose ps
```

### 3. Create local `.env`

```powershell
Copy-Item .env.example .env
# Defaults match docker-compose (user/password/db: sim). Edit only if you changed compose credentials.
```

`.env` is gitignored. Never commit real secrets.

The process **fails fast** at startup if `DATABASE_URL` is missing or Postgres is unreachable (it will not listen).

### 4. Generate client and run migrations

```powershell
npm run prisma:generate
npm run prisma:migrate
# When prompted for a migration name (first time), use e.g. init_events
```

Or: `npx prisma migrate dev --name init_events`

### Useful checks

```powershell
docker compose logs -f postgres
# optional: docker exec -it sim-postgres psql -U sim -d sim
```

## Start (development)

Runs TypeScript directly with auto-reload:

```powershell
npm run dev
```

Server listens on `PORT` if set, otherwise **3000**.

## Start (production)

```powershell
npm run build
npm start
```

## Tests

API tests use **Vitest** + **Supertest** against **real Postgres** via `DATABASE_URL` (the local Docker `sim-postgres` service). They are **not** unit tests with an in-memory DB.

**Prerequisites before `npm test`:**

1. Docker Desktop running and Postgres up: `docker compose up -d`
2. Local `.env` with `DATABASE_URL` (copy from `.env.example` if needed)
3. Migrations applied (`npm run prisma:migrate` or `npx prisma migrate deploy`)

Do **not** point `DATABASE_URL` at a production database. Tests create rows and delete them afterward by `id` / `event_id`.

```powershell
cd C:\Users\kikis\Cursor\saas-integration-monitor
docker compose up -d
docker compose ps

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run prisma:generate
npx prisma migrate deploy

npm test
# optional watch mode while iterating:
# npm run test:watch
```

If `DATABASE_URL` is missing, the test setup **fails fast** with a clear error (same idea as app startup).

## Example requests

### Health

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health -Method Get
```

### Valid webhook (persisted → 201)

```powershell
$body = @{
  event_id    = "evt_123"
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ amount = 42; currency = "USD" }
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body $body
```

Expect **201** with the created resource (`id`, `event_id`, `event_type`, `occurred_at`, `payload`, `received_at`).

### Duplicate `event_id` → 409

Posting the same `event_id` again returns **409** with `code: CONFLICT`.

### Invalid webhook (missing fields)

```powershell
Invoke-WebRequest -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body '{"event_id":"evt_1"}'
```

Expect **400** with `code: VALIDATION_ERROR` and field details.

### Malformed JSON

```powershell
Invoke-WebRequest -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body '{"event_id":'
```

Expect **400** with `code: INVALID_JSON`.

### List events (newest first)

```powershell
# Default limit 20
Invoke-RestMethod -Uri http://localhost:3000/api/v1/events -Method Get

# Custom limit (1–100)
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events?limit=5" -Method Get
```

Invalid `limit` (missing integer, `0`, or over 100) → **400** `code: VALIDATION_ERROR`.

### Get event by internal id

```powershell
# After a successful POST, use the returned `id` (cuid), not `event_id`
$created = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)" -Method Get
```

Unknown id → **404** `code: NOT_FOUND`.

## Project layout

```
prisma/
  schema.prisma            # Event model
  migrations/              # SQL migrations
src/
  index.ts                 # process entry — fail-fast DB check, binds PORT
  app.ts                   # Express app, routes (export createApp for tests)
  db/prisma.ts             # PrismaClient singleton
  services/events.ts       # createEvent / listEvents / getEventById
  schemas/webhookEvent.ts  # Zod validation schema
  middleware/errorHandler.ts
tests/
  setup.ts                 # load .env; fail-fast without DATABASE_URL
  events.test.ts           # Vitest + Supertest API coverage
vitest.config.ts           # Node test runner config
docker-compose.yml         # local Postgres 16 only
.env.example               # DATABASE_URL + PORT placeholders
```
