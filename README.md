# saas-integration-monitor

Portfolio webhook API for **SaaS integration monitoring / support engineering**: accept vendor webhooks, validate them, persist them, inspect what arrived, and **deliver on demand over HTTP** — the kind of plumbing that sits behind “why didn’t that invoice sync?” tickets.

Node.js · TypeScript · Express · Zod · PostgreSQL · Prisma · Vitest

## Status

| Milestone | What’s in |
|-----------|-----------|
| **1** | Express `GET /health`; Zod-validated `POST /api/v1/webhooks/events` |
| **2** | Postgres + Prisma persistence; `GET` list / get-by-id; Vitest + Supertest against real Postgres |
| **3** | Event `status` + attempts; on-demand `POST /api/v1/events/:id/process`; retries up to `MAX_ATTEMPTS = 3`; exhaust → 409; idempotent `SUCCEEDED` |
| **4** (partial) | Process POSTs the stored event JSON to `DELIVERY_WEBHOOK_URL` (native `fetch`); timeout / non-2xx / missing URL → `FAILED` + existing retries |

**Not yet:** auth, dashboard, queues / workers, stuck-`PROCESSING` reclaim. Full README demo polish for delivery is still in progress.

Webhook ingest still only validates and persists. Processing is a **separate** on-demand step that now **POSTs outbound HTTP** to the configured webhook URL (n8n, webhook.site, etc.).

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
| `last_error` | Truncated delivery error when `FAILED`; cleared on success |
| `last_attempt_at` | When the latest claim started |
| `processed_at` | Set when `SUCCEEDED`; otherwise null |

Constant: `MAX_ATTEMPTS = 3` (includes the first try). Retries are **on-demand** (call process again) — no backoff scheduler.

**Known limitation:** if the process dies while `status` is `PROCESSING`, the row can stick. No reclaim sweeper in this milestone.

## API (today)

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — validate, **persist**, return created resource (**201**; duplicate `event_id` → **409**); new rows are `PENDING` / `attempt_count: 0`
- `GET /api/v1/events` — list (newest `received_at` first; default limit **20**, max **100**)
- `GET /api/v1/events/:id` — fetch by **internal** cuid `id` (not vendor `event_id`)
- `POST /api/v1/events/:id/process` — claim → **HTTP POST** to `DELIVERY_WEBHOOK_URL` → `SUCCEEDED` or `FAILED`

### Process endpoint codes

| HTTP | When |
|------|------|
| **200** | Delivery 2xx → `SUCCEEDED`; or already `SUCCEEDED` (idempotent no-op, **no HTTP**) |
| **200** | Delivery failed this attempt (non-2xx / timeout / network / missing URL) → body `status: "FAILED"` |
| **404** | Unknown id (`NOT_FOUND`) |
| **409** | Already `PROCESSING` (`PROCESSING_IN_PROGRESS`) or retries exhausted (`PROCESSING_EXHAUSTED`) |

**Delivery:** one outbound `fetch` POST per claim. Set `DELIVERY_WEBHOOK_URL` in `.env` (see `.env.example`). Optional: `DELIVERY_TIMEOUT_MS` (default 5000), `DELIVERY_WEBHOOK_SECRET` (`X-Webhook-Secret`). Automated tests mock `fetch`; they do not hit a real webhook.

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
# Set DELIVERY_WEBHOOK_URL before processing events (e.g. webhook.site or n8n).
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

### Process → SUCCEEDED (outbound HTTP)

Requires `DELIVERY_WEBHOOK_URL` in `.env` pointing at a receiver that returns 2xx (e.g. [webhook.site](https://webhook.site) — copy your unique URL).

```powershell
# In .env first: DELIVERY_WEBHOOK_URL="https://webhook.site/your-unique-id"
# Restart npm run dev after editing .env

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
# Check webhook.site — you should see one POST with the event JSON + Idempotency-Key header
```

Missing / bad URL, timeout, or non-2xx → `status: "FAILED"` with `last_error` (still HTTP **200** on the process route). Call process again to retry until `attempt_count` reaches 3. Already-`SUCCEEDED` process calls return **200** with the same row and **do not** POST again.

Failure / exhaust / retry paths are covered by `npm test` (mocked `fetch`). Optional live smoke: point `DELIVERY_WEBHOOK_URL` at webhook.site as above; to demo a soft fail, temporarily set the URL to a host that returns 500 or leave it unset.
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
  config/delivery.ts     # DELIVERY_WEBHOOK_* env parse
  db/prisma.ts           # PrismaClient singleton
  services/events.ts     # create / list / get / process (claim + deliver + mark)
  services/deliverWebhook.ts  # outbound fetch POST
  schemas/webhookEvent.ts
  middleware/errorHandler.ts
tests/                   # Vitest + Supertest (+ fetch mocks for delivery)
docker-compose.yml       # local Postgres 16
.env.example             # DATABASE_URL, PORT, delivery placeholders
```
