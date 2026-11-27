# Lomi Document Operations

PDFs come in, a model extracts the fields each document type defines, every
value is checked against the exact passage it came from, a person approves or
corrects it, and a revised document only re-opens what actually changed.

Built on the existing **coordtool** PDF mapper in this repo (viewer, field
mapper, schema generators, renderer are reused). Deeper detail:
[docs/architecture.md](docs/architecture.md) ·
QA against the brief: [docs/qa-checklist.md](docs/qa-checklist.md) ·
API: `http://localhost:4000/api/docs` (OpenAPI 3.1) ·
Engineering logs: [docs/sessions/](docs/sessions/).

---

## 1. Run it, and what to click first

Docker with Compose v2. The first start needs network access (images, npm, and a
one-time download of the local Laya model).

```bash
docker compose up
```

Migrations run, version 1 of each fixture in `packages/core/src/__tests__/fixtures`
is seeded and extracted (the `seed` container prints every extracted value), and
the UI is at <http://localhost:3000>.

**Click first: Lomi Operations → Olivia Ops** (the internal platform operator).
You see every customer, processing health and failures, and **Schema Studio**,
where document types and their fields are configured. To onboard a customer:
**Add a customer** (type the name; the short name/intake URL is derived) →
**add its first form** (Schema Studio → *New form*: name, what it is, the fields
to read — published in one step) → **Team** (add its admin, reviewers,
submitters). Then sign out and try:

| Workspace | Identity | Try |
| --- | --- | --- |
| Customer admin | Avery Admin (Lakeside) | **Team**: add people with a role (a new person gets a sign-in token, shown once); **Operations** for their own company; model authorization |
| Customer review | Riley Reviewer (Lakeside) | **Start reviewing** → each value beside its quote; Original vs Evidence; *Approve all verified*; the next document opens by itself |
| Document submission | Pat Payables (Lakeside) | the customer's intake URL `/in/lakeside`: drop any mix of PDFs without saying what they are — Lomi identifies each (Laya); everything they sent, with live status; unclear files ask them to choose |
| Customer review | Sam Reviewer (Summit) | a second customer — sees none of Lakeside's data |

**Re-extraction**: approve the Meridian invoice, then upload
`packages/core/src/__tests__/fixtures/documents/invoice-001.v2.pdf` as a new
version (or run `scripts/brief-check.sh`). Exactly two values come back:
due date and total; the other three are *carried over*.

```bash
curl -F type=invoice -F file=@invoice.pdf http://localhost:4000/documents
```

Token-less calls like this work only because `LOMI_DEV_DEFAULT_TOKEN` is set in
`docker-compose.yml` for development; real callers send `Authorization: Bearer`.

Tests: `pnpm install && pnpm test` (needs PostgreSQL and Redis; see
`.env.example`). Live-stack checks: `scripts/brief-check.sh` (revision, version
during extraction, restart mid-extraction, Redis FLUSHALL),
`scripts/resilience-check.sh`, `node scripts/ui-smoke.cjs`.

## 2. Monorepo layout, and why

```
packages/core    field model + schema generators (coordtool)        pure
packages/pdf     PDF renderer + text extraction (pdf-lib, pdfjs)    the PDF format adapter
packages/docops  extraction, evidence checks, validation, carry-over pure, no I/O
packages/config  shared tsconfig / eslint
apps/api         HTTP API, capabilities, worker, migrations, seed
apps/web         React UI (operations, review, submission, Schema Studio)
```

- **PDF is one format, not the model.** Everything after text extraction works
  on a format-neutral parsed document (pages → positioned text). Supporting
  Word, email bodies, images (OCR) or EDI means adding an adapter beside
  `packages/pdf/text`, not changing extraction, review or storage.
- **API and web are separate.** The web app has no special access: it calls the
  same capabilities as integrations and agents (`/api/appport`; also REST and MCP).
- **Everything is a view or a projection of the data.** PostgreSQL holds the
  facts (versions, values, evidence, decisions, outcomes); the review screen,
  progress counts, operations metrics, REST responses and MCP tools are all
  projections of them.
- **Configuration is separate from clients.** Document types and templates are
  data per customer (versioned, edited in Schema Studio), so a customer's
  documents can change without a code change or a fork.

Turborepo runs `build`, `test`, `lint`, `typecheck` with real dependencies
(`^build`); tests are not cached because they use live databases.

## 3. Schema, and why

Everything is per tenant (customer), isolated in PostgreSQL by row-level
security as well as by query. The schema is designed to evolve per customer:
what to extract is configuration (versioned templates), not tables.

```
document_type ─ template_version (draft → published, immutable once published)
document ─ document_version (immutable file, sha256, parsed text, template version used)
              ├─ submission (every receipt: first, revision, identical re-send; channel)
              └─ extracted_value (one per field per version)
                    ├─ evidence (verified verbatim quote, page, offsets, box)
                    ├─ validation_result (each check, deterministic or model)
                    └─ review_decision (append-only: approve / correct / carry_over)
jobs ─ job_attempts, outbox · model_calls (prompt + raw response) · audit_events
```

- **Versions** are never updated in place; a new upload is a new version. Each
  version keeps its own parsed text, so evidence for version N is always checked
  against version N's text, also after N+1 exists.
- **Values belong to a version.** Re-extraction creates new values; it never
  edits old ones. A carried-over value points at the value it came from.
- **Reviews are append-only decisions on a value.** A correction lives *beside*
  the extraction: the extracted value stays as extracted, `final_value` holds
  the reviewed one, and every decision (who, when, old/new, note, evidence
  shown) is kept. API and UI show both.

## 4. How extraction is coordinated

- **PostgreSQL** holds everything that must survive: documents, versions,
  values, reviews, job state (`queued/running/retry_wait/failed/succeeded`),
  attempts, failure reasons, and an **outbox** row written in the same
  transaction as the upload.
- **Redis (BullMQ)** only carries wake-up messages: "job X is ready".

Upload = one transaction (file, version, job, outbox) → `202` in tens of
milliseconds. The API then publishes the outbox to Redis immediately; the
worker's dispatcher and reconciler do it too, as the guarantee. A worker
**claims** a job with a lease (a conditional update in PostgreSQL); a duplicate
delivery finds nothing to claim. Results are written in the same transaction
that marks the job succeeded, only if the lease is still held, and values are
unique per (version, field) — running the same version twice cannot duplicate.

When something fails:
- **Redis lost / FLUSHALL**: nothing of value was in it. The reconciler
  republishes any due job whose message went stale.
- **Worker killed mid-extraction**: the lease expires (60 s), the reconciler
  republishes, the next attempt completes; the dead attempt is recorded as
  *abandoned*.
- **Model or parse error**: the document shows `failed` with the reason.
  Transient errors retry with backoff; then it stays `failed` with a **Retry**
  button / `POST /documents/:id/retry`. Nothing waits in `extracting` forever.
- **PostgreSQL down**: uploads fail fast (nothing is accepted that isn't stored).

## 5. Open decisions, what I chose, and why

- **Fixed-layout forms are an ETL layer for ingress, built on coordtool.** A
  form is set up from its own PDF (Schema Studio → *New form* → *From the
  form's PDF*): coordtool locates every field on every page (fillable widgets
  exactly; printed boxes from the rendered page, labelled from its text, or
  OCR for scans), the operator corrects them in the mapper, and the template
  stores each element's page and box. Incoming copies are **identified by
  layout** (the form's printed labels at their positions, ≥ 80 % in place; no
  model), **extracted by position** (`region`: the text inside each box,
  including values typed into fillable fields; printed hints like
  "MM/DD/YYYY" ignored), **normalized** by type, and land in the customer's
  **records** for that form (one row per document, one column per element;
  `records.list`, Documents → Records, CSV). Laya remains the fallback for
  identification and the reader for forms whose layout varies.
- **Unrecognized documents are mapped into existing forms, and forms grow.**
  An operator maps a document Lomi could not identify into a form (nearest
  layout first); coordtool shows which boxes the form does not read yet, and
  adding them saves a new template version (`templates.fields.add`). The
  document is then processed with it. An already processed document can be
  read again with the extended version (`documents.reread`): the same file
  becomes its next version, unchanged reviewed values carry over, only new
  elements need review. Earlier versions and their data never change, and
  element keys are stable, so the records keep one column per element.
  Limits: moving existing boxes for a re-designed layout is not supported
  (that is a new layout, not an extension); the server has no OCR, so scanned
  *submissions* are not read by position (setup from a scan works).
- **Identifying what was sent.** A submission may omit its type. After parsing,
  the worker asks Laya one yes/no question per published type ("Is this
  document a lease (a rental agreement…), a document that states tenant name,
  monthly rent…?") over the start of the document. The choice is deterministic:
  the best type must score ≥ 0.6 and beat the next by ≥ 0.3; otherwise the
  document waits as **Needs document type** and the sender or a reviewer picks
  (`documents.type.set`), after which processing continues by itself. One
  published type, an explicit type, or an intake default skip the model. How the
  type was decided (`typeSource`, scores, model call) is stored with the
  document. With the real model all four fixture files are identified (margins
  ≥ 0.77); a market report sent to a customer with only invoice/lease forms is
  held, not forced. Known limit: a type can be chosen only while the document is
  waiting for one; a wrongly identified, already-processed document has to be
  re-sent.
- **Which model extracts.** I chose the model type, not just a vendor. Sending
  documents to a vision or large generative model is costly, and most values
  can be verified deterministically once you know which passage they came from.
  So extraction uses **Laya, a local decision model** (rust-ml-runtime, run
  in-process in the worker), not a text-generation model: Lomi splits the text
  into passages and typed candidates (amounts, dates, names…), and Laya answers
  yes/no questions to pick them. It never writes a value, so it cannot invent
  one; evidence is still verified verbatim afterwards. The same decision model
  runs **semantic checks** ("does this value look like the kind of thing this
  field should be?"). A generative provider (Anthropic, structured output) is
  available per customer, only with that customer's authorization to send data
  externally. Prompts and raw responses of every model call are stored.
- **"Unchanged" for carry-over** = same normalized value + same verbatim quote
  (whitespace-normalized) + same field definition. Position is ignored, so text
  shifting around (the revised invoice adds a header and a paragraph) does not
  re-open anything; a same value with different evidence does.
- **New version while one is extracting**: supersede. The newest version is
  processed; the older one is kept, marked *superseded*, and its in-flight
  results are discarded at commit.
- **Corrections** live beside the extracted value (above).
- **Duplicates**: identical bytes are recorded as a re-send of the existing
  version (any channel) and not reprocessed; a different file with the same
  identity (e.g. vendor + invoice number) is flagged *possible duplicate*, never
  merged. Both are labelled in the list and on the document.
- **Polling, not streaming**: the UI polls every 0.7–2 s only while something
  is in flight. Extraction takes seconds and review is human-paced, so streaming
  infrastructure would not change what the reviewer sees.
- **Ingress**: one URL per customer (`/in/{tenant}`) for API, single and bulk
  uploads; processing starts immediately.

## 6. What I cut, and what I'd do next

Cut: integration destinations (pushing approved data to customers' systems);
automatic document-type detection (a wrong-type warning only); word-level
highlighting (highlights are per text line); lease renewal for very long jobs;
S3 storage (filesystem volume); slimming the 1.2 GB app image; the Anthropic
path is written but **untested** against the live API (no key was available).

Next: measure Laya on many more real documents (16/16 on the fixtures, with
instructions on three fields written after seeing them — not proof of
generality); field-level confidence thresholds from reviewer outcomes; S3;
document-type classification at intake.

## 7. At 10,000 documents

- **Revisit what needs review.** Use the recorded reviewer outcomes per field
  and template (Operations already shows correction rates and model-check vs
  reviewer results) to set thresholds, auto-approving fields that are never
  corrected and focusing people on the rest.
- **Let customers self-serve.** Customers onboard their own document types in
  Schema Studio, with a Lomi operator reviewing the configuration before it is
  published — Lomi becomes a service, not a project per customer.
- **Let agents operate it.** Every operation is an AppPort capability
  (`@appport/*`, which I built), so it is automatically an MCP tool with the
  same authorization; extend the Claude Code instructions so agents can run
  operations work (triage failures, prepare corrections for human approval).
- **Scale the mechanics**: more workers (claims and dispatch already allow
  it), lease renewal, partition history tables, move parsed text and raw model
  I/O to object storage, per-tenant queue fairness.
