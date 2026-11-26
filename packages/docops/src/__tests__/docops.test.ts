import { describe, expect, it } from 'vitest';
import type { Field } from '@lomi/core';
import {
  decideCarryOver,
  decideDisposition,
  evidenceFingerprint,
  interpretationHash,
  normalizeValue,
  parseAmount,
  parseDate,
  processDocument,
  ProviderNotReadyError,
  runExtraction,
  verifyQuote,
  type ExtractionProvider,
  type ParsedDocument,
  type SemanticValidator,
  type TemplateDefinition,
} from '../index';

function doc(...pages: string[][]): ParsedDocument {
  return {
    pageCount: pages.length,
    parser: 'test',
    pages: pages.map((lines, pageIndex) => ({
      pageIndex,
      width: 612,
      height: 792,
      items: lines.map((str, i) => ({ str, x: 50, y: 700 - i * 20, width: str.length * 6, height: 12, eol: true })),
    })),
  };
}

function field(semanticKey: string, extra: Partial<Field> = {}): Field {
  return {
    id: semanticKey,
    name: semanticKey,
    sourceFieldId: semanticKey.replace(/\./g, '_'),
    semanticKey,
    displayLabel: semanticKey,
    page: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 12,
    type: 'text',
    ...extra,
  };
}

const invoiceText = doc([
  'ACME Supplies Inc.',
  'Invoice Number: INV-1001',
  'Invoice Date: March 3, 2026',
  'Due Date:   April 2, 2026',
  'Subtotal: $1,000.00',
  'Tax: $80.00',
  'Total Due: $1,080.00',
]);

const template: TemplateDefinition = {
  fields: [
    field('invoice.number', { required: true, extraction: { method: 'pattern', pattern: 'Invoice Number: (\\S+)' } }),
    field('invoice.date', { type: 'date', required: true, extraction: { method: 'pattern', pattern: 'Invoice Date: ([A-Za-z]+ \\d{1,2}, \\d{4})' } }),
    field('invoice.due_date', { type: 'date', extraction: { method: 'pattern', pattern: 'Due Date: ([A-Za-z]+ \\d{1,2}, \\d{4})' } }),
    field('invoice.subtotal', { type: 'currency', extraction: { method: 'pattern', pattern: 'Subtotal: (\\$[\\d,.]+)' } }),
    field('invoice.tax', { type: 'currency', extraction: { method: 'pattern', pattern: 'Tax: (\\$[\\d,.]+)' } }),
    field('invoice.total', { type: 'currency', required: true, extraction: { method: 'pattern', pattern: 'Total Due: (\\$[\\d,.]+)' }, validationRules: [{ kind: 'range', min: 0, max: 50000 }] }),
    field('vendor.name', { required: true, extraction: { method: 'llm', instructions: 'Legal name of the issuing vendor' } }),
  ],
  crossFieldRules: [
    { id: 'totals', kind: 'sum', terms: ['invoice.subtotal', 'invoice.tax'], equals: 'invoice.total' },
    { id: 'dates', kind: 'date_order', earlier: 'invoice.date', later: 'invoice.due_date' },
  ],
};

function mockProvider(proposals: Array<{ semanticKey: string; value: string | null; quote: string | null; page: number | null; confidence?: number }>): ExtractionProvider {
  return {
    name: 'mock',
    external: false,
    readiness: async () => ({ ready: true, detail: 'ok' }),
    async extract() {
      return { proposals, model: 'mock-model', promptVersion: 'p1', prompt: 'PROMPT', rawResponse: JSON.stringify(proposals) };
    },
  };
}

describe('value parsing', () => {
  it('parses dates and amounts in common spellings', () => {
    expect(parseDate('March 3, 2026')).toBe('2026-03-03');
    expect(parseDate('03/04/2026')).toBe('2026-03-04');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseAmount('$1,080.00')).toBe(1080);
    expect(parseAmount('USD 3,000')).toBe(3000);
    expect(parseAmount('twelve')).toBeNull();
    expect(normalizeValue({ type: 'currency' }, '$1,080')).toBe('1080.00');
  });
});

describe('evidence verification', () => {
  it('verifies quotes after whitespace normalization only and returns a box', () => {
    const v = verifyQuote(invoiceText, 'Due Date: April 2, 2026', 0);
    expect(v.verified).toBe(true);
    if (v.verified) {
      expect(v.evidence.page).toBe(0);
      expect(v.evidence.box).toMatchObject({ x: 50, y: 640 });
    }
  });

  it('rejects quotes that differ in characters or case', () => {
    expect(verifyQuote(invoiceText, 'due date: April 2, 2026').verified).toBe(false);
    expect(verifyQuote(invoiceText, 'Total Due: $1,800.00').verified).toBe(false);
    expect(verifyQuote(invoiceText, '').verified).toBe(false);
  });
});

describe('extraction', () => {
  it('extracts pattern fields deterministically with verified evidence', async () => {
    const out = await runExtraction(invoiceText, template, mockProvider([{ semanticKey: 'vendor.name', value: 'ACME Supplies Inc.', quote: 'ACME Supplies Inc.', page: 0, confidence: 0.9 }]));
    const total = out.fields.find((f) => f.semanticKey === 'invoice.total')!;
    expect(total).toMatchObject({ value: '$1,080.00', normalizedValue: '1080.00', method: 'pattern', confidenceSource: 'deterministic_match', gapReason: null });
    expect(total.evidence?.quote).toBe('Total Due: $1,080.00');
    const vendor = out.fields.find((f) => f.semanticKey === 'vendor.name')!;
    expect(vendor).toMatchObject({ value: 'ACME Supplies Inc.', method: 'llm', model: 'mock-model', confidenceSource: 'model_self_reported' });
    expect(out.modelCalls).toHaveLength(1);
    expect(out.modelCalls[0]).toMatchObject({ prompt: 'PROMPT', purpose: 'extraction' });
  });

  it('turns an unverifiable model quote into a gap and preserves the claim', async () => {
    const out = await runExtraction(invoiceText, template, mockProvider([{ semanticKey: 'vendor.name', value: 'Globex LLC', quote: 'Issued by Globex LLC', page: 0, confidence: 0.99 }]));
    const vendor = out.fields.find((f) => f.semanticKey === 'vendor.name')!;
    expect(vendor.value).toBeNull();
    expect(vendor.gapReason).toMatch(/does not appear verbatim/);
    expect(vendor.unverified).toEqual({ value: 'Globex LLC', quote: 'Issued by Globex LLC', page: 0 });
  });

  it('rejects a real quote paired with a value it does not contain', async () => {
    const out = await runExtraction(invoiceText, template, mockProvider([{ semanticKey: 'vendor.name', value: 'Globex LLC', quote: 'ACME Supplies Inc.', page: 0 }]));
    expect(out.fields.find((f) => f.semanticKey === 'vendor.name')!.gapReason).toMatch(/does not contain the extracted value/);
  });

  it('reports LLM fields as gaps when no provider is configured', async () => {
    const out = await runExtraction(invoiceText, template, null);
    expect(out.fields.find((f) => f.semanticKey === 'vendor.name')!.gapReason).toMatch(/No extraction model/);
    expect(out.modelCalls).toHaveLength(0);
  });

  it('propagates provider failures so the job can be retried', async () => {
    const failing: ExtractionProvider = { name: 'down', external: false, readiness: async () => ({ ready: true, detail: '' }), extract: async () => { throw new Error('503'); } };
    await expect(runExtraction(invoiceText, template, failing)).rejects.toThrow(/down.*503/);
  });

  it('propagates readiness failures unwrapped so they are not retried as transient', async () => {
    const notReady: ExtractionProvider = {
      name: 'local', external: false, readiness: async () => ({ ready: false, detail: 'missing' }),
      extract: async () => { throw new ProviderNotReadyError('local', 'extraction', 'model missing', 'install it'); },
    };
    await expect(runExtraction(invoiceText, template, notReady)).rejects.toBeInstanceOf(ProviderNotReadyError);
  });
});

describe('validation', () => {
  const vendorOk = mockProvider([{ semanticKey: 'vendor.name', value: 'ACME Supplies Inc.', quote: 'ACME Supplies Inc.', page: 0 }]);

  it('passes arithmetic and date order on a consistent invoice', async () => {
    const result = await processDocument(invoiceText, template, { extractionProvider: vendorOk, semanticValidator: null });
    const total = result.fields.find((f) => f.field.semanticKey === 'invoice.total')!;
    expect(total.validations.map((v) => [v.ruleId, v.outcome])).toEqual(
      expect.arrayContaining([['evidence.verified', 'pass'], ['format.amount', 'pass'], ['rule.0.range', 'pass'], ['cross.totals', 'pass']])
    );
    expect(total.disposition).toBe('needs_review');
  });

  it('fails cross-field arithmetic, date order and required checks', async () => {
    const bad = doc(['Invoice Number: INV-9', 'Invoice Date: May 9, 2026', 'Due Date: April 2, 2026', 'Subtotal: $1,000.00', 'Tax: $80.00', 'Total Due: $1,800.00']);
    const result = await processDocument(bad, template, { extractionProvider: mockProvider([]), semanticValidator: null });
    const get = (k: string, rule: string) => result.fields.find((f) => f.field.semanticKey === k)!.validations.find((v) => v.ruleId === rule)!;
    expect(get('invoice.total', 'cross.totals')).toMatchObject({ outcome: 'fail', explanation: expect.stringContaining('1080.00') });
    expect(get('invoice.due_date', 'cross.dates').outcome).toBe('fail');
    expect(get('vendor.name', 'required').outcome).toBe('fail');
    expect(result.fields.find((f) => f.field.semanticKey === 'vendor.name')!.disposition).toBe('gap');
  });

  it('flags invalid formats and enum violations', async () => {
    const t: TemplateDefinition = {
      fields: [
        field('contact.phone', { type: 'phone', extraction: { method: 'pattern', pattern: 'Phone: (\\S+)' } }),
        field('lease.status', { extraction: { method: 'pattern', pattern: 'Status: (\\w+)' }, validationRules: [{ kind: 'enum', values: ['active', 'expired'] }] }),
      ],
    };
    const result = await processDocument(doc(['Phone: 555-12', 'Status: pending']), t, { extractionProvider: null, semanticValidator: null });
    expect(result.fields[0].validations.find((v) => v.ruleId === 'format.phone')!.outcome).toBe('fail');
    expect(result.fields[1].validations.find((v) => v.ruleId === 'rule.0.enum')!.outcome).toBe('fail');
  });

  it('records semantic checks as skipped without a validator, and persists model results with one', async () => {
    const t: TemplateDefinition = {
      fields: [field('report.market', { extraction: { method: 'pattern', pattern: 'Market: (.+?)\\.' }, validationRules: [{ kind: 'semantic', prompt: 'Is this a geographic market?' }] })],
    };
    const d = doc(['Market: Austin, TX.']);
    const skipped = await processDocument(d, t, { extractionProvider: null, semanticValidator: null });
    expect(skipped.fields[0].validations.find((v) => v.method === 'semantic')).toMatchObject({ outcome: 'skipped' });

    const seen: unknown[] = [];
    const validator: SemanticValidator = {
      name: 'mock',
      external: false,
      readiness: async () => ({ ready: true, detail: 'ok' }),
      async check(_doc, checks) {
        seen.push(...checks);
        return {
          results: checks.map((c) => ({ semanticKey: c.semanticKey, outcome: 'uncertain' as const, explanation: 'Ambiguous.', confidence: 0.4 })),
          call: { purpose: 'semantic_validation', provider: 'mock', model: 'cheap-model', promptVersion: 'sem-1', prompt: 'P', rawResponse: 'R' },
          confidenceSource: 'model_probability' as const,
        };
      },
    };
    const checked = await processDocument(d, t, { extractionProvider: null, semanticValidator: validator });
    expect(checked.fields[0].validations.find((v) => v.method === 'semantic')).toMatchObject({
      outcome: 'uncertain',
      model: 'cheap-model',
      promptVersion: 'sem-1',
      confidence: 0.4,
      confidenceSource: 'model_probability',
      explanation: 'Ambiguous.',
    });
    expect(seen[0]).toMatchObject({ decision: { type: 'yes_no' }, minConfidence: 0.6, quote: 'Market: Austin, TX.' });
    expect(checked.fields[0].disposition).toBe('needs_review');
    expect(checked.modelCalls).toHaveLength(1);
  });

  it('auto-approves only under an explicit threshold policy with every check passing', async () => {
    const f = field('report.title', { extraction: { method: 'pattern', pattern: 'Title: (.+)' }, reviewPolicy: { mode: 'threshold', confidenceThreshold: 0.95 } });
    const r = await processDocument(doc(['Title: Q3 Office Market']), { fields: [f] }, { extractionProvider: null, semanticValidator: null });
    expect(r.fields[0].disposition).toBe('auto_approved');
    const ext = { ...r.fields[0].extraction, confidence: 0.5 };
    expect(decideDisposition(f, ext, r.fields[0].validations)).toBe('needs_review');
  });
});

describe('carry-over', () => {
  const total = field('invoice.total', { type: 'currency', extraction: { method: 'pattern', pattern: 'Total Due: (\\$[\\d,.]+)' } });

  async function extract(d: ParsedDocument, f: Field = total) {
    return (await runExtraction(d, { fields: [f] }, null)).fields[0];
  }

  it('carries an approval forward when evidence and interpretation are unchanged', async () => {
    const before = await extract(invoiceText);
    const after = await extract(doc(['Header changed', 'Total Due: $1,080.00']));
    const decision = decideCarryOver(total, after, {
      valueId: 'v1',
      fingerprint: evidenceFingerprint(total, before),
      interpretationHash: interpretationHash(total),
      normalizedValue: before.normalizedValue,
      quote: before.evidence!.quote,
      decision: { kind: 'corrected', finalValue: '1085.00' },
    });
    expect(decision).toEqual({ kind: 'carry_over', fromValueId: 'v1', finalValue: '1085.00', decisionKind: 'corrected' });
  });

  it('reopens when the value changes', async () => {
    const before = await extract(invoiceText);
    const after = await extract(doc(['Total Due: $1,180.00']));
    const decision = decideCarryOver(total, after, {
      valueId: 'v1', fingerprint: evidenceFingerprint(total, before), interpretationHash: interpretationHash(total),
      normalizedValue: before.normalizedValue, quote: before.evidence!.quote, decision: { kind: 'approved', finalValue: '1080.00' },
    });
    expect(decision.kind).toBe('reopen');
    if (decision.kind === 'reopen') expect(decision.reasons.join(' ')).toMatch(/1080.00.*1180.00/);
  });

  it('reopens when only the evidence changes, even if the value matches', async () => {
    const either = field('invoice.total', { type: 'currency', extraction: { method: 'pattern', pattern: '(?:Total Due|Amount Payable): (\\$[\\d,.]+)' } });
    const before = await extract(invoiceText, either);
    const after = await extract(doc(['Amount Payable: $1,080.00']), either);
    expect(after.normalizedValue).toBe(before.normalizedValue);
    const decision = decideCarryOver(either, after, {
      valueId: 'v1', fingerprint: evidenceFingerprint(either, before), interpretationHash: interpretationHash(either),
      normalizedValue: before.normalizedValue, quote: before.evidence!.quote, decision: { kind: 'approved', finalValue: '1080.00' },
    });
    expect(decision).toEqual({ kind: 'reopen', fromValueId: 'v1', reasons: ['The supporting evidence changed.'] });
  });

  it('reopens when the field interpretation changes, even with identical evidence', async () => {
    const before = await extract(invoiceText);
    const stricter = { ...total, validationRules: [{ kind: 'range' as const, max: 500 }] };
    const after = await extract(invoiceText, stricter);
    const decision = decideCarryOver(stricter, after, {
      valueId: 'v1', fingerprint: evidenceFingerprint(total, before), interpretationHash: interpretationHash(total),
      normalizedValue: before.normalizedValue, quote: before.evidence!.quote, decision: { kind: 'approved', finalValue: '1080.00' },
    });
    expect(decision).toEqual({ kind: 'reopen', fromValueId: 'v1', reasons: ['The template definition for this field changed.'] });
  });

  it('does not carry over a value that was never reviewed', async () => {
    const before = await extract(invoiceText);
    const decision = decideCarryOver(total, before, {
      valueId: 'v1', fingerprint: evidenceFingerprint(total, before), interpretationHash: interpretationHash(total),
      normalizedValue: before.normalizedValue, quote: before.evidence!.quote, decision: null,
    });
    expect(decision.kind).toBe('reopen');
  });
});
