# Architecture Inventory (pre-change)

Recorded on 2026-11-26 by inspecting the working tree at commit `55dceaf`
before any Lomi Document Operations work began. Everything below was observed
directly (files read, `pnpm build/test/lint/typecheck` run), not inferred from
the existing README.

## Baseline health

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | OK (pnpm 10.17.0, Node 22) |
| `pnpm build` | 4/4 tasks OK |
| `pnpm test` | 110 tests pass (core 58, pdf 46, api 4, web 2) |
| `pnpm lint` / `pnpm typecheck` | OK |

## What exists

| Area | Where | What it actually is |
| --- | --- | --- |
| Workspace | `pnpm-workspace.yaml` | `apps/*`, `packages/*` |
| Pipeline | `turbo.json` | `build` (^build), `test` (^build), `lint`, `typecheck`, `dev` (persistent) |
| Docker | `docker-compose.yml`, `apps/*/Dockerfile` | two services: `api` (node:22-alpine, port 4000) and `web` (nginx serving Vite build, proxying `/api`) |
| CI | `.github/workflows/ci.yml` | install → lint → typecheck → test → build |
| `@lomi/core` | `packages/core` | Pure domain: `Field` model (13 field types, semantic keys, cardinality, semantic data type, transforms, presentation), schema artifact generators (`generateLayout`, `generateMapping`, `generateTransforms`, `generateTables`, `generateValidation`, `generateDocumentSchema`), semantic-key normalisation, field inference, coordinate helpers, ruled-cell region detection, OCR label helpers |
| `@lomi/pdf` | `packages/pdf` | `pdf-lib` renderer (`renderPdf`): mapping resolution, transforms/formatters, text wrap + overflow, checkbox styles, tables, page calibration offsets; `FormRegistry` + `generateForm(s)` |
| `@lomi/web` | `apps/web` | React 19 + Vite. `PDFViewer` (PDF.js canvas + overlay, draw-to-map, AcroForm/native detection, ruled-cell detection, Tesseract OCR), `FieldEditor`, `FieldList`, `PreviewPanel` (local + server render), `ExportPanel`/`ImportPanel` (JSON/ZIP artifacts). All state is in-memory React state. |
| `@lomi/api` | `apps/api` | Dependency-free `node:http` server: `GET /api/health`, `POST /api/render` (stateless render of a supplied template + artifacts) |
| Persistence | — | **None.** No database, no object storage, no queue. |
| Auth / tenancy | — | **None.** |
| Server-side PDF text parsing | — | **None.** Text extraction exists only in the browser (`pdfjs-dist` `getTextContent` in `App.tsx`/`PDFViewer.tsx`). |
| AppPort | — | Not referenced in this repo. It is published on npm as `@appport/*` (core 1.13.0, server 1.5.0, mcp 1.5.0, authorization 1.4.0, schema 1.2.2, protocol 1.8.0). Provider API confirmed from the published `.d.ts`/READMEs: `createApplication`, `defineCapability`, `permissionAuthorizer`/`combineAuthorizers`/`authorizerFrom`, `handleRequest(request, { session, principal })`, `createServer` + `serve`/`createFetchHandler`, `createMcpHandler`. |

Coordinate convention (important for evidence highlighting): `Field.x/y/width/height`
are PDF user-space points with a bottom-left origin; `PDFViewer` converts them with
`viewport.convertToViewportRectangle`. PDF.js text items expose the same space via
their `transform`, so evidence boxes can be drawn by the existing overlay code.

## Reuse / extend / build

| Need | Decision |
| --- | --- |
| PDF viewing, page nav, overlays | **Reuse** `PDFViewer`; extend with a read-only mode + highlight boxes for evidence |
| Visual mapping, field editor | **Reuse** in Schema Studio; extend `Field` with optional extraction / validation / review-policy metadata and expose it in `FieldEditor` |
| Schema artifacts | **Reuse** `generateLayout/Mapping/Transforms/Tables` to turn a template version's fields into render inputs |
| Rendering generated documents | **Reuse** `renderPdf`; extend with a deterministic-metadata option so outputs are byte-reproducible |
| Formatters / transforms | **Reuse** `applyFormatter` for normalisation where it fits |
| Server-side PDF text | **Extend** `@lomi/pdf` with a Node text extractor built on the `pdfjs-dist` already used by the web app (no new PDF library) |
| HTTP server | **Extend** the existing `apps/api` `node:http` server (no framework swap) |
| Docker / Turbo / pnpm / CI | **Extend**: add Postgres, Redis, worker, volume; add DB-backed test env to CI |
| Tenancy, auth, persistence, queue, outbox, review, provenance, extraction, validation | **Build** (nothing exists) |
| Capability/authorization boundary + MCP | **Integrate** the published AppPort packages; do not hand-roll one |

## Gaps that are genuinely new work

1. PostgreSQL domain model + migrations (tenants, templates, documents, versions, values, evidence, validations, reviews, jobs, outbox, generated docs, audit).
2. Object storage abstraction (filesystem on a Docker volume for local; content-addressed).
3. Outbox → BullMQ dispatcher, idempotent leased workers, reconciler for Redis loss / crashed workers.
4. Extraction provider interface (deterministic pattern extractor, LLM provider, test mock), evidence verification, deterministic + semantic validation.
5. Review, correction, carry-over, duplicate detection.
6. Customer portal, operator console, Schema Studio persistence.
