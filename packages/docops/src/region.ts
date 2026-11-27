import type { Field } from '@lomi/core';
import { indexPageText, normalizeWhitespace } from './text';
import { normalizeValue } from './values';
import type { EvidenceBox, FieldExtraction, LayoutFingerprint, ParsedDocument, ParsedPage, TextItem } from './types';

/**
 * Positional (coordtool) extraction for fixed-layout forms. Coordinates are PDF
 * points with a bottom-left origin, the same space the mapper stores fields in
 * and the parser reports text in. Everything here is deterministic.
 */

/** How far outside its box a value's text may start (typed values often sit on or just over the line). */
const PAD = 3;
/** Position tolerance when matching printed anchors between the blank form and a filled one. */
const ANCHOR_TOLERANCE = 6;
const MAX_ANCHORS = 40;

type Box = { x: number; y: number; width: number; height: number };

/** The item's visual centre: x mid-width; y a third of the way up from the baseline. */
function centre(item: TextItem): { x: number; y: number } {
  return { x: item.x + item.width / 2, y: item.y + Math.max(item.height, 1) / 3 };
}

function inside(item: TextItem, box: Box, pad = PAD): boolean {
  const c = centre(item);
  return c.x >= box.x - pad && c.x <= box.x + box.width + pad && c.y >= box.y - pad && c.y <= box.y + box.height + pad;
}

const clean = (s: string) => normalizeWhitespace(s).toLowerCase();

/** Text printed inside a field's box on the blank form (e.g. "MM/DD/YYYY", "$"). Recorded at setup and ignored later. */
export function printedTextInBox(page: ParsedPage | undefined, box: Box): string[] {
  if (!page) return [];
  return [...new Set(page.items.filter((i) => i.source !== 'form_field' && i.str.trim() && inside(i, box, 0)).map((i) => clean(i.str)))];
}

/** Text items that are a value for `field`: inside its box, not printed form text. Content-stream order. */
export function itemsInField(page: ParsedPage, field: Pick<Field, 'x' | 'y' | 'width' | 'height' | 'extraction'>): number[] {
  const exclude = new Set((field.extraction?.exclude ?? []).map(clean));
  const out: number[] = [];
  page.items.forEach((item, index) => {
    if (!item.str.trim() || !inside(item, field)) return;
    if (item.source !== 'form_field' && exclude.has(clean(item.str))) return;
    // A fillable field with no value reports "Off" (checkbox) or nothing.
    if (item.source === 'form_field' && /^off$/i.test(item.str.trim())) return;
    out.push(index);
  });
  return out;
}

function gap(field: Field, reason: string): FieldExtraction {
  return {
    semanticKey: field.semanticKey, method: 'region', value: null, normalizedValue: null, evidence: null,
    confidence: null, confidenceSource: 'none', gapReason: reason,
  };
}

/**
 * Read one field by position. The value is the text inside the field's box;
 * the evidence is that text, its offsets in the page text, and the box itself.
 * Checkboxes are "true" when anything marks the box and "false" otherwise.
 */
export function extractByRegion(document: ParsedDocument, field: Field): FieldExtraction {
  const page = document.pages.find((p) => p.pageIndex === (field.page ?? 0));
  if (!page) return gap(field, `The document has no page ${(field.page ?? 0) + 1}; it may not be this form.`);
  const picked = itemsInField(page, field);
  const box: EvidenceBox = { x: field.x, y: field.y, width: field.width, height: field.height };

  if (field.type === 'checkbox') {
    if (!picked.length) {
      return { semanticKey: field.semanticKey, method: 'region', value: '', normalizedValue: 'false', evidence: null, confidence: 1, confidenceSource: 'deterministic_match', gapReason: null };
    }
  } else if (!picked.length) {
    return gap(field, 'The box for this field is empty on the document.');
  }

  const indexed = indexPageText(page);
  const spans = picked
    .map((idx) => {
      const start = indexed.itemIndex.indexOf(idx);
      const end = indexed.itemIndex.lastIndexOf(idx) + 1;
      return start >= 0 ? { start, end } : null;
    })
    .filter((s): s is { start: number; end: number } => s !== null);
  const value = normalizeWhitespace(picked.map((i) => page.items[i].str).join(' '));
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  // The quote is the page text the value occupies when contiguous; otherwise the value as read.
  const contiguous = spans.length > 0 && indexed.text.slice(start, end) === value;
  const evidence = { page: page.pageIndex, quote: value, start: contiguous ? start : (spans[0]?.start ?? 0), end: contiguous ? end : (spans[0]?.end ?? 0), box };

  if (field.type === 'checkbox') {
    return { semanticKey: field.semanticKey, method: 'region', value, normalizedValue: 'true', evidence, confidence: 1, confidenceSource: 'deterministic_match', gapReason: null };
  }
  const normalizedValue = normalizeValue(field, value);
  if (normalizedValue === null) {
    return { ...gap(field, `The text in the box, "${value}", could not be read as a ${field.dataType ?? field.type}.`), unverified: { value, quote: value, page: page.pageIndex } };
  }
  return { semanticKey: field.semanticKey, method: 'region', value, normalizedValue, evidence, confidence: 1, confidenceSource: 'deterministic_match', gapReason: null };
}

/**
 * Printed text that identifies a blank form by position: labels and headings,
 * not text inside any field box, spread over the form, at most 40.
 */
export function layoutFingerprint(blank: ParsedDocument, fields: Array<Pick<Field, 'page' | 'x' | 'y' | 'width' | 'height'>>): LayoutFingerprint {
  const candidates: LayoutFingerprint['anchors'] = [];
  for (const page of blank.pages) {
    const boxes = fields.filter((f) => (f.page ?? 0) === page.pageIndex);
    for (const item of page.items) {
      const text = normalizeWhitespace(item.str);
      if (item.source === 'form_field' || text.length < 3 || !/[a-z]{2}/i.test(text)) continue;
      if (boxes.some((b) => inside(item, b, 0))) continue;
      candidates.push({ page: page.pageIndex, text, x: Math.round(item.x * 10) / 10, y: Math.round(item.y * 10) / 10 });
    }
  }
  // Keep the first and spread the rest evenly, so a long form is sampled throughout.
  if (candidates.length <= MAX_ANCHORS) return { anchors: candidates };
  const step = candidates.length / MAX_ANCHORS;
  return { anchors: Array.from({ length: MAX_ANCHORS }, (_, i) => candidates[Math.floor(i * step)]) };
}

/** Share of a form's anchors printed at the same place in `document` (0–1). */
export function layoutMatch(document: ParsedDocument, layout: LayoutFingerprint | undefined): { score: number; matched: number; total: number } {
  const anchors = layout?.anchors ?? [];
  if (!anchors.length) return { score: 0, matched: 0, total: 0 };
  let matched = 0;
  for (const a of anchors) {
    const page = document.pages.find((p) => p.pageIndex === a.page);
    const want = clean(a.text);
    if (page?.items.some((i) => i.source !== 'form_field' && clean(i.str) === want && Math.abs(i.x - a.x) <= ANCHOR_TOLERANCE && Math.abs(i.y - a.y) <= ANCHOR_TOLERANCE)) matched++;
  }
  return { score: matched / anchors.length, matched, total: anchors.length };
}
