# Session 03 — Assignment fixtures, model extraction with Laya, brief contract, duplicates, QA

Sanitized engineering log of the third coding-agent session (Claude Code,
cloud sandbox), continuing from session 02. No secrets were used. Sandbox
paths, proxy details and tokens are omitted.

## Objective

1. "Create a new customer" first on the operator screen.
2. Merge the fixtures added on `main` (`packages/core/src/__tests__/fixtures`):
   they must pass at startup and be seeded.
3. Rewrite the README for an engineer joining, from the owner's dictated answers.
4. QA against the take-home brief; flag what is not done.
5. (Mid-session) Clearly identify duplicates and re-sends.

## Fixtures and extraction

The fixtures (an invoice and its revision, a lease excerpt, a market report
excerpt; 16 expected fields, one absent) have no fixed layout, so the
pattern templates from earlier sessions could not extract them. Earlier
guidance said Laya should only check already-extracted candidates; without an
Anthropic key, though, no model could extract at all, and the brief requires
model-based extraction. Decision (recorded in README §5): extraction by Laya as
a **decision** model — Lomi proposes verbatim candidates, Laya only answers
yes/no — so it cannot invent a value and evidence verification is unchanged.

Prototype accuracy on the 16 fixture fields, measured with the real model:

| Approach | Correct |
| --- | --- |
| Laya `choice` over candidates | 1/16 |
| yes/no score per candidate | 12/16 |
| + candidate filtering (labels, stop words) and passage × candidate joint score | 14/16 |
| + per-field plain-language instructions | 16/16 |

Caveat stated in the docs: instructions for four fields were written after
seeing these documents. In the product, one wording ("vendor name") picked the
word "Ergonomic"; "name of the company that issued the invoice" fixed it.
Repeated runs were deterministic.

Added: `packages/docops/src/candidates.ts` (passages, typed candidates),
`number` value kind, `apps/api/src/llm/layaExtraction.ts`, one shared Laya
session for extraction and semantic checks, `extraction` option `laya`,
templates generated from `expected-fields.json` (`seed/lomiFixtures.ts`),
seeding of version 1 only, seed exits non-zero if any document fails.

## Brief REST contract

`POST /documents` (multipart `type` + `file`), `POST /documents/:id/versions`,
`GET /documents/:id`, `POST /values/:id/review`, `GET /documents/:id/progress`
(with `counts`), all also without `/api`. REST `status` uses the brief's
`queued | extracting | extracted | failed`; the detailed lifecycle moved to
`reviewStatus`. Added `POST /documents/:id/retry` and a Retry button. Lease
default 60 s. Development-only default token so plain `curl` works.

## Duplicates and re-sends

List tags `re-sent ×N`, `revised · vN`, `possible duplicate`; a banner on the
document; a Receipts tab (first received / revised → version N / identical
re-send — not reprocessed, with channel); API `receipts` and `receiptLog`.

## Problems found and fixed

- Hugging Face rate limit (HTTP 429) during model install blocked the worker,
  which waited on the `models` service. `docker/install-models.sh` now retries
  4× and always exits 0, so documents fail visibly instead of the stack
  silently idling.
- e2e test expected `partially_reviewed` for a revision with only carried-over
  values; by design that is `awaiting_review`. Test corrected.
- A brief-scenario test mixed tenants; rewritten.

## Verified live (`scripts/brief-check.sh`, PASS)

- `POST /documents/:id/versions` answered in 41 ms.
- Revised invoice: exactly `due_date` (2025-10-14 → 2025-11-13) and
  `total_amount` (5230.29 → 6126.45) pending; 3 carried over.
- Two versions while extracting: v1 processed, v2 superseded, v3 processed.
- `docker compose restart` mid-extraction: attempt 1 abandoned, attempt 2
  succeeded, document extracted.
- Redis FLUSHALL + restart: values/reviews/succeeded jobs 36/8/7 before and
  after; new upload extracted; 0 versions stuck.
- Browser: duplicate banner, Receipts tab and badges correct; "Add a
  customer" first on Operations; no page errors.

## Open (see `docs/qa-checklist.md`)

Gist not published by the agent (no tool); Anthropic path untested live;
fixture accuracy not general evidence; no deploy link or video; first start
needs network for the model.
