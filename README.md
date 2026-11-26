# Lomi Document Operations

Lomi runs document workflows for multiple customers. Documents arrive; Lomi
extracts the fields each customer's template defines, proves where every value
came from, checks it, puts exactly the decisions that need a person in front of
a reviewer, keeps every decision, and produces output documents from approved
data — with provenance for all of it.

It is built on **coordtool**, the PDF field mapper this repository started as:
its PDF.js viewer, visual mapper, field model, schema generators and pdf-lib
renderer are reused, not replaced.

- Architecture, data model, trade-offs and scaling: [docs/architecture.md](docs/architecture.md)
- What existed before this work: [docs/architecture-inventory.md](docs/architecture-inventory.md)
- Engineering session log: [docs/sessions/](docs/sessions/)
- coordtool's original feature docs: [FEATURES.md](FEATURES.md), [IMPLEMENTATION.md](IMPLEMENTATION.md), [SUMMARY.md](SUMMARY.md)

---

## Run it

Prerequisites: Docker with Compose v2. First start needs network access (images,
npm packages, and a one-time download of the local Laya model, ~1 min).

```bash
docker compose up --build
```

Open <http://localhost:3000> and pick a demo identity. The stack:

| Service | Purpose |
| --- | --- |
| `web` (:3000) | UI (nginx), proxies `/api` |
| `api` (:4000) | REST, AppPort HTTP binding, MCP. Never loads models. |
| `worker` | outbox dispatch, processing, recovery; runs Laya in-process |
| `postgres` | the only system of record |
| `redis` | job delivery only — losing it loses nothing |
| `migrate`, `models`, `seed` | one-shot: schema, Laya install, demo data |

API, worker, migrate, models and seed run from one application image.

Configuration: copy `.env.example` to `.env` to change defaults. The defaults
are safe for local development. No credentials are needed; Anthropic is only
used if you set `ANTHROPIC_API_KEY` **and** a tenant authorizes external
processing.

### Demo data

Two customers (**Lakeside Property Management**, **Summit Realty Group**) with
published templates for an invoice, a lease excerpt and a market report, and:

- a Northwind invoice that was reviewed (one correction) and then **revised**:
  version 2 changes the due date and PO number, so 2 fields are back for review
  and 7 carried over;
- the same invoice re-sent through the API ingress, recognised as a duplicate;
- a lease excerpt and a market report ready for review;
- a Summit invoice that Lakeside users cannot see.

| Sign in as | Sees |
| --- | --- |
| Riley Reviewer (Lakeside) | Lakeside documents; review, correct, generate |
| Avery Admin (Lakeside) | plus Lakeside operations and model-processing authorization |
| Sam Reviewer (Summit) | Summit only |
| Olivia Ops (Lomi operator) | all customers, Operations, Schema Studio |

Demo identities exist only because `LOMI_DEV_LOGIN=1` in `docker-compose.yml`.
Their tokens are well-known development values; never seed or enable them in
production. An agent identity (`dev-lakeside-agent`, delegated by Riley) can be
used against the API/MCP to see agent limits.

### Try the API

```bash
curl -s -H 'Authorization: Bearer dev-lakeside-reviewer' http://localhost:4000/api/documents
```

```bash
curl -s -X POST -H 'Authorization: Bearer dev-lakeside-reviewer' -H 'Content-Type: application/pdf' \
  --data-binary @invoice.pdf 'http://localhost:4000/api/documents?documentType=invoice&filename=invoice.pdf'
```

| Endpoint | |
| --- | --- |
| `POST /documents` | upload (`application/pdf` with `?documentType=&filename=`, or JSON with `contentBase64`); `202` after durable acceptance |
| `POST /documents/:id/versions` | upload a revised version |
| `GET /documents/:id` | current version, status, values, evidence, checks, decisions, history |
| `POST /values/:id/review` | `{"action":"approve"}` or `{"action":"correct","value":"…","note":"…"}` |
| `GET /documents/:id/progress` | status, next action, counts |
| `GET /documents`, `POST /documents/:id/generate`, `GET /documents/:id/file` | list, generate output, download original/output |

All paths also work under `/api/…`. Tenant: `X-Lomi-Tenant` header, or implied
when the caller belongs to one tenant. Every endpoint is a thin adapter over an
AppPort capability; the full set is in the manifest at
`GET /api/appport/manifest` and is exposed to agents over MCP at `POST /api/mcp`.

### Resilience checks against the running stack

```bash
scripts/resilience-check.sh
```

Kills the worker with SIGKILL mid-processing and verifies recovery (takes about
two minutes, bounded by the job lease), then FLUSHALLs and restarts Redis and
verifies nothing was lost. `node scripts/ui-smoke.cjs` drives the UI in a
headless browser (needs Playwright).

---

## Develop and test

Requirements: Node 22, pnpm 10 (`corepack enable`), PostgreSQL 16 and Redis 7
for the integration tests.

```bash
pnpm install
```

```bash
docker run -d --name lomi-pg -e POSTGRES_USER=lomi -e POSTGRES_PASSWORD=lomi -e POSTGRES_DB=lomi_test -p 5432:5432 postgres:16-alpine
```

```bash
docker run -d --name lomi-redis -p 6379:6379 redis:7-alpine
```

```bash
pnpm build && pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` runs everything through Turborepo. Integration tests use
`TEST_DATABASE_URL` (default `postgres://lomi:lomi@localhost:5432/lomi_test`)
and `TEST_REDIS_URL` (default `redis://localhost:6379/15`; the durability
tests wipe that Redis database). Tests that need the real Laya model run only
when `LAYA_TEST_MODEL_DIR` points at an installed model
(`ml-runtime model install laya`); otherwise they are skipped and reported as
skipped. No test calls a paid model API.

| Package | Tests | Covers |
| --- | --- | --- |
| `packages/core` | 58 | coordtool field model and schema generation |
| `packages/pdf` | 49 | rendering, formatters, text extraction, deterministic output |
| `packages/docops` | 19 | evidence verification, extraction, validation, disposition, carry-over |
| `apps/api` | 35 | providers (incl. real Laya), workflow, durability with real Redis, REST/AppPort/MCP and tenant isolation, end-to-end |
| `apps/web` | 4 | mapper standalone/embedded, sign-in |

Run the API and worker outside Docker after `pnpm build`:
`node apps/api/dist/index.js` and `node apps/api/dist/worker.js` (see
`.env.example` for variables). `pnpm dev` starts the web dev server and API watcher.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Documents "On hold — Lomi is resolving an issue" with *semantic provider "laya" is not ready* | The Laya model is not installed on the worker. `docker compose run --rm models`, then retry from Operations. Or set the tenant's semantic provider to `none`. |
| `models` service fails | It downloads the model on first run; check network access. Set `LOMI_LAYA=0` to run without it. |
| Worker logs `NativeLoadError` | The worker must run on glibc Linux (the image does). Alpine/musl is not supported by the native runtime. |
| Upload returns 404 for a tenant | You are not a member of that tenant (Lomi does not reveal whether it exists). |
| A recovered job took ~2 minutes | Crash recovery waits for the job lease (`JOB_LEASE_SECONDS`, default 120). |
| Port 3000/4000 in use | Change the published ports in `docker-compose.yml`. |
| Start from scratch | `docker compose down -v` deletes all data, objects and the model volume. |

## License

MIT
