# Evaluation: document parsers, and the take-home as a submission (Nov 2026)

## 1. Do these parsers solve any of our challenges?

Our open challenges, from what the system can and cannot do today:

1. **Scanned submissions** are not read: the server parses the PDF text layer only (pdfjs). An image-only PDF yields no text, so position-read fields are gaps and layout identification fails.
2. **Box detection runs only in the browser** (coordtool needs a rendered page), so form setup cannot be an API/agent capability.
3. **Fillable-form values**: solved this cycle (parser `text-2`).
4. **Layout-varying documents** are read by Laya over the text layer; tables and complex layouts are weak spots.

Hands-on results (installed and run against our fixtures, our onboarding form, a fillable copy and a 150 dpi scan; CPU only, no GPU):

| | Positions per text item | Fillable values | Scanned PDF, CPU, offline | Structure | Fits our stack |
| --- | --- | --- | --- | --- | --- |
| **@llamaindex/liteparse** (native, Apache-2.0) | yes — points, **top-left** origin | yes, with field rects | yes once models are local: Tesseract 0.23 s/page, ocria-nano 0.6 s; **default downloads tessdata from GitHub on first OCR, and an OCR failure is fatal** | vector shapes (our printed boxes come back as rectangles), lines, markdown tables | Node addon, 66 MB; works in a worker thread |
| **@llamaindex/liteparse-wasm** (Apache-2.0) | same | yes | yes with ocria-nano bytes bundled: 1.3–2 s/page; OCR off by default | same | pure WASM, 22 MB, no native build; worker thread OK |
| **edgeparse** 0.3.2 (pip) | per block only, bottom-left | **no** | **no** (output was one image element; rapidocr route returned empty after 55–80 s) | headings/lists/tables, errors seen (amounts mangled, lease clauses dropped in text mode) | Python sidecar |
| **dots.ocr** (MIT; read from its docs, not run: needs a GPU) | layout boxes `[x1,y1,x2,y2]`, coordinate space not stated; no form fields/checkboxes | not stated | VLM (1.7B LLM, ~3B total), vLLM/CUDA; no CPU numbers; known repeat-forever failures on `....`/`____` | layout categories, reading order, tables as HTML, formulas as LaTeX | GPU inference service |

**Recommendation**

- **Adopt liteparse-wasm as a second format adapter, for image-only pages only.** It closes challenge 1 inside the existing worker (no GPU, no sidecar, offline with the model bytes vendored in the image), and its output is the same kind of thing we already store: positioned text in points. Keep pdfjs for pages with a text layer, so evidence offsets and stored parses stay reproducible. Convert y to our bottom-left origin (`y = pageHeight − y − height`), record the parser id per version, and treat OCR text as lower-confidence evidence (review required). Pin the model; never let it download at runtime.
- **Use liteparse's vector graphics for challenge 2** (server-side box location for digital PDFs: printed rectangles come back directly, no rendering). Browser coordtool stays the tool for correcting boxes and for scans.
- **Not edgeparse**: no per-item positions, no fillable values, no scan OCR in practice, content loss.
- **Not dots.ocr now**: it does layout and OCR well on paper, but it is a GPU service, has no form-field concept, and documented generation failures on dotted/underscored lines, which are common on forms. Reconsider for high-volume scanned, table-heavy documents if a GPU budget exists; it would sit behind the same adapter boundary.

Not done: none of these is integrated yet. The steps above are the proposed next change.

## 2. Is this a sufficient take-home submission?

The brief: a system that processes customers' PDFs, extracts fields with evidence, recognizes issues, supports review and revisions, and is durable. Assessed against `docs/qa-checklist.md`.

**Strong (evidence in tests and live checks)**
- Every listed requirement is implemented and verified: brief REST contract, instant durable uploads, PostgreSQL as system of record with an outbox, Redis loss and mid-extraction restarts lose nothing, no duplicate values, visible retryable failures.
- Evidence is verified verbatim against the version's own text; unverifiable claims become gaps that keep the model's claim; prompts and raw responses are stored.
- Revisions re-open exactly the changed fields (live: 2 of 5), with carry-over that is robust to text shifting.
- **Recognizing issues** is broad and demonstrable (the demo workload loads all of them): failed cross-field checks (totals, date order), range limits, required gaps, possible duplicates, identical re-sends, unreadable files, documents no form describes, wrong-type warnings, model checks flagged for review.
- 207 automated tests, including real-model tests; CI; README written for an engineer joining.

**Risks a reviewer is likely to raise**
1. **"Send it to an LLM with structured output" (F2).** Default extraction is Laya, a local *decision* model choosing among verbatim candidates. Defensible and documented, but literal-minded graders may count it as a deviation; the generative structured-output path (Anthropic) has never been run against the live API. Cheapest fix: one recorded run with a key, and a test.
2. **Scope and focus.** The repository now includes multi-tenancy with RLS, AppPort/MCP, Schema Studio, coordtool fixed-layout forms, team management and a demo generator. Reviewers usually reward judgement about what *not* to build. Mitigation: a short "reviewer path" at the top of the README (the brief's core in 10 minutes) and an explicit list of extras.
3. **Accuracy evidence is thin (F3)**: 16/16 on four fixtures, with instructions tuned after seeing them.
4. **Scanned PDFs are not handled** server-side (see §1). For "processes PDFs for customers", this is the most visible functional gap.
5. **Operational rough edges**: first start downloads the model (rate limits seen once); ~15–20 s per document on CPU for Laya-read types; job leases are not renewed (F7).
6. **Deliverables**: the raw session logs as a public gist (F1) are not done; deployed link and video (optional) not done.

**Verdict.** Sufficient on the stated requirements, and strong on durability, evidence and issue recognition — the things that are hard to fake. It is not yet the best possible submission: fix F2 with a recorded run, publish the session logs, and add the reviewer path so the breadth reads as deliberate rather than sprawling. Scanned-PDF support (liteparse-wasm) would remove the most obvious functional gap.
