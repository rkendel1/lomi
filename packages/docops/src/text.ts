import type { EvidenceBox, ParsedDocument, ParsedPage, VerifiedEvidence } from './types';

/**
 * Whitespace is the only thing normalized when verifying quotes. PDF text
 * extraction does not preserve spacing faithfully (line breaks, runs of
 * spaces, item boundaries), so a verbatim quote is compared after collapsing
 * whitespace. Case, punctuation and characters are compared exactly.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface IndexedText {
  text: string;
  /** For each character of `text`, the source item index, or -1 for separators. */
  itemIndex: number[];
}

/** Build whitespace-normalized page text with a map back to the PDF text items. */
export function indexPageText(page: ParsedPage): IndexedText {
  const raw: string[] = [];
  const rawIndex: number[] = [];
  page.items.forEach((item, index) => {
    for (const ch of item.str) {
      raw.push(ch);
      rawIndex.push(index);
    }
    raw.push(item.eol ? '\n' : ' ');
    rawIndex.push(-1);
  });

  let text = '';
  const itemIndex: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      itemIndex.push(-1);
      pendingSpace = false;
    }
    text += ch;
    itemIndex.push(rawIndex[i]);
  }
  return { text, itemIndex };
}

export function pageText(page: ParsedPage): string {
  return indexPageText(page).text;
}

export function documentText(document: ParsedDocument): string {
  return document.pages.map((page) => `--- page ${page.pageIndex + 1} ---\n${pageText(page)}`).join('\n');
}

function boxForRange(page: ParsedPage, indexed: IndexedText, start: number, end: number): EvidenceBox | undefined {
  const items = new Set<number>();
  for (let i = start; i < end; i++) {
    const idx = indexed.itemIndex[i];
    if (idx >= 0) items.add(idx);
  }
  if (items.size === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const idx of items) {
    const item = page.items[idx];
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export type QuoteVerification =
  | { verified: true; evidence: VerifiedEvidence }
  | { verified: false; reason: string };

/**
 * Confirm a quote exists in the parsed document. The hinted page is searched
 * first; a quote found only on another page is still verified, on that page.
 */
export function verifyQuote(
  document: ParsedDocument,
  quote: string | null | undefined,
  pageHint?: number | null
): QuoteVerification {
  const needle = normalizeWhitespace(quote ?? '');
  if (!needle) return { verified: false, reason: 'No supporting quote was provided.' };

  const order = [...document.pages].sort((a, b) => {
    if (a.pageIndex === pageHint) return -1;
    if (b.pageIndex === pageHint) return 1;
    return a.pageIndex - b.pageIndex;
  });

  for (const page of order) {
    const indexed = indexPageText(page);
    const start = indexed.text.indexOf(needle);
    if (start >= 0) {
      const end = start + needle.length;
      return {
        verified: true,
        evidence: { page: page.pageIndex, quote: needle, start, end, box: boxForRange(page, indexed, start, end) },
      };
    }
  }
  return {
    verified: false,
    reason: 'The supporting quote does not appear verbatim in the document text.',
  };
}
