# saas-integration-monitor

Minimal webhook API for a SaaS integration monitoring portfolio project (milestone 1).

## What it does

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — accept and validate a webhook event (no persistence yet)

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm (comes with Node)
- **Docker Desktop** (recommended) for local PostgreSQL 16 — see below

## Install

```powershell
npm install
```

## Local PostgreSQL (Milestone 2 Step 1 — schema tooling)

Persistence is not wired into API routes yet. This step only adds Prisma, the `Event` schema, and a local Postgres bring-up path.

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

## Example requests

### Health

```powershell
Invoke-RestMethod -Uri http://localhost:3000/health -Method Get
```

### Valid webhook

```powershell
$body = @{
  event_id    = "evt_123"
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ amount = 42; currency = "USD" }
} | ConvertTo-Json

Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body $body
```

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

## Project layout

```
prisma/
  schema.prisma            # Event model (M2 Step 1; not used by routes yet)
src/
  index.ts                 # process entry — binds PORT
  app.ts                   # Express app, routes
  schemas/webhookEvent.ts  # Zod validation schema
  middleware/errorHandler.ts
docker-compose.yml         # local Postgres 16 only
.env.example               # DATABASE_URL + PORT placeholders
```
