# saas-integration-monitor

Minimal webhook API for a SaaS integration monitoring portfolio project (milestone 1).

## What it does

- `GET /health` — service health check
- `POST /api/v1/webhooks/events` — accept and validate a webhook event (no persistence yet)

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm (comes with Node)

## Install

```powershell
npm install
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
src/
  index.ts                 # process entry — binds PORT
  app.ts                   # Express app, routes
  schemas/webhookEvent.ts  # Zod validation schema
  middleware/errorHandler.ts
```
