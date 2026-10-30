# saas-integration-monitor

Portfolio webhook API for **SaaS integration monitoring / support engineering**: accept vendor webhooks, validate them, persist them, inspect what arrived, and run an **on-demand local process stub** — the kind of plumbing that sits behind “why didn’t that invoice sync?” tickets.

Node.js · TypeScript · Express · Zod · PostgreSQL · Prisma · Vitest

## Status

| Milestone | What’s in |
|-----------|-----------|
| **1** | Express `GET /health`; Zod-validated `POST /api/v1/webhooks/events` |
| **2** | Postgres + Prisma persistence; `GET` list / get-by-id; Vitest + Supertest against real Postgres |
| **3** | Event `status` + attempts; on-demand `POST /api/v1/events/:id/process`; local stub; retries up to `MAX_ATTEMPTS = 3`; exhaust → 409; idempotent `SUCCEEDED` |

**Not yet:** n8n / external delivery, auth, dashboard, queues / workers, stuck-`PROCESSING` reclaim.

Webhook ingest still only validates and persists. Processing is a **separate** step. The process handler is an **in-process stub** (deterministic success/fail from payload) — it does **not** call n8n or any external system.

## Event status lifecycle

```
(create) → PENDING ──claim──► PROCESSING ──ok──► SUCCEEDED (terminal)
                                  │
                                  └──fail──► FAILED ──claim if attempts < 3──┘
                                                │
                                                └── attempts ≥ 3 → terminal FAILED
```

| Field | Meaning |
|-------|---------|
| `status` | `PENDING` \| `PROCESSING` \| `SUCCEEDED` \| `FAILED` |
| `attempt_count` | Incremented on each successful **claim** (entering `PROCESSING`) |
| `last_error` | Truncated stub error when `FAILED`; cleared on success |
| `last_attempt_at` | When the latest claim started |
| `processed_at` | Set when `SUCCEEDED`; otherwise null |

Constant: `MAX_ATTEMPTS = 3` (includes the first try). Retries are **on-demand** (call process again) — no backoff scheduler.

**Known limitation:** if the process dies while `status` is `PROCESSING`, the row can stick. No reclaim sweeper in this milestone.

## API (today)

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — validate, **persist**, return created resource (**201**; duplicate `event_id` → **409**); new rows are `PENDING` / `attempt_count: 0`
- `GET /api/v1/events` — list (newest `received_at` first; default limit **20**, max **100**)
- `GET /api/v1/events/:id` — fetch by **internal** cuid `id` (not vendor `event_id`)
- `POST /api/v1/events/:id/process` — claim → **local stub** → `SUCCEEDED` or `FAILED`

### Process endpoint codes

| HTTP | When |
|------|------|
| **200** | Stub succeeded → `SUCCEEDED`; or already `SUCCEEDED` (idempotent no-op) |
| **200** | Stub failed this attempt → body `status: "FAILED"` (inspect body) |
| **404** | Unknown id (`NOT_FOUND`) |
| **409** | Already `PROCESSING` (`PROCESSING_IN_PROGRESS`) or retries exhausted (`PROCESSING_EXHAUSTED`) |

**Stub rule:** if stored `payload.data.force_fail === true`, the attempt fails; otherwise it succeeds. No network calls.

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

# If `npm run dev` is already listening on :3000, stop it before `prisma generate`
# on Windows — otherwise you may hit EPERM locking `query_engine-windows.dll.node`.
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

Expect **201** with `id`, `event_id`, `event_type`, `occurred_at`, `payload`, `received_at`, plus status fields (`status: "PENDING"`, `attempt_count: 0`, `last_error` / `last_attempt_at` / `processed_at` null). List and get responses include the same status fields.

### Process → SUCCEEDED (local stub)

```powershell
$created = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body (@{
  event_id    = "evt_proc_ok_$(Get-Random)"
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ amount = 42; currency = "USD" }
} | ConvertTo-Json)

$processed = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)/process" -Method Post
$processed.status          # SUCCEEDED
$processed.attempt_count   # 1
$processed.processed_at    # ISO timestamp
```

### Process with `force_fail` → FAILED

```powershell
$failBody = @{
  event_id    = "evt_proc_fail_$(Get-Random)"
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ force_fail = $true }
} | ConvertTo-Json

$failedCreate = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body $failBody
$failed = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($failedCreate.id)/process" -Method Post
$failed.status        # FAILED
$failed.attempt_count # 1
$failed.last_error    # stub message
```

Calling process again on a retryable `FAILED` event claims another attempt (until `attempt_count` reaches 3). Already-`SUCCEEDED` process calls return **200** with the same row (no-op).

### Retry after fail → SUCCEEDED

Demo path: fail once with `force_fail`, clear that flag on the stored payload, process again.

```powershell
$retryId = "evt_retry_$(Get-Random)"
$created = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body (@{
  event_id    = $retryId
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ force_fail = $true }
} | ConvertTo-Json)

$failed = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)/process" -Method Post
$failed.status        # FAILED
$failed.attempt_count # 1

# Clear force_fail on the stored payload (demo / test helper — not a public API).
# Prefer Prisma here: docker/psql JSON quoting is fragile under Windows PowerShell.
$env:EVENT_ID = $created.id
node -e "require('dotenv').config(); const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); p.event.update({where:{id:process.env.EVENT_ID}, data:{payload:{event_id:'cleared', event_type:'invoice.paid', occurred_at:'2026-03-20T12:00:00.000Z', data:{amount:1, currency:'USD'}}}}).then(()=>p.`$disconnect());"

$ok = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)/process" -Method Post
$ok.status        # SUCCEEDED
$ok.attempt_count # 2
$ok.last_error    # null
```

### Exhaust retries → 409 `PROCESSING_EXHAUSTED`

```powershell
$exhId = "evt_exh_$(Get-Random)"
$created = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body (@{
  event_id    = $exhId
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ force_fail = $true }
} | ConvertTo-Json)

1..3 | ForEach-Object {
  $r = Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($created.id)/process" -Method Post
  "$($r.status) attempt=$($r.attempt_count)"
}

# Fourth call → 409 PROCESSING_EXHAUSTED (curl shows status + body clearly)
curl.exe -s -i -X POST "http://localhost:3000/api/v1/events/$($created.id)/process"
```

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
  services/events.ts     # create / list / get / process (claim + mark)
  services/processStub.ts # pure local stub (force_fail)
  schemas/webhookEvent.ts
  middleware/errorHandler.ts
tests/                   # Vitest + Supertest
docker-compose.yml       # local Postgres 16
.env.example             # DATABASE_URL + PORT placeholders
```
