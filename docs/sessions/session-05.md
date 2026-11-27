# Session 05 — Fixed-layout forms with coordtool: locate, identify, extract, normalize, extend

Sanitized engineering log of the fifth coding-agent session (Claude Code, cloud sandbox).

## Asked

1. The new form capability must use coordtool to identify and locate the form
   and its data, and normalize it per customer, form and element ("an ETL layer
   for ingress").
2. (Mid-session) Unrecognized documents are mapped into existing forms, whose
   schema can be extended with elements the current version does not capture.

## Found

- coordtool's field location ran only in the browser mapper, one page at a time,
  and its fields had no extraction setting: nothing read values from those
  boxes. Extraction was `pattern` or `llm` only.
- Values typed into fillable PDFs were invisible to the parser (they live in
  widgets, not page text).
- coordtool's printed-box detector had a line-merging bug: it compared a line
  only with the last merged line, one-sided, so edges of stacked boxes on
  adjacent pixel columns chained into page-long phantom rules (17 slivers for a
  6-field form). It also dropped every empty label-left input box as "layout",
  dropped boxes with a printed hint, treated bold title strokes as character
  boxes, and skipped boxes that already held a value.
- In-browser OCR never worked: Tesseract's core loads its `.wasm` relative to the
  worker script, which was in another directory (the server answered with the
  HTML index). With default page segmentation it also dropped labels printed
  beside boxes.

## Built

- `region` extraction (docops): value = text inside the field's box; printed
  text in the box on the blank form is recorded at setup and ignored;
  checkboxes are true/false; evidence = text, offsets and the box.
- Parser `text-2`: fillable-field values added as positioned items.
- Layout fingerprint and matching: printed labels at positions; a document is
  identified when ≥ 80 % of a form's anchors are in place, before Laya.
- `templates.forms.import`: form from its PDF + located fields.
- `templates.fields.add`: new template version with added elements (located
  boxes or described fields), built on the open draft or latest published.
- `documents.reread`: the same file as the next document version, read with the
  latest form version; reviewed, unchanged values carry over.
- `records.list` + Documents → Records (CSV): one row per document, one column
  per element.
- Web: shared detection lib (`lib/formDetection.ts`, all pages) used by the
  mapper and the new flows; *From the form's PDF* in Schema Studio; *Map into a
  form* (unrecognized) and *Capture more…* (processed) on a document.
- coordtool fixes above, with regression tests; OCR assets moved next to the
  worker; OCR at 2x resolution with sparse-text segmentation.

## Verified

- All package tests pass with the real Laya model (206).
- Browser, live stack: a generated supplier-onboarding form → 6 fields located
  (was 17 slivers) → published; three untyped submissions: printed copy and
  fillable copy identified by layout, every element correct; a 2027 edition
  (different title, extra "Company website" box) not identified by layout
  (75 % in place) but by Laya; *Capture more…* found the website box, the form
  got v2, the document was re-read as version 2 with the website value; Records
  shows all three rows. A scanned (image-only) copy of the form: all 6 fields
  located via OCR. `scripts/ui-smoke.cjs` passes.

## Limits

- Scanned *submissions* are not read by position: the server has no OCR. Their
  boxes come back as gaps for a person to fill.
- A re-designed layout (boxes moved) is a new layout, not an extension; moving
  existing elements is not supported.
- A ticked checkbox is not re-detected on a filled copy (existing elements
  cover it).
- The mapper shows existing and new elements in the same colour; the panel
  lists which are new.
- Two fixed-layout forms whose anchors both match ≥ 80 % fall back to Laya.
