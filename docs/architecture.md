# Lomi Document Operations — Architecture

This document describes what is implemented in this repository. Items marked
**Not implemented** or **Recommended** are not built.

## 1. What the product does

Lomi operates document workflows for multiple customers. A customer sends a
PDF; Lomi identifies what was received, extracts the fields that customer's
template defines, proves where each value came from, checks it, shows people
exactly what needs a decision, keeps every decision, and produces output
documents from approved data.

```
Ingress → Durable acceptance → Parse → Extract → Verify evidence → Validate
        → Human review (or tenant policy) → Approved data → Generated document
                         ↑                                          │
                 Revised version: carry over unchanged reviews,     │
                 reopen changed evidence                            ▼
                                              Provenance for every step
```

Two experiences share one backend:

| Experience | Who | What |
| --- | --- | --- |
| Document Operations (portal) | customer reviewers/admins | list/search/filter, upload, review with highlighted evidence, approve/correct, versions, history, outputs, progress |
| Operations + Schema Studio | Lomi operators (and customer admins for their own tenant's operations) | tenants, document types, base PDFs, template drafts/publish (coordtool mapper), failures and retry, metrics, model policy, provider readiness |

## 2. What came from coordtool

| coordtool capability | Use in Lomi | Change |
| --- | --- | --- |
| `Field` model (13 field types, semantic keys, cardinality, transforms, geometry) | Template field definitions | Added optional `extraction`, `validationRules`, `reviewPolicy` |
| `generateLayout/Mapping/Transforms/Tables` | Build render inputs from a template version | None |
| `renderPdf` (pdf-lib) | Generated output documents | Added `deterministic` option (byte-reproducible output) and `RENDERER_VERSION` |
| PDF.js (`pdfjs-dist`) | Viewer (browser) and text extraction (server, `@lomi/pdf/text`) | New Node entry point on the same library |
| `PDFViewer` | Evidence highlighting on the review page | Added `readOnly` and `highlightColor` props |
| Mapper (`App.tsx`), `FieldEditor`, `FieldList`, preview | Schema Studio | Moved to `components/studio/Mapper.tsx` with optional props; `FieldEditor` gained an operations section |
| `node:http` API (`/api/health`, `/api/render`) | Kept, extended with Lomi routes | Optional route handler parameter |
| pnpm workspace, Turborepo, Dockerfiles, CI | Kept | New package/app, Debian base image, CI services |

No parallel PDF subsystem was built.

## 3. Packages

```
packages/core     Field model + schema generators (coordtool)            pure
packages/pdf      renderer (coordtool) + @lomi/pdf/text (Node text)      pdf-lib, pdfjs-dist
packages/docops   extraction orchestration, evidence verification,       pure (Node crypto)
                  validation, disposition, carry-over
apps/api          HTTP API, AppPort capabilities, MCP, worker, seed      pg, bullmq, appport, anthropic, rust-ml-runtime
apps/web          React UI (portal, operations, Schema Studio)
```

`@lomi/docops` contains the document-operations decisions as pure functions so
they are tested without a database and shared by API and worker.

## 4. Tenancy and authorization

- **Tenants** own everything: document types, base PDFs, templates, ingress
  endpoints, documents, values, decisions, outputs, jobs.
- **Isolation is enforced twice.** Every query names the tenant, and
  PostgreSQL row-level security (`FORCE`d, so the owner role is bound too)
  admits only rows of `app.tenant_id`. Application queries run as the
  non-superuser role `lomi_app` (superusers bypass RLS). Cross-tenant work
  (outbox dispatch, recovery, operator-wide metrics) uses an explicit
  `app.bypass_rls` setting in `withSystem`. Verified against the database:
  cross-tenant reads return nothing and cross-tenant writes are rejected.
- **Identities**: principals (users, agents, services) with hashed API tokens;
  memberships give a role per tenant. Lomi operators are flagged principals.
- **Permissions** are resolved per request from the role in the tenant named
  by the request. A tenant the caller is not a member of answers `NOT_FOUND`.
  Lomi-internal permissions (`lomi.*`) are never granted by a membership.

| Role | Can |
| --- | --- |
| customer_admin | everything for their tenant, including retry and model-processing authorization |
| reviewer | read, submit, review (approve/correct), generate |
| viewer | read |
| submitter | submit, read |
| agent | delegated scopes ∩ {read, submit, templates.read, provenance.read, propose, operations.read} ∩ delegator's permissions |
| Lomi operator | all tenants plus Lomi-internal operations |

**Agents propose; people decide.** `reviews.decide` is not grantable to agents
even if delegated (tested). Agents use `values.propose`; a person accepts a
proposal, which becomes a normal human decision referencing it. Every agent
capability call is audited with capability, delegating human, input summary
and outcome.

## 5. AppPort: one capability boundary

All application operations are AppPort capabilities (`apps/api/src/capabilities/app.ts`,
27 capabilities, `@appport/*` pinned at core 1.13.0 / server 1.5.0 / mcp 1.5.0).
The same application object serves:

| Surface | Path | Notes |
| --- | --- | --- |
| REST | `/api/documents`, `/api/values/:id/review`, … | thin adapters calling `handleRequest` |
| AppPort HTTP binding | `/api/appport`, `/api/appport/manifest`, `/.well-known/appport` | AppPort's own server binding |
| MCP | `/api/mcp` | `@appport/mcp`; tools are projected from the manifest |
| Web UI | uses `/api/appport` | same envelopes as any client |

Authorization pipeline: `authenticated` → `tenant-membership` (NOT_FOUND
concealment) → `permissionAuthorizer({ resolvePermissions })`. Outputs are
validated against declared schemas.

Findings from probing AppPort before relying on it: output validation is
strict; a `resolvePermissions` callback that grants without checking for a
principal lets anonymous calls through (so the resolver requires a principal
and `authenticated` runs first); capability names must be lowercase dotted
segments.

**Not implemented**: AppPort approval enforcement (`enforceApprovals`) and
delegated-authority grants. Human approval is enforced in the domain layer
(only `user` principals may decide) rather than through AppPort approvals.

## 6. Data model (PostgreSQL is the sole system of record)

```
tenants ─┬─ memberships ── principals ── api_tokens
         ├─ document_types ─┬─ base_pdfs (immutable, versioned, sha256)
         │                  └─ template_versions (draft → published → retired; published immutable)
         ├─ ingress_endpoints
         ├─ documents ─── document_versions (immutable files, processing status, template used, baseline)
         │       │               ├─ submissions (every receipt, incl. exact duplicates; append-only)
         │       │               ├─ extracted_values ─┬─ evidence (verified quote, page, offsets, box; append-only)
         │       │               │                    ├─ validation_results (per rule/model; append-only)
         │       │               │                    ├─ review_decisions (approve/correct/carry_over/auto_approve; append-only)
         │       │               │                    └─ review_proposals (agents)
         │       │               ├─ model_calls (prompt + raw response)
         │       │               └─ generated_documents (snapshot, hashes, renderer version)
         │       └─ document_relations (possible same transaction; never merged)
         ├─ jobs ── job_attempts
         ├─ outbox
         └─ stored_objects (content-addressed blob metadata)
audit_events (append-only), provider_readiness (workers report), schema_migrations
```

Four separate document assets:

| Asset | Lifecycle |
| --- | --- |
| Base PDF | immutable, versioned per document type, identified by sha256 |
| Template version | draft (editable) → published (immutable by trigger) → retired; changes create a new version |
| Submission / document version | immutable file; processed with the latest published template at that time, recorded on the version |
| Generated PDF | rendered from a recorded snapshot of approved values + exact template version + base PDF + renderer version; idempotent per snapshot; re-render verification compares bytes |

Objects (originals, base PDFs, outputs) are stored content-addressed under a
tenant prefix in a filesystem store (a Docker volume locally); PostgreSQL
holds metadata and hashes, and reads verify the hash.

## 7. Processing, durability and recovery

```
API transaction:  document + version + submission + job + outbox row   (COMMIT)  → 202
Worker:           dispatcher: outbox (FOR UPDATE SKIP LOCKED) → BullMQ → mark published
                  consumer:   claim job with lease (UPDATE … WHERE queued OR lease expired)
                              → parse → extract → verify → validate
                              → one transaction: values, evidence, checks, decisions,
                                model calls, version status, job succeeded (only if lease still held)
                  reconciler: expired leases → new outbox event (or fail when attempts exhausted)
                              due jobs whose last publication went stale → republish
```

- **Redis carries wake-up messages only.** Every state transition is in
  PostgreSQL. PostgreSQL and Redis do not share a transaction: an event can be
  published twice; claims make duplicates harmless.
- **Idempotency**: claims are conditional updates; results are written in the
  same transaction that marks the job succeeded; a worker that lost its lease
  writes nothing; outputs are unique per (version, snapshot hash, renderer).
- **Failure classification**:
  - permanent (missing/unauthorized model provider, no published template,
    unreadable PDF) → version `failed_operator` with a stated action, no automatic retry;
  - transient (e.g. model timeout) → `retry_wait` with exponential backoff via a
    delayed outbox event; after `max_attempts` → `failed_operator`.
- **Concurrent versions**: latest wins. Unfinished earlier versions are marked
  superseded (kept, results discarded at commit). Carry-over compares against
  the most recent processed earlier version.
- Verified: duplicate delivery (3 concurrent → 1 success), worker crash after
  claim (attempt 1 abandoned, attempt 2 succeeded, no duplicate rows), Redis
  FLUSHDB/FLUSHALL + restart (work recovered, decisions intact), uploads
  while Redis is down, exhausted leases fail visibly. `scripts/resilience-check.sh`
  repeats the crash and Redis checks against a live `docker compose` stack.

**Known limitation**: leases are not renewed. A job running longer than
`JOB_LEASE_SECONDS` (default 120) can be re-claimed; correctness holds (the
first worker's commit writes nothing), but work is duplicated. **Recommended**:
heartbeat lease extension.

## 8. Extraction, evidence and validation

- **Extraction methods per field**: `pattern` (deterministic regex: first group
  is the value, the whole match is the quote) or `llm` (generative provider,
  one call per document for all LLM fields).
- **Evidence verification** (deterministic, never delegated to a model): the
  quote must appear in the parsed page text after collapsing whitespace only;
  case and characters must match. The value must also be stated by its quote
  (dates and amounts compared after parsing). Unverifiable values become gaps
  with `value: null`, a reason, and the model's original claim preserved.
- **Deterministic validation**: required, date/amount/phone/ZIP/SSN/EIN formats,
  regex, numeric range, enum, cross-field sums and date order.
- **Semantic validation**: bounded typed questions about an already-extracted,
  evidence-verified value: yes/no, choice (pass if the answer is in an accepted
  set) or score (pass at or above a level). Every rule has a confidence floor;
  below it the outcome is `uncertain` and a person decides.
- **Disposition**: gap → reviewer must supply/confirm; default policy is
  "always review"; a tenant may opt a field into threshold auto-approval
  (recorded as a policy decision with the threshold and confidence source).
- Model confidence is stored with its source (`deterministic_match`,
  `model_probability`, `model_self_reported`) and never treated as a calibrated
  probability. Operations shows model-check outcomes against reviewer
  decisions to support calibration later.

## 9. Model providers

Roles and options (`apps/api/src/llm`):

| Role | Options |
| --- | --- |
| extraction | `anthropic` (generative, external) · `none` (patterns only) |
| semantic validation | `laya` (local) · `anthropic` (external) · `none` (recorded as skipped) |

- **Laya** is a structured-decision model served by `rust-ml-runtime`, loaded
  **in-process in the worker** through the runtime's native Node binding
  (`@rust-ml-runtime/node@0.3.0`). No separate service. The API process never
  loads it. Readiness is checked with the runtime's `selfTest` (no inference);
  a missing model is a configuration failure for an operator, not a retry.
  The model is installed by the one-shot `models` service with the pinned
  `ml-runtime` CLI into a volume.
- **Anthropic** (official SDK, structured outputs, refusal fallback beta) is
  registered only when `ANTHROPIC_API_KEY` is set.
- **Selection is explicit and tenant-authorized.** Deployment defaults may only
  name local providers. External providers require the tenant's recorded
  authorization. A fallback (e.g. Anthropic when Laya is not ready) is used only
  if the tenant configured it and authorized external processing; otherwise
  processing stops with a readiness error. Customer content is never silently
  rerouted to an external provider.
- **Economics**: high-volume bounded checks run locally at no per-call cost;
  paid generative inference is reserved for fields whose extraction needs it.

Observed with the real model on the seeded documents: yes/no checks were
correct with high confidence (0.90, 0.96); a choice check answered wrongly at
confidence 0.15 and a score check was vague at 0.16 — both became `uncertain`.
Choice/score checks should be measured against reviewer outcomes before being
relied on. The Anthropic adapter has **not** been exercised against the live
API in this repository's sessions (no key was available), and no automated
test calls it: tests cover its registration and the selection/authorization
rules around it, not its request/response handling. Treat it as unverified.

## 10. Revisions, carry-over, duplicates, corrections

- A revision is a new immutable version. For each field, Lomi fingerprints
  (interpretation hash of the field definition, normalized value, verified
  quote). Identical fingerprint and an existing decision → **carried over**
  (new `carry_over` decision referencing the original). Otherwise the field
  **reopens** with reasons (value changed, evidence changed, definition
  changed, not previously reviewed). A matching value with different evidence
  reopens. Corrections carry over as corrections.
- Exact duplicate bytes (same tenant, any ingress) → a `duplicate_exact`
  submission pointing at the existing version; nothing reprocessed.
- Same business transaction in a different file → `document_relations`
  "possible same transaction" via the template's identity keys; flagged, never merged.
- Corrections are new append-only decisions; history is never overwritten
  (append-only triggers on decisions, evidence, validations, submissions, audit).

## 11. Provenance

`documents.provenance` returns submissions (who, when, ingress, hash), each
version's parser, template version and definition hash, baseline version,
model selection notes (including any fallback), model calls (provider, model,
prompt version; raw prompt/response for Lomi operators only), every decision
with actor and authority, and generated outputs with snapshot hash, base PDF
hash and renderer version.

## 12. Operational visibility

Derived from persisted records (`operations.stats`): received, processed, in
progress, awaiting review, failed (needs operator / retrying), failure
reasons, median processing time, median review time, correction rate by field
and template version, model-check outcomes vs reviewer decisions, per-tenant
attention list. Workers report provider readiness to PostgreSQL.

## 13. Engineering trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| Pure `@lomi/docops` package | One implementation for API, worker and tests | One more package |
| RLS in addition to query filters | A missed `WHERE` cannot leak another tenant's data | `SET ROLE` per connection; system paths need explicit bypass |
| Outbox + leases instead of trusting BullMQ state | Redis loss cannot lose work or records | Duplicate deliveries must be (and are) idempotent; reconciler latency |
| Pattern extraction first | Deterministic, free, reviewable; product works with no model | Patterns must be written per template |
| Laya in-process in the worker | No extra service; local inference | Worker image must be glibc; first check loads the model (~9 s cold) |
| Polling for progress (1.5–2 s while processing) | No extra infrastructure | Not instant; streaming deferred |
| Filesystem object store | Durable on a volume; simple | Single-node; S3 adapter deferred |
| One application image | Same code for API, worker, jobs | 1.19 GB image (full workspace); trimming deferred |

## 14. Deliberately deferred

- Lease heartbeat renewal; S3-compatible object store; streaming progress.
- Integration destinations (webhooks/ERP delivery) — schema and UI not built.
- Bulk historical ingestion; email/SFTP ingress (endpoints can be configured, no receivers).
- AppPort approval/delegation primitives; MCP OAuth (bearer tokens only).
- Retention/archival policies for raw model I/O and originals.
- Template field-level diffing between versions in Studio.
- Production image trimming (`pnpm deploy --prod`).

## 15. Scaling to 10,000+ documents (recommendations, not implemented)

- **Workers**: stateless; scale horizontally. Claims and `SKIP LOCKED`
  dispatch already allow many workers. Tune `WORKER_CONCURRENCY` per CPU; Laya
  is CPU-bound, so concurrency ≈ cores per worker. Add lease renewal first.
- **Queue**: BullMQ throughput is not the bottleneck at this scale; parsing and
  model calls are. Separate queues per job kind and per tenant tier would stop
  one tenant's bulk upload starving others.
- **Database**: indexes exist for tenant/status/subject lookups. Add
  partitioning of `audit_events`, `validation_results` and `model_calls` by
  month; move `parsed_text` and raw model I/O to object storage with a pointer
  once they dominate table size; connection pooling (PgBouncer, transaction
  mode is compatible with the per-transaction settings used for RLS).
- **Tenant isolation at scale**: RLS keeps a shared schema safe; very large
  tenants can be moved to dedicated databases behind the same code.
- **Object storage**: implement the `ObjectStore` interface on S3/GCS; keys are
  already content-addressed and tenant-prefixed.
- **Extraction cost**: patterns first; batch LLM fields per document (done);
  route bounded checks to Laya (done); cache by document hash (exact duplicates
  already skip processing).
- **Retries**: exponential backoff exists; add per-provider circuit breakers so
  an outage fails fast into `retry_wait` instead of consuming attempts.
- **Observability**: the metrics above come from SQL; add OpenTelemetry traces
  around job stages and export queue depth, lease expiries and provider latency.
- **Review workload**: correction-rate-by-field data supports deciding which
  fields can move to threshold auto-approval; prioritise review queues by
  failed checks and value.
- **Retention**: per-tenant retention for originals, parsed text and raw model
  I/O, with archival of closed documents.
