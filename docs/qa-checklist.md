# QA against the take-home brief

Status: **Done** (verified, evidence named) · **Partial** · **Not done**.
"Live" = checked against a running `docker compose up` stack in this session;
"test" = automated test in the repo.

## Flagged — not done or open to challenge

| # | Item | Status | What is true |
| --- | --- | --- | --- |
| F1 | Agent session logs as a **public gist** | **Not done by the agent** | No tool here can create a gist. Sanitized summaries are in `docs/sessions/`. The brief asks for the *raw* log (JSONL or `/export`): export it yourself, redact, then publish (command in the final report). Raw JSONL is not and must not be committed. |
| F2 | "Send it to an LLM … structured output" | **Partial — a judgement call to defend** | Default extraction is **Laya**, a local *decision* model: Lomi proposes verbatim candidates and Laya answers yes/no; output is typed and stored (prompt + raw response). It is a language model, but not a generative one with a JSON schema. The generative, structured-output path (Anthropic) exists per tenant but is **untested against the live API** (no key). A reviewer reading the brief literally may count this as a deviation. |
| F3 | Extraction accuracy | **Partial** | 16/16 fields correct on the four fixtures, but field instructions for `vendor_name`, `total_amount`, `vacancy_rate`, `average_rent_1br` were written after seeing those documents, and wording matters ("vendor name" picked "Ergonomic"). Not evidence of general accuracy. |
| F4 | Deployed link | **Not done** (optional) | — |
| F5 | Video walkthrough | **Not done** (optional) | — |
| F6 | First `docker compose up` | **Partial** | Needs network: npm, images, and the Laya model from Hugging Face. Rate limiting (seen once, HTTP 429) is retried 4×; if it still fails the stack starts and documents fail **visibly** until `docker compose run --rm models` + Retry. App image ≈1.2 GB. |
| F7 | Restart mid-extraction recovery time | **Done, with a delay** | Work is never lost, but an interrupted job is re-run only after its 60 s lease expires. Leases are not renewed (a job over 60 s could run twice; the second commit wins, the first writes nothing). |
| F8 | Extraction speed | **Note** | ~15–20 s per document on CPU (Laya). Upload itself returns in ~40 ms. |
| F9 | Token-less `curl` | **Dev-only** | Works because `LOMI_DEV_DEFAULT_TOKEN` is set in compose. Remove for any shared deployment. |
| F10 | Evidence highlight | **Partial** | Highlights are per text line, not per word. |
| F11 | Document-type detection | **Not done** | Caller names the type; a wrong type produces a "check document type" warning (≥ half gaps), not a correction. |

## Requirements

| Brief requirement | Status | Evidence |
| --- | --- | --- |
| Turborepo monorepo, real pipeline | Done | `turbo.json` (`build`→`^build`, test/lint/typecheck); CI `.github/workflows/ci.yml` |
| One `docker compose up` starts everything | Done (see F6) | Live: clean volumes → seeded and extracted in ~75 s (model cached) |
| Migrations run on start | Done | `migrate` one-shot; migration 001→002 upgrade verified on data |
| Seeds **only version 1** of the fixtures | Done | `seed/seed.ts` (`documents.json` v1 entries); `invoice-001.v2.pdf` is not seeded |
| `POST /documents` (multipart `type`+`file`) | Done | Live `brief-check.sh`; test `brief.test.ts` |
| `POST /documents/:id/versions` | Done | Live: answered in 41 ms |
| `GET /documents/:id` with values, evidence, status | Done | test `brief.test.ts`; OpenAPI |
| `POST /values/:id/review` approve / correct + note | Done | tests `api.test.ts`, `brief.test.ts` |
| `GET /documents/:id/progress` counts pending/approved/corrected/carried-over | Done | returns `counts` (+ gaps) |
| Status `queued \| extracting \| extracted \| failed` | Done | REST `status`; richer lifecycle in `reviewStatus` |
| PostgreSQL system of record | Done | everything durable incl. job state; Redis holds wake-ups only |
| Redis-backed queue | Done | BullMQ + transactional outbox |
| Upload instant (no extraction in request) | Done | 202 after one transaction; immediate publish after commit |
| Restart mid-extraction loses nothing, never stuck | Done (F7) | Live: attempt 1 abandoned, attempt 2 succeeded; test `durability.test.ts` |
| No duplicate values on re-extraction | Done | unique (version, field) + lease-checked commit; test (3 concurrent deliveries → 1) |
| Failure is a visible, retryable state | Done | `failed` + reason; `POST /documents/:id/retry`; Retry button |
| Redis FLUSHALL safe | Done | Live: values/reviews/jobs 36/8/7 before = after; new upload extracted; 0 stuck |
| Evidence verbatim, checked against version N text | Done | `docops/evidence.ts`; per-version parsed text; tests |
| Not verbatim → gap with `value: null` and reason | Done | model's claim kept for the reviewer; tests |
| Fields absent from document → gaps | Done | `median_household_income` seeded as gap |
| Prompt and raw LLM response stored | Done | `model_calls` table, shown in provenance |
| Re-extraction: unchanged keeps review (carried over) | Done | Live: 3 carried over |
| Changed → pending with previous value/review shown | Done | Live: exactly `due_date` (2025-10-14→2025-11-13) and `total_amount` (5230.29→6126.45) |
| Nothing deleted | Done | append-only triggers on decisions, evidence, validations, submissions, audit |
| New version while extracting — decision documented | Done | supersede (README §5); live: v1 processed, v2 superseded, v3 processed |
| "Unchanged" robust to text shifting | Done | fingerprint ignores position; revised fixture shifts text |
| Review UI: list with status / version / progress | Done | Documents page; extraction column |
| Detail: value beside quote | Done | Evidence view; Original vs Evidence toggle |
| Approve / correct with value + optional note | Done | UI + API |
| Gaps visible | Done | marked, reviewer must supply or confirm |
| Carried-over distinguishable, previous values shown | Done | badges; previous value + decision on reopened fields |
| Polling vs streaming explained | Done | README §5 |
| Duplicates / re-sends clearly identified | Done | list tags `re-sent ×N`, `revised · vN`, `possible duplicate`; banner; Receipts tab; API `receipts`, `receiptLog` |
| Tests | Done | core 58, docops 19, pdf 49, web 4, api 48 (latest run in the final report) |
| README sections (run, layout, schema, coordination, decisions, cut, 10k) | Done | `README.md` |

## Beyond the brief (requested in this project)

Tenant URL ingress (`/in/{tenant}`, API/single/bulk), submitter role, OpenAPI
3.1 (`/api/docs`), AppPort capabilities + MCP for agents (agents cannot
approve), Schema Studio, operator console with customer dropdown and "Add a
customer" first, auto-advance to the next reviewable document, multi-tenant RLS,
explicit tenant authorization before any content goes to an external model.
