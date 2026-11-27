import { describe, expect, it } from 'vitest';
import type { Field } from '@lomi/core';
import { extractByRegion, layoutFingerprint, layoutMatch, printedTextInBox, runExtraction, type ParsedDocument, type TextItem } from '../index';

const label = (str: string, x: number, y: number): TextItem => ({ str, x, y, width: str.length * 5, height: 10 });

/** A two-row form: labels on the left, boxes at x 218–518. */
function form(values: TextItem[] = [], hints: TextItem[] = []): ParsedDocument {
  return {
    pageCount: 1,
    parser: 'test',
    pages: [{ pageIndex: 0, width: 612, height: 792, items: [label('ACME Supplier Onboarding', 56, 740), label('Company name', 56, 703), label('Start date', 56, 673), label('Annual spend', 56, 643), ...hints, ...values] }],
  };
}

function f(key: string, y: number, extra: Partial<Field> = {}): Field {
  return {
    id: key, name: key, sourceFieldId: key, semanticKey: `onboarding.${key}`, displayLabel: key, page: 0,
    x: 218, y, width: 300, height: 18, type: 'text', extraction: { method: 'region' }, ...extra,
  };
}

const name = f('company_name', 698);
const date = f('start_date', 668, { type: 'date', extraction: { method: 'region', exclude: ['mm/dd/yyyy'] } });
const spend = f('annual_spend', 638, { type: 'currency' });

describe('region extraction (fixed-layout forms)', () => {
  it('reads each value from its own box and normalizes it by type', async () => {
    const filled = form([label('Northwind Traders', 222, 703), label('03/01/2026', 222, 673), label('$12,500.00', 222, 643)], [label('MM/DD/YYYY', 400, 673)]);
    const out = await runExtraction(filled, { fields: [name, date, spend] }, null);
    expect(out.fields.map((x) => [x.semanticKey, x.method, x.normalizedValue])).toEqual([
      ['onboarding.company_name', 'region', 'Northwind Traders'],
      ['onboarding.start_date', 'region', '2026-03-01'],
      ['onboarding.annual_spend', 'region', '12500.00'],
    ]);
    expect(out.fields[1].evidence).toMatchObject({ page: 0, quote: '03/01/2026', box: { x: 218, y: 668, width: 300, height: 18 } });
    expect(out.fields[0].confidenceSource).toBe('deterministic_match');
    expect(out.modelCalls).toEqual([]);
  });

  it('never takes the printed label beside the box, or printed hints inside it', () => {
    const blank = form([], [label('MM/DD/YYYY', 400, 673)]);
    expect(extractByRegion(blank, date)).toMatchObject({ value: null, gapReason: expect.stringMatching(/empty/) });
    expect(extractByRegion(blank, name).value).toBeNull();
  });

  it('turns unreadable text into a gap that keeps what was there', () => {
    const r = extractByRegion(form([label('next spring', 222, 673)]), date);
    expect(r).toMatchObject({ value: null, gapReason: expect.stringMatching(/could not be read/), unverified: { value: 'next spring' } });
  });

  it('reads fillable-field values and checkboxes', () => {
    const agree = f('agree', 640, { type: 'checkbox', width: 12, height: 12 });
    const filled = form([{ ...label('Northwind', 220, 701), source: 'form_field' }, { ...label('X', 220, 642), source: 'form_field' }]);
    expect(extractByRegion(filled, name).normalizedValue).toBe('Northwind');
    expect(extractByRegion(filled, agree)).toMatchObject({ normalizedValue: 'true' });
    expect(extractByRegion(form(), agree)).toMatchObject({ normalizedValue: 'false', gapReason: null });
  });

  it('records printed hints inside a box on the blank form', () => {
    expect(printedTextInBox(form([], [label('MM/DD/YYYY', 400, 673)]).pages[0], date)).toEqual(['mm/dd/yyyy']);
  });
});

describe('layout fingerprint', () => {
  const layout = layoutFingerprint(form(), [name, date, spend]);

  it('anchors on printed labels outside the field boxes', () => {
    expect(layout.anchors.map((a) => a.text)).toEqual(['ACME Supplier Onboarding', 'Company name', 'Start date', 'Annual spend']);
  });

  it('matches a filled copy of the same form and not a different document', () => {
    expect(layoutMatch(form([label('Northwind', 222, 703)]), layout).score).toBe(1);
    const other: ParsedDocument = { pageCount: 1, parser: 't', pages: [{ pageIndex: 0, width: 612, height: 792, items: [label('Invoice', 56, 740), label('Company name', 300, 500)] }] };
    expect(layoutMatch(other, layout).score).toBe(0);
    expect(layoutMatch(form(), undefined).score).toBe(0);
  });
});
