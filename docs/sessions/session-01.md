# Session 01 — Inventory, domain core, providers, schema

Sanitized engineering log of one coding-agent session (Claude Code, cloud
sandbox). It records what was done, in order, including mistakes. Secrets: none
were used; no API keys were present in this session. Paths under the sandbox
scratch directory are shortened to `<scratch>`.

## Objective

Evolve the `coordtool` repository into Lomi Document Operations, preserving its
PDF infrastructure and pnpm/Turborepo/Docker setup. This session covered the
architecture inventory, the pure domain layer, server-side PDF text, model
providers (including a mid-session change to add a local model), and the
PostgreSQL schema. The worker, API, UI and Docker work were not reached.

## 1. Inspecting the existing system

- Read the workspace, Turbo pipeline, Dockerfiles, compose file, CI, and every
  source file's exports. Ran the baseline: `pnpm build`, `pnpm test`
  (110 tests: core 58, pdf 46, api 4, web 2), `pnpm lint`, `pnpm typecheck` —
  all passed before any change.
- Findings recorded in `docs/architecture-inventory.md`: no database, queue,
  auth or server-side text parsing existed; `Field` coordinates are PDF points
  with a bottom-left origin, matching PDF.js text item transforms (this is what
  makes evidence highlighting in the existing viewer feasible).
- AppPort was not referenced in the repo. It is a published npm package family;
  its provider API was read from the published type definitions and READMEs
  (`defineCapability`, `createApplication`, `permissionAuthorizer` with
  `resolvePermissions`, `createMcpHandler`) rather than guessed. Pinned exact
  versions: core 1.13.0, server 1.5.0, mcp 1.5.0, authorization 1.4.0,
  schema 1.2.2, protocol 1.8.0.
- A Docker daemon was startable in the sandbox, so `docker compose up` can be
  verified for real later.

## 2. Domain core (`@lomi/docops`) and PDF text

Decision: put evidence verification, validation and carry-over in a new pure
package rather than in the API, so the worker, API and tests share one
implementation and it can be unit-tested without a database.

- Evidence is verified by finding the quote in the parsed page text after
  collapsing whitespace only (PDF extraction does not preserve spacing). Case
  and characters must match exactly. A second deterministic check confirms the
  value actually appears in its quote, so a model cannot pair a real quote with
  an invented value. Unverifiable values become gaps; the model's claim is kept.
- Carry-over requires the same normalized value, the same quote, and the same
  interpretation hash (type, extraction config, validation rules — geometry is
  excluded). A matching value alone never carries a review forward.
- `@lomi/pdf/text`: server-side extraction on the `pdfjs-dist` the viewer
  already uses, as a separate subpath so the browser bundle does not pull it in.
- `renderPdf({ deterministic: true })` keeps template metadata so identical
  inputs produce byte-identical PDFs (verified by hashing two renders 1 s apart).

Failures and fixes:
- `isEvalSupported` no longer exists in pdfjs 5 → DTS build failed → removed.
- One carry-over test passed the wrong field definition (test bug, not logic
  bug) → split into an evidence-only case and a definition-only case.
- Lint: a useless regex escape; fixed.

## 3. Local model (Laya) — change of direction mid-session

The user asked to include `rust-ml-runtime` with the Laya model, in the same
container, replaceable, treated like an external model call, with Anthropic as
another option.

Findings from reading the runtime repository:
- Laya is a structured-decision model (yes/no "noul", choice, score heads with
  probabilities). It does not generate text or extract spans. It is therefore
  used only for semantic checks on already-extracted, evidence-verified values.
- The runtime's HTTP server exposes tensor inference only; decisions are
  available through the native Node package `@rust-ml-runtime/node@0.3.0`.
- The native package ships glibc builds only (`linux-x64-gnu`), so the worker
  image cannot stay on Alpine.

First attempt: a separate HTTP gateway process around the Node binding. The
user then directed: no separate gateway or service; use the native binding
in-process in the worker, behind the provider adapter. The gateway was removed
before being committed.

Verification with the real model:
- Built the CLI from source (`cargo build --release -p ml-runtime-cli`, 2m31s)
  because GitHub release downloads were blocked in the sandbox; installed Laya
  (`ml-runtime model install laya`, ONNX, pinned revision `68f27df…`, 48 s).
- Real in-process call answered all three decision types. Observed: yes/no
  p(true)=0.82 for "ACME Supplies Inc. is an organization"; choice was close to
  a coin flip (company 0.494 vs person 0.485, runtime confidence 0.29); score
  probabilities are keyed by level index. Consequence: every semantic rule has a
  confidence floor, and below it the result is `uncertain` and goes to a person.
- `LocalML.selfTest` reports a missing model without inference ("model not
  found: laya; install it with `ml-runtime model install laya`"); a failed
  inference only returns a generic error code. So readiness is checked before
  use, and a missing model is a configuration failure, not a retryable error.

Provider selection rules (user requirement: fallback explicit and
tenant-authorized; never silently send customer content to Anthropic):
- Deployment registers providers; tenants choose per role and authorize.
- External providers (Anthropic) require `externalProcessing.allowed` on the
  tenant; deployment defaults may only name local providers.
- Fallback only if the tenant configured `semanticFallback` and it is itself
  permitted; otherwise a `ProviderNotReadyError` stops processing with an
  operator action.

Tests: 11 provider/adapter tests pass, including a real-model test (runs when
`LAYA_TEST_MODEL_DIR` is set; skipped otherwise). Observed cost: ~9 s for the
first check on a fresh process because `selfTest` and `create` each load the
model.

## 4. PostgreSQL schema

- One migration: tenancy, configuration, documents/versions/submissions, jobs
  + outbox, values/evidence/validations/reviews/proposals, model calls,
  generated documents, provider readiness, audit.
- Applied to the real development database (Postgres 16 container): applied
  once, second run a no-op.
- Verified against the database as the `lomi_app` role: tenant reads isolated;
  no tenant context sees nothing; cross-tenant insert rejected by RLS; explicit
  system bypass sees all; `schema_migrations` not writable by the app role;
  `audit_events` append-only; published template versions immutable;
  `lomi_app` is not a superuser (superusers would bypass RLS).
- Bug caught before running: an `ON CONFLICT DO UPDATE` on the immutable
  `stored_objects` table would have fired the immutability trigger and aborted
  the transaction; replaced with `DO NOTHING` + select.

## Status at end of session

| Area | State |
| --- | --- |
| Inventory, docops, pdf text, deterministic render | Done, tested |
| Providers (Anthropic, Laya in-process), selection policy | Done, tested (Anthropic not called: no key in sandbox) |
| Schema | Applied and verified on the dev database |
| Document intake service | Written, typechecks, **not yet exercised** |
| Outbox, worker, review, generation, AppPort, REST, UI, Docker, e2e | Not started |

Known risks: Laya's choice/score answers were low-confidence in the one real
probe; its usefulness per check must be measured against reviewer outcomes.
The Anthropic adapter has not been exercised against the live API.

## 5. Durable processing (continued in the same session)

Built: job leasing (`jobs/lifecycle.ts`), outbox dispatcher, PostgreSQL-only
reconciler, BullMQ worker process, `process_version` and `generate_output`
handlers, template/tenant/review services, deterministic fixture PDFs, and an
integration harness that runs as `lomi_app` against a real test database.

Failure classification as implemented:
- Missing model / unauthorized external provider / no published template /
  unreadable PDF → permanent: job `failed`, version `failed_operator` with an
  operator action, no automatic retry.
- Anything else (e.g. an inference timeout) → transient: `retry_wait` with
  exponential backoff via a new, delayed outbox event.

Tests run against real PostgreSQL 16 and Redis 7:
- Workflow (5): durable acceptance before processing; evidence and validation
  persisted; review and correction history; revised invoice reopens exactly
  `invoice.due_date` and `invoice.po_number` and carries the other 7; previous
  values/evidence visible; agents and old versions refused; reproducible,
  idempotent generation; missing model → no retry, no model call, operator
  action shown; transient failure → delayed retry → success.
- Durability (6): end to end through Redis; Redis FLUSHDB (isolated db 15)
  then recovery from PostgreSQL with review decisions intact; simulated worker
  crash after claim (attempt 1 `abandoned`, attempt 2 `succeeded`, one set of
  results); three concurrent duplicate deliveries → one success; uploads while
  Redis is unavailable; exhausted leases fail visibly.
- Mutation check: removing the lease-expiry guard from the claim makes the
  crash and duplicate-delivery tests fail; restored.

Pipeline fix: Turbo's strict env mode hid `LAYA_TEST_MODEL_DIR`, so the
real-model tests were silently skipped in `pnpm test` (24 passed, 2 skipped).
Added `passThroughEnv` for the test task and disabled test caching (integration
tests depend on live services). Result: api 26/26.

Not yet built at this point: AppPort capabilities, REST endpoints, MCP, UI,
Docker Compose changes, seed script.

## 6. AppPort capabilities, REST, MCP

- 26 capabilities defined with `defineCapability`; one application serves the
  REST adapters, AppPort's own HTTP binding (`/api/appport`, manifest,
  `/.well-known/appport`) and the AppPort MCP adapter (`/api/mcp`).
- Authorization: an `authenticated` authorizer, a `tenant-membership`
  authorizer that answers NOT_FOUND for tenants the caller is not in, and
  `permissionAuthorizer({ resolvePermissions })` computing permissions from the
  caller's role in the tenant named in the input.
- Findings from probing AppPort before relying on it: (1) output validation is
  strict — undeclared output properties fail the call; (2) a `resolvePermissions`
  callback that grants permissions without checking for a principal lets an
  anonymous call through, so resolvers return nothing without a principal and
  an explicit `authenticated` authorizer runs first; (3) capability names must
  match `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` — camelCase names failed at
  startup and were renamed (e.g. `documents.versions.add`).
- Agents: effective permissions = delegated scopes ∩ agent-grantable set ∩
  delegator's permissions. `reviews.decide` is never agent-grantable; the seed
  agent is delegated it deliberately and the test confirms it is refused.
  Every agent invocation is audited with capability, delegator and outcome.
- API tests (6) through a real HTTP server: 202 after durable acceptance;
  duplicate upload recognised; cross-tenant access → 404 (both by naming the
  other tenant and by id under one's own tenant); Lomi-only operations refused
  for customers; agent can read and propose but not decide; manifest and MCP
  `tools/list`/`tools/call` work; anonymous MCP calls are refused.

## 7. Docker Compose and real-stack resilience

- One application image (`apps/api/Dockerfile`) runs api, worker, migrate,
  models and seed. The API never loads model runtimes; Laya loads in the worker.
- `models` one-shot: `ml-runtime model install laya` into a named volume, then
  `model doctor`. The CLI is a pinned v0.3.0 release whose checksum is pinned in
  `apps/api/docker/install-ml-runtime.mjs` (not fetched beside the archive).
- Sandbox-specific obstacles (not product changes): Docker Hub returned 429, so
  official images were pulled from `mirror.gcr.io` and re-tagged locally; the
  sandbox proxy only allows HTTPS, so builds use host networking and the proxy
  CA via an uncommitted override file. Product changes that came out of it:
  the Dockerfiles accept an optional `extra_ca` BuildKit secret (for anyone
  behind a TLS-intercepting proxy), and the CLI is downloaded with Node instead
  of apt (fewer packages, works through an HTTPS-only proxy).
- Base image: started on Debian bookworm; the CLI printed
  `weak version GLIBC_2.39 not found` (bookworm has 2.36). It still worked, but
  that is a compatibility risk, so both images moved to `node:22-trixie-slim`
  (glibc 2.41); warning gone.
- Clean first run (`down -v`, then `up`): all services healthy/exited 0; seed
  finished 53 s after `up`, including the Laya download.
- Real Laya results on the seeded documents (5 model calls): yes/no checks were
  correct with high confidence (organization 0.90, street address 0.96); the
  choice check answered "immediately" for "Net 30" (wrong) at confidence 0.15,
  and the score check was vague at 0.16 — both became `uncertain` and go to a
  reviewer because of the confidence floor. Conclusion recorded: rely on Laya's
  yes/no decisions; measure choice/score against reviewer outcomes first.
- `scripts/resilience-check.sh` against the live stack: SIGKILL of the worker
  mid-processing → attempt 1 `abandoned` (lease expired), attempt 2
  `succeeded`, 9 values, no duplicates (~2 min, bounded by the 120 s lease);
  Redis FLUSHALL + restart → 16/16 review decisions intact, new upload
  processed. PASS.
- Known limitation found: leases are not renewed; a job longer than its lease
  can be re-claimed. Correctness holds (the original worker's commit writes
  nothing once it lost the lease) but work is wasted. Heartbeat renewal deferred.
- Regression I caused and fixed: adding `tsx` to `apps/api` created a second
  Vite variant (optional peer), breaking `@lomi/web` typecheck. Moved `tsx` to
  the workspace root and relinked; typecheck green again.
- CI now runs PostgreSQL and Redis services so integration tests run there.

## 8. User interface

- coordtool's mapper (`App.tsx`) moved with `git mv` to
  `components/studio/Mapper.tsx`; optional props (initial file/fields, change
  callback, header controls) let Schema Studio edit template versions, while
  the no-props behaviour and original tests are unchanged.
- `PDFViewer` gained a read-only mode and highlight colour; the document
  detail page renders verified evidence boxes through it. `FieldEditor` gained
  a document-operations section (extraction method/pattern/instructions,
  review policy, validation rules as JSON).
- New shell: sign-in (dev identities only with `LOMI_DEV_LOGIN=1`), tenant
  switcher, Documents (list/search/filter/upload, status, progress, next
  action), document detail (fields needing attention first, evidence, checks,
  previous values and why they reopened, carry-over, agent proposals,
  approve/correct with notes, versions, history, outputs with reproducibility
  check), Operations (KPIs from records, failures with retry, corrections by
  field/template, model checks vs reviewer decisions, model policy and
  external-processing authorization, worker provider readiness, new customer),
  Schema Studio (document types, versions, base PDF upload, draft/publish).
- The UI calls AppPort capabilities like any other client.
- Verified in a real browser (Playwright) against the compose stack: revised
  invoice shows 2 pending / 7 carried over; the due-date card shows old and
  new values and quotes; approving both and generating reaches Completed.
- Bugs found by driving the UI:
  1. The PDF viewer never rendered: nginx served `pdf.worker.min.mjs` as
     `application/octet-stream`, which browsers refuse for module scripts.
     This existed in the original coordtool Docker setup. Fixed in nginx.conf.
  2. Evidence quotes for lease fields included the next label
     ("Landlord: Riverbend Holdings LP Tenant:") because the fixture patterns
     used it as a terminator. Fixed with lookaheads; all 21 fixture quotes
     re-checked.
- `scripts/ui-smoke.cjs` re-runs the browser check (PASS).

## 9. End-to-end tests, documentation, final verification

- `e2e.test.ts` (3): the complete customer workflow over HTTP with a real
  BullMQ worker; a new published template version leaves earlier documents and
  outputs unchanged (byte-identical re-render) while new documents use it;
  concurrent versions (latest wins, earlier superseded and kept).
- One e2e failure was a wrong expectation in the test: a revision whose only
  decisions are carried over is "Ready for review", not "Review in progress"
  (the status rule requires a human decision on that version). Kept the rule,
  fixed the test.
- Documentation: README (run, demo data, API, tests, troubleshooting),
  `docs/architecture.md` (product, reuse from coordtool, tenancy, AppPort,
  data model, durability, extraction/validation, providers, revisions,
  provenance, operations, trade-offs, deferred work, scaling recommendations),
  `.env.example`.
- Corrected a wrong claim while writing the docs: no test exercises the
  Anthropic adapter's request/response handling; it is documented as unverified.
- Final verification from a clean slate (`down -v`, rebuilt images): seeded in
  45 s; UI smoke PASS; resilience check PASS (SIGKILL during parsing →
  attempt 1 abandoned, attempt 2 succeeded, 9 values; Redis FLUSHALL + restart
  → 16/16 decisions intact).

## Final status

| Area | Status | Evidence |
| --- | --- | --- |
| coordtool preserved and reused | done | viewer, mapper, field model, generators, renderer reused; original tests pass |
| PostgreSQL model, RLS, append-only history | done | migration applied; RLS probes; integration tests |
| Durable intake, outbox, leased worker, recovery | done | durability tests; live-stack resilience script |
| Extraction, evidence verification, validation | done | docops unit tests; workflow tests |
| Laya in-process, typed decisions, readiness | done | real-model tests; 5 real calls in Docker |
| Explicit tenant-authorized provider selection | done | provider tests |
| Anthropic adapter | written, **not verified** | no key available; no test calls it |
| Review, correction, carry-over, duplicates | done | workflow and e2e tests |
| Generated documents, reproducibility | done | verify-by-re-render tests |
| AppPort capabilities, REST, MCP, agents | done | API tests |
| UI: portal, review, operations, Studio | done | Playwright checks against the stack |
| Docker Compose one-command start | done | clean-slate run |
| Lease renewal, S3 store, integrations, streaming | deferred | documented |

Test totals at the end: core 58, docops 19, pdf 49, web 4, api 35 — all
passing; lint and typecheck clean across 8 packages.

## Publishing note

This log is the sanitized record. The raw agent transcript is kept outside the
repository and was not committed. Publishing this log as a public Gist was not
done in the session (no Gist-capable tool was available, and publishing is an
outward-facing action that needs the owner's go-ahead).
