# Lomi — PDF Field Mapper Monorepo

A visual PDF form-mapping tool plus a schema-driven rendering engine, packaged as a
single **Turborepo** monorepo on **pnpm workspaces**.

The UI maps fields onto a PDF, exports versionable schema artifacts, and renders
filled PDFs either in the browser or through a small server API. The same domain
packages power both paths.

---

## Repository layout

```
.
├── apps/
│   ├── web/                 React + Vite UI (browser)
│   └── api/                 Node HTTP service (server-side PDF rendering)
├── packages/
│   ├── core/                Pure domain model, schema generation, field inference
│   ├── pdf/                 PDF rendering engine, formatters, form registry
│   └── config/              Shared TypeScript and flat ESLint configuration
├── turbo.json               Real task graph (build / test / lint / typecheck / dev)
├── pnpm-workspace.yaml
├── docker-compose.yml
└── package.json
```

### Where the boundaries are, and why

| Package | Owns | Must not depend on |
| --- | --- | --- |
| `@lomi/core` | `Field`/schema types, artifact generators (`layout`, `mapping`, `transforms`, `questions`, `validation`), field naming/inference, coordinates, grid snapping, ruled-cell detection, OCR label helpers | React, DOM APIs, `pdf-lib`, Tesseract, Node |
| `@lomi/pdf` | `pdf-lib` rendering, text wrapping/overflow, tables, checkboxes, formatters, form registry + generation orchestration | React, DOM, browser workers |
| `@lomi/config` | Base `tsconfig`, shared flat ESLint preset | Runtime code |
| `@lomi/web` | React components, PDF.js viewer, Tesseract worker, browser preview/download UX | Server code |
| `@lomi/api` | HTTP routing, payload validation, server-side rendering endpoint | React, browser APIs |

The dependency graph is acyclic:

```
config  (dev-only)
  ↑
core  ←  pdf
  ↑      ↑
  ├── web
  └── api
```

This split keeps the expensive/awkward browser concerns (PDF.js, Tesseract, canvas,
blob URLs) in `apps/web`, while the reusable document model and renderer stay
portable. `apps/api` reuses `core` + `pdf` unchanged, which is why the same schema
can be rendered in the browser or on the server.

---

## Task pipeline

`turbo.json` is the source of truth for the pipeline:

```json
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", "build/**"] },
    "test":      { "dependsOn": ["^build"], "outputs": [] },
    "lint":      { "dependsOn": ["^lint"],  "outputs": [] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "dev":       { "dependsOn": ["^build"], "persistent": true, "cache": false }
  }
}
```

- **build** compiles dependency packages first (`core` → `pdf` → `web`/`api`).
  Libraries/API emit ESM + `.d.ts` through `tsup`; the web app emits a Vite bundle.
- **test** builds workspace dependencies, then runs Vitest in every package.
- **lint** runs ESLint in every package; `^lint` keeps package order consistent.
- **typecheck** is a separate cached task so CI can fail on types without emitting.
- **dev** builds dependencies once, then starts the persistent Vite and API watchers.

Turbo caches task results keyed by inputs and package graph, so a second
`pnpm build`/`pnpm test`/`pnpm lint` is effectively instant.

---

## Quick start (local)

Requirements: Node 20+, Corepack/pnpm 10.

```bash
corepack enable
pnpm install
pnpm build          # build core, pdf, web, api
pnpm test           # 110 tests across core, pdf, api, web
pnpm lint
pnpm typecheck
```

Run both apps in development:

```bash
pnpm dev
```

- Web UI: <http://localhost:3000>
- API: <http://localhost:4000/api/health>

Vite proxies `/api` to the API service, so the browser code always uses relative
`/api/...` URLs in development and production.

### Useful commands

| Command | What it does |
| --- | --- |
| `pnpm build` | `turbo run build` across the graph |
| `pnpm test` | `turbo run test` across the graph |
| `pnpm lint` | `turbo run lint` |
| `pnpm typecheck` | `turbo run typecheck` |
| `pnpm dev` | persistent web + API dev servers |
| `pnpm --filter @lomi/core test` | test one package |
| `pnpm --filter @lomi/web build` | build one app and its dependencies |
| `pnpm docker:up` | `docker compose up --build` |
| `pnpm docker:down` | stop the stack |

---

## One-command Docker Compose

From the repository root:

```bash
docker compose up --build
```

That builds and starts:

| Service | Port | Purpose |
| --- | --- | --- |
| `web` | `3000` | nginx serving the built SPA and proxying `/api` |
| `api` | `4000` | Node service exposing health + server-side render |

Both services have health checks; `web` waits for `api` to become healthy. Open
<http://localhost:3000>. The preview panel's **Render via API** button exercises the
same-origin nginx proxy end to end.

```bash
docker compose ps
docker compose logs -f api
docker compose down
```

---

## API

### `GET /api/health`

```json
{ "status": "ok", "service": "lomi-api", "version": "0.1.0", "uptimeSeconds": 12 }
```

### `POST /api/render`

Accepts a base64 PDF template plus the generated schema artifacts and returns a
filled PDF (`application/pdf`).

```json
{
  "template": "<base64 PDF>",
  "layout": { "field_001": { "page": 0, "x": 100, "y": 700, "width": 200, "height": 14, "type": "text", "fontSize": 10, "maxWidth": 200 } },
  "mapping": {
    "artifactType": "field-mapping",
    "version": "1.0",
    "mappings": [
      { "id": "mapping_001", "semanticKey": "applicant.name", "binding": { "fieldId": "field_001", "sourceId": "applicantName" } }
    ]
  },
  "transforms": {},
  "data": { "applicant.name": "Ada Lovelace" }
}
```

The endpoint validates the body (20 MB limit, JSON shape, PDF header) and returns
`400`/`413`/`500` with a JSON error on failure.

---

## Product features

- Visual field mapping over a PDF canvas, with page navigation and persisted fields.
- OCR-assisted and AcroForm/native field detection (opt-in in the UI).
- Schema artifacts: layout, mapping, transforms, questions, validation, manifest.
- Field types: text, multiline, checkbox, date/DOB, currency, phone, SSN, EIN, ZIP,
  signature, initials, table.
- Schema-driven rendering: text wrapping, overflow strategies, tables, checkbox
  styles, page calibration offsets.
- Preview mode with sample data, plus optional server-side rendering.
- Export individual JSON artifacts or a complete ZIP bundle.

More detail: [FEATURES.md](FEATURES.md), [IMPLEMENTATION.md](IMPLEMENTATION.md),
[SUMMARY.md](SUMMARY.md), and [schemas/README.md](schemas/README.md).

---

## Testing

- `packages/core` — 58 tests (schema generation, naming, inference, detection, coordinates).
- `packages/pdf` — 46 tests (formatters, renderer, registry, preview PDF generation).
- `apps/api` — 4 tests (health, render, validation, 404).
- `apps/web` — 2 component tests (initial render/uploader).

Run everything with `pnpm test`; Turbo builds `core`/`pdf` first so cross-package
imports resolve to fresh `dist` output.

---

## License

MIT
