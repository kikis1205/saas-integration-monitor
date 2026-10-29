# saas-integration-monitor

Portfolio webhook API for **SaaS integration monitoring / support engineering**: accept vendor webhooks, validate them, persist them, and inspect what arrived — the kind of plumbing that sits behind “why didn’t that invoice sync?” tickets.

Node.js · TypeScript · Express · Zod · PostgreSQL · Prisma · Vitest

## Status

| Milestone | What’s in |
|-----------|-----------|
| **1** | Express `GET /health`; Zod-validated `POST /api/v1/webhooks/events` |
| **2** | Postgres + Prisma persistence; `GET` list / get-by-id; Vitest + Supertest against real Postgres |

**Not yet:** n8n delivery, auth, dashboard, retries / queues.

Events stay in local Postgres. This API does **not** forward them to external systems.

## API (today)

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — validate, **persist**, return created resource (**201**; duplicate `event_id` → **409**)
- `GET /api/v1/events` — list (newest `received_at` first; default limit **20**, max **100**)
- `GET /api/v1/events/:id` — fetch by **internal** cuid `id` (not vendor `event_id`)

## Prerequisites

- Node.js 18+ (LTS recommended) and npm
- **Docker Desktop** for local PostgreSQL 16 (preferred so `docker-compose.yml` matches your DB)

## Quick start (Windows PowerShell)

```powershell
cd C:\Users\kikis\Cursor\saas-integration-monitor
npm install

# Docker Desktop must be running
docker --version
docker compose version
docker compose up -d
docker compose ps

Copy-Item .env.example .env
# Defaults match compose (user/password/db: sim). Edit only if you changed credentials.
# .env is gitignored — never commit secrets.

npm run prisma:generate
npm run prisma:migrate
# First migrate: when prompted for a name, use e.g. init_events
# Or: npx prisma migrate dev --name init_events

npm run dev
# Listens on PORT from .env, else 3000
```

Startup **fails fast** if `DATABASE_URL` is missing or Postgres is unreachable.

### Useful DB checks

```powershell
docker compose logs -f postgres
# optional: docker exec -it sim-postgres psql -U sim -d sim
```

Prefer Docker over a native Windows Postgres install unless you deliberately choose that path.

### Production-style start

```powershell
npm run build
npm start
```

## Tests

Vitest + Supertest hit **real Postgres** via `DATABASE_URL` (local Docker `sim-postgres`) — not an in-memory DB. Tests create rows and delete them by `id` / `event_id`. Do **not** point `DATABASE_URL` at production.

```powershell
cd C:\Users\kikis\Cursor\saas-integration-monitor
docker compose up -d
docker compose ps

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm run prisma:generate
npx prisma migrate deploy

npm test
# optional: npm run test:watch
```

Missing `DATABASE_URL` → fail-fast in test setup (same idea as app startup).

## Example requests (PowerShell)

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

Expect **201** with `id`, `event_id`, `event_type`, `occurred_at`, `payload`, `received_at`.

### Duplicate `event_id` → 409

Same `event_id` again → **409** `code: CONFLICT`.

### Invalid / malformed body

```powershell
Invoke-WebRequest -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body '{"event_id":"evt_1"}'
# → 400 VALIDATION_ERROR

Invoke-WebRequest -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body '{"event_id":'
# → 400 INVALID_JSON
```

### List and get

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/v1/events -Method Get
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events?limit=5" -Method Get
# Bad limit → 400 VALIDATION_ERROR

$created = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body $body
Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)" -Method Get
# Unknown id → 404 NOT_FOUND
```

## Layout

```
prisma/                  # schema + migrations
src/
  index.ts               # entry — fail-fast DB check, bind PORT
  app.ts                 # Express + routes (createApp for tests)
  db/prisma.ts           # PrismaClient singleton
  services/events.ts     # create / list / get
  schemas/webhookEvent.ts
  middleware/errorHandler.ts
tests/                   # Vitest + Supertest
docker-compose.yml       # local Postgres 16
.env.example             # DATABASE_URL + PORT placeholders
```
