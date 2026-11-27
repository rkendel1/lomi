# Session 06 — Evaluations, mobile, coordtool header, demo workload

## Asked
1. Evaluate dots.ocr, @llamaindex/liteparse, @llamaindex/liteparse-wasm and edgeparse against our challenges.
2. Evaluate whether this is a sufficient take-home submission.
3. Make every view usable on a phone.
4. (Mid-session) The coordtool (mapper) header is messed up on the documents page.
5. (Mid-session) A large demo seed, loaded by a button in the operator profile.

## Done
- Parsers: liteparse, liteparse-wasm and edgeparse installed and run on our fixtures, forms, a fillable form and a scan (outside the repo); dots.ocr assessed from its documentation (needs a GPU). Findings and recommendation: `docs/evaluation-2026-11.md`.
- Take-home assessment in the same document; QA checklist updated (F11 done; F12 scans; F13 mobile; F14 demo).
- Mobile: before, every signed-in view scrolled sideways (up to 2.8× the screen) and the review screen squeezed the document into a sliver. Now: a two-row header with a swipeable nav, lists as labelled cards, analytic tables scrolling inside their card, review first with a *Show on page ↓* jump to the highlighted evidence, 44 px touch targets, 16 px inputs, visible focus rings, pointer events in the viewer so touch draws boxes in the mapper. Verified with Playwright on the iPhone 13 profile: no horizontal overflow on any view; tap-to-approve, upload, and touch drawing work.
- Mapper header: inside *Capture more* / *Map into a form* / *New form from PDF* the full coordtool toolbar (grid, OCR, auto-detect, debug, preview) wrapped into four rows on phones and the PDF was clipped on desktop. Those flows now use a minimal toolbar (draw as, show fields) and the mapper sizes to the viewport.
- Demo workload (`seed/demo.ts`, `demo.load` / `demo.status`, Operations card): two demo customers, demo submitter and reviewer, invoice/lease/supplier-onboarding forms, ~140 documents through the real intake (API, upload, bulk), processed by the worker; then approvals, outputs, revisions and re-sends. Gated to demo deployments (`LOMI_DEMO=1`, or on with `LOMI_DEV_LOGIN=1`). Live: 140 documents processed in 52 s. Operations figures refresh live while it runs.

## Problems found and fixed
- The demo panel's callback was re-created every render and would have caused a polling loop; held in a ref.
- Operations KPIs did not refresh after the demo; the panel now refreshes them during and after the run.

## Limits
- The demo run lives in the API process: a restart mid-run keeps what was submitted but skips the later steps.
- Demo forms leave out model-based semantic checks, so the demo works offline; type identification of untyped documents still uses layout, then Laya.
- Drawing precise boxes on a phone works but is cramped; form setup is still best on a larger screen.
