import type { ParsedPage } from './types';
import { normalizeWhitespace } from './text';

/**
 * Deterministic candidate generation for decision-model extraction.
 *
 * A decision model cannot write text; it can only choose. So the document is
 * split into passages and each passage into typed value candidates, all taken
 * verbatim from the parsed text. The model then answers yes/no questions about
 * them. Whatever it picks is document text by construction, and is still
 * verified against the version's text afterwards like any other extraction.
 */

export type ValueType = 'string' | 'date' | 'money' | 'number' | 'percent';

/** Lines as laid out in the PDF (text items up to each end-of-line). */
export function pageLines(page: ParsedPage): string[] {
  const lines: string[] = [];
  let current = '';
  // Items are joined with a space, exactly as the evidence verifier builds page text,
  // so every passage is guaranteed to be found verbatim (after whitespace collapsing).
  for (const item of page.items) {
    current += `${item.str} `;
    if (item.eol) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines.map(normalizeWhitespace).filter(Boolean);
}

/**
 * Passages: short label/heading lines stay on their own; wrapped prose lines are
 * joined and split into sentences, so a passage is one statement.
 */
export function passages(page: ParsedPage): string[] {
  const out: string[] = [];
  let prose = '';
  const flush = () => {
    if (prose) out.push(...prose.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/));
    prose = '';
  };
  for (const line of pageLines(page)) {
    const isProse = line.length > 45 && (line.match(/\b[a-z]{3,}\b/g) ?? []).length >= 4;
    if (isProse) prose += (prose ? ' ' : '') + line;
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.map(normalizeWhitespace).filter((p) => p && !/^[-=_.\s]{5,}$/.test(p));
}

const PATTERNS: Record<ValueType, RegExp> = {
  money: /[$€£]\s?\d[\d,]*(?:\.\d{2})?/g,
  date: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g,
  percent: /\b\d+(?:\.\d+)?%/g,
  number: /\(\d+(?:\.\d+)?\)|\b\d+(?:\.\d+)?\b/g,
  string: /(?:[A-Z][A-Za-z0-9&.'-]*|[A-Z0-9]+-[A-Z0-9-]+|Q[1-4])(?:\s+(?:[A-Z0-9][A-Za-z0-9&.'-]*))*/g,
};

const STOP = new Set(['the', 'this', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'is', 'are', 'upon', 'unless', 'no', 'one', 'two', 'please', 'payments']);

/**
 * Typed value candidates inside a passage. The label of a "Label: value"
 * passage is never offered as a value, nor are lone common words or words that
 * merely repeat the field's own name.
 */
export function valueCandidates(passage: string, type: ValueType, fieldLabel: string): string[] {
  const labelled = passage.match(/^([A-Z][A-Za-z ()%.0-9]{1,40}):\s*(.+)$/);
  const body = labelled ? labelled[2] : passage;
  const found = new Set<string>();
  if (type === 'string' && labelled) found.add(labelled[2].trim());
  for (const m of body.matchAll(PATTERNS[type])) found.add(m[0].replace(/^\((.+)\)$/, '$1').trim());
  const labelWords = new Set(fieldLabel.toLowerCase().split(/\s+/));
  const bare = (w: string) => w.toLowerCase().replace(/[^a-z]/g, '');
  return [...found].filter((c) => {
    if (!c) return false;
    if (type !== 'string') return true;
    return !c.split(/\s+/).every((w) => STOP.has(bare(w)) || labelWords.has(bare(w)));
  });
}
