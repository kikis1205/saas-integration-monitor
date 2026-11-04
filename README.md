# saas-integration-monitor

Portfolio webhook API for **SaaS integration monitoring / support engineering**: accept vendor webhooks, validate them, persist them, inspect what arrived, and **deliver on demand over HTTP** — the kind of plumbing that sits behind “why didn’t that invoice sync?” tickets.

Node.js · TypeScript · Express · Zod · PostgreSQL · Prisma · Vitest

## Status

| Milestone | What’s in |
|-----------|-----------|
| **1** | Express `GET /health`; Zod-validated `POST /api/v1/webhooks/events` |
| **2** | Postgres + Prisma persistence; `GET` list / get-by-id; Vitest + Supertest against real Postgres |
| **3** | Event `status` + attempts; on-demand `POST /api/v1/events/:id/process`; retries up to `MAX_ATTEMPTS = 3`; exhaust → 409; idempotent `SUCCEEDED` |
| **4** | Process POSTs the stored event JSON to `DELIVERY_WEBHOOK_URL` (native `fetch`); `Idempotency-Key` = `event_id`; timeout / non-2xx / missing URL → `FAILED` + existing retries; **stale `PROCESSING` reclaim** on the next process call |

**Not yet:** auth, dashboard, queues / workers / cron.

Webhook ingest still only validates and persists. Processing is a **separate** on-demand step that **POSTs outbound HTTP** to the configured webhook URL (n8n, webhook.site, etc.). There is **no process stub** and no `force_fail` path — failures come from real delivery outcomes (or mocked `fetch` in tests).

## Event status lifecycle

```
(create) → PENDING ──claim──► PROCESSING ──HTTP 2xx──► SUCCEEDED (terminal)
                                  │
                                  ├──timeout / network / non-2xx──► FAILED
                                  │     │
                                  │     └── claim again if attempts < 3 ──┘
                                  │           │
                                  │           └── attempts ≥ 3 → terminal FAILED
                                  │
                                  └── crash mid-flight → stuck PROCESSING
                                        │
                                        └── after PROCESSING_STALE_MS, process again
                                              reclaims (attempt++) if attempts < 3
                                              else → terminal FAILED (exhausted)
```

| Field | Meaning |
|-------|---------|
| `status` | `PENDING` \| `PROCESSING` \| `SUCCEEDED` \| `FAILED` |
| `attempt_count` | Incremented on each successful **claim** (entering `PROCESSING`) |
| `last_error` | Truncated delivery error when `FAILED`; cleared on success |
| `last_attempt_at` | When the latest claim started |
| `processed_at` | Set when `SUCCEEDED` (successfully delivered); otherwise null |

Constant: `MAX_ATTEMPTS = 3` (includes the first try). Retries are **on-demand** (call process again) — no backoff scheduler. **One outbound HTTP attempt per claim**; further tries = hit process again, still bounded by `MAX_ATTEMPTS`.

### Stuck PROCESSING reclaim

If the process dies after a successful claim and before `SUCCEEDED` / `FAILED`, the row stays `PROCESSING`. There is **no** background sweeper — reclaim runs **inside the existing claim** on the next `POST …/process`:

| Situation | Behavior |
|-----------|----------|
| Fresh `PROCESSING` (`last_attempt_at` younger than `PROCESSING_STALE_MS`) | **409** `PROCESSING_IN_PROGRESS` |
| Stale `PROCESSING` + `attempt_count` &lt; `MAX_ATTEMPTS` | Re-claim (bump attempt) → deliver again |
| Stale `PROCESSING` + `attempt_count` ≥ `MAX_ATTEMPTS` | One-shot → terminal `FAILED` (`last_error` notes stale max attempts); **409** `PROCESSING_EXHAUSTED`; no HTTP |

Success/fail marks are conditional on `status = PROCESSING` **and** the claim’s `attempt_count`, so a late writer from a zombie flight cannot clobber a newer attempt. Delivery remains **at-least-once** — receivers must dedupe on `event_id` / `Idempotency-Key`.

## Outbound delivery

`POST /api/v1/events/:id/process` → atomic claim → **one** `fetch` POST → mark `SUCCEEDED` or `FAILED`.

### Env vars

| Variable | Required? | Default | Purpose |
|----------|-----------|---------|---------|
| `DELIVERY_WEBHOOK_URL` | Needed to succeed | none | Absolute `http:` / `https:` receiver URL |
| `DELIVERY_TIMEOUT_MS` | Optional | `5000` | Hard abort for the outbound request |
| `DELIVERY_WEBHOOK_SECRET` | Optional | unset | When set, sent as `X-Webhook-Secret` |
| `PROCESSING_STALE_MS` | Optional | `300000` | Age of `last_attempt_at` after which `PROCESSING` may be re-claimed. **Must be ≫ `DELIVERY_TIMEOUT_MS`** so a healthy in-flight delivery is not stolen. Positive integer; invalid → fail at config parse. |

Missing / empty `DELIVERY_WEBHOOK_URL` does **not** crash the server. The attempt fails → `FAILED` with `last_error` like `DELIVERY_WEBHOOK_URL is not configured`. Fix `.env` and process again.

Copy placeholders from `.env.example`. Never commit `.env` or real secrets / tokenized n8n URLs.

### Request shape

- **Method / body:** `POST` JSON — same public snake_case event shape as `GET /events/:id` (status on the wire is `PROCESSING` at send time)
- **Headers:** `Content-Type: application/json`, `Idempotency-Key: <event_id>`, `X-Event-Id: <event_id>`, and optionally `X-Webhook-Secret`
- **Success:** any HTTP **2xx** → `SUCCEEDED`
- **Failure:** timeout, network error, unexpected redirect (redirects are **not** followed), or non-2xx → `FAILED` + truncated `last_error` (status text only; response bodies are not stored)
- **Client:** native Node `fetch` + `AbortSignal.timeout` — no axios / queue worker

### Sender vs receiver idempotency

Do **not** conflate these with ingest’s unique `event_id` → **409**.

| Side | Mechanism | What it prevents |
|------|-----------|------------------|
| **Sender (us)** | Atomic claim into `PROCESSING`; second caller → **409** `PROCESSING_IN_PROGRESS` | Two concurrent process calls both POSTing |
| **Sender (us)** | Already `SUCCEEDED` → process again → **200** no-op, **no HTTP** | Double-send after success |
| **Sender (us)** | Attempts incremented on claim; exhausted → **409** | Unbounded hammering of the webhook |
| **Receiver (n8n / partner)** | `Idempotency-Key` / `event_id` in body + headers | Safe if we retry after a lost response (we timed out but they processed) |

Honesty for interviews: this is **at-least-once** delivery with sender guards against concurrent and post-success doubles — **not** exactly-once. After a timeout we may retry; the receiver **must** treat `event_id` as idempotent.

### Operator URL / SSRF caution

`DELIVERY_WEBHOOK_URL` comes from **operator env**, not from webhook clients — lower risk than user-controlled URLs, but still:

- Config validates absolute `http:` / `https:` only (`file:` and other schemes are rejected)
- Prefer **HTTPS** in real demos
- Do **not** point at cloud metadata (`169.254.169.254`), internal admin panels, or `localhost` DB ports in shared environments
- There is no API to set the webhook URL from clients (that would raise real SSRF)

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
| **409** | Fresh (non-stale) `PROCESSING` (`PROCESSING_IN_PROGRESS`) or retries exhausted (`PROCESSING_EXHAUSTED`) |

Automated tests mock `fetch`; they do not hit a real webhook. Soft-fail HTTP semantics: a failed attempt still returns **200** with `status: "FAILED"` — clients must read the body. Stale-`PROCESSING` reclaim is covered by planting a backdated `lastAttemptAt` in tests (no real 5-minute wait).

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

Vitest + Supertest hit **real Postgres** via `DATABASE_URL` (local Docker `sim-postgres`) — not an in-memory DB. Tests create rows and delete them by `id` / `event_id`. Do **not** point `DATABASE_URL` at production. Delivery cases stub global `fetch`.

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

### Process → SUCCEEDED (webhook.site or n8n)

Requires `DELIVERY_WEBHOOK_URL` in `.env` pointing at a receiver that returns 2xx.

1. Open [webhook.site](https://webhook.site) → copy **Your unique URL**, **or** use a local n8n webhook path that returns 2xx.
2. Set in `.env`: `DELIVERY_WEBHOOK_URL="https://webhook.site/your-unique-id"` (restart `npm run dev` after editing).
3. Ingest then process:

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
# Refresh webhook.site / n8n — one POST with event JSON + Idempotency-Key = event_id
```

Already-`SUCCEEDED` process calls return **200** with the same row and **do not** POST again.

### Soft fail → retry → exhaust

Missing / bad URL, timeout, or non-2xx → `status: "FAILED"` with `last_error` (still HTTP **200** on the process route). Call process again to retry until `attempt_count` reaches 3; the fourth process → **409** `PROCESSING_EXHAUSTED`.

```powershell
# Demo soft fail: temporarily unset DELIVERY_WEBHOOK_URL (or point at a host that returns 500), restart, then:
$failed = Invoke-RestMethod -Uri http://localhost:3000/api/v1/webhooks/events -Method Post -ContentType "application/json" -Body (@{
  event_id    = "evt_proc_fail_$(Get-Random)"
  event_type  = "invoice.paid"
  occurred_at = "2026-03-20T12:00:00.000Z"
  data        = @{ amount = 1; currency = "USD" }
} | ConvertTo-Json)

Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$($failed.id)/process" -Method Post
# → status FAILED, last_error set; process again up to MAX_ATTEMPTS, then 409
```

Failure / exhaust / retry paths are also covered by `npm test` (mocked `fetch`). Live smoke against webhook.site is optional visual proof.

### Smoke: stuck PROCESSING reclaim (PowerShell)

Default stale window is **5 minutes**. For a quick local demo, either:

- Set `PROCESSING_STALE_MS=5000` in a throwaway `.env`, restart `npm run dev`, leave a row in `PROCESSING`, wait &gt;5s, then process again; **or**
- Keep the default threshold and **backdate** `lastAttemptAt` (same technique as the tests):

```powershell
# $id = internal cuid from ingest / GET
$id = "cmxxxxxxxxxxxxxxxxxxxxxxxxx"

@'
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const id = process.argv[1];
p.event.update({
  where: { id },
  data: {
    status: "PROCESSING",
    attemptCount: 1,
    lastAttemptAt: new Date(Date.now() - 400000),
  },
})
  .then((r) => { console.log("backdated", r.id); return p.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });
'@ | Set-Content -Encoding utf8 .\tmp-backdate-processing.js

node .\tmp-backdate-processing.js $id
Remove-Item .\tmp-backdate-processing.js

Invoke-RestMethod -Uri "http://localhost:3000/api/v1/events/$id/process" -Method Post
# → reclaim bumps attempt_count, delivers again → SUCCEEDED or FAILED
```

Prefer `npm test` for the authoritative reclaim cases.

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
  config/delivery.ts     # DELIVERY_WEBHOOK_* env parse / http(s) URL check
  config/processing.ts   # PROCESSING_STALE_MS (stuck PROCESSING reclaim)
  db/prisma.ts           # PrismaClient singleton
  services/events.ts     # create / list / get / process (claim + reclaim + deliver + mark)
  services/deliverWebhook.ts  # outbound fetch POST + Idempotency-Key
  schemas/webhookEvent.ts
  middleware/errorHandler.ts
tests/                   # Vitest + Supertest (+ fetch mocks for delivery / reclaim)
docker-compose.yml       # local Postgres 16
.env.example             # DATABASE_URL, PORT, delivery + reclaim placeholders (no secrets)
```
