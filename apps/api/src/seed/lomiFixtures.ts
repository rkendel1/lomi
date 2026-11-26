import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Field, FieldType } from '@lomi/core';
import type { TemplateDefinition } from '@lomi/docops';
import { formRowY } from './fixtures';

/**
 * The assignment fixtures (`packages/core/src/__tests__/fixtures`): the
 * document manifest, the expected fields per document type, and the PDFs.
 * Templates are generated from expected-fields.json so the fixtures stay the
 * single source of what is extracted.
 */

export interface ManifestDocument {
  id: string;
  type: string;
  title: string;
  versions: Array<{ version: number; file: string; note?: string }>;
}
export interface ExpectedField {
  field: string;
  type: 'string' | 'date' | 'money' | 'number' | 'percent';
}

export function fixturesDir(): string {
  const candidates = [
    process.env.LOMI_FIXTURES_DIR,
    resolve(process.cwd(), 'packages/core/src/__tests__/fixtures'),
    resolve(process.cwd(), '../../packages/core/src/__tests__/fixtures'),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(join(p, 'documents.json')));
  if (!found) throw new Error(`Fixtures not found (looked in: ${candidates.join(', ')}). Set LOMI_FIXTURES_DIR.`);
  return found;
}

export function loadManifest(dir = fixturesDir()): ManifestDocument[] {
  return JSON.parse(readFileSync(join(dir, 'documents.json'), 'utf8'));
}

export function loadExpectedFields(dir = fixturesDir()): Record<string, ExpectedField[]> {
  return JSON.parse(readFileSync(join(dir, 'expected-fields.json'), 'utf8'));
}

export function fixturePdf(file: string, dir = fixturesDir()): Uint8Array {
  return new Uint8Array(readFileSync(join(dir, file)));
}

export const DOCUMENT_TYPE_NAMES: Record<string, string> = { invoice: 'Invoice', lease: 'Lease', market_report: 'Market report' };

/**
 * Extraction instructions: what each field means, in plain words. Most are just
 * the field name; a few say which of several similar values is meant (a total
 * vs. a subtotal; the current vacancy rate vs. a forecast). Operators edit these
 * per customer in Schema Studio.
 */
const INSTRUCTIONS: Record<string, string> = {
  vendor_name: 'name of the company that issued the invoice',
  total_amount: 'final total amount due (not the subtotal)',
  vacancy_rate: 'current overall vacancy rate',
  average_rent_1br: 'average rent one-bedroom unit',
};

/** Yes/no checks on extracted values, answered by the semantic-validation model. */
const SEMANTIC_CHECKS: Record<string, string> = {
  vendor_name: 'Is the extracted value the name of a company or organization?',
  tenant_name: 'Is the extracted value the name of a person or an organization?',
  market_area: 'Is the extracted value the name of a place or geographic area?',
};

const IDENTITY_KEYS: Record<string, string[]> = {
  invoice: ['vendor_name', 'invoice_number'],
  lease: ['tenant_name', 'lease_start'],
  market_report: ['market_area', 'report_quarter'],
};

const label = (field: string) => field.replace(/_/g, ' ').replace(/\b1br\b/, '1BR').replace(/^./, (c) => c.toUpperCase());

export function templateFromExpected(docType: string, expected: ExpectedField[]): TemplateDefinition {
  const fields: Field[] = expected.map((e, i) => {
    const type: FieldType = e.type === 'date' ? 'date' : e.type === 'money' ? 'currency' : 'text';
    const sourceFieldId = `${docType}_${e.field}`;
    const instructions = INSTRUCTIONS[e.field] ?? e.field.replace(/_/g, ' ');
    return {
      id: sourceFieldId,
      name: sourceFieldId,
      sourceFieldId,
      semanticKey: `${docType}.${e.field}`,
      displayLabel: label(e.field),
      page: 0,
      x: 222,
      y: formRowY(i),
      width: 320,
      height: 14,
      type,
      fontSize: 10,
      maxWidth: 320,
      ...(e.type === 'number' ? { dataType: 'number' as const } : {}),
      ...(type === 'date' ? { transformType: 'date' as const, dateFormat: 'YYYY-MM-DD' as const } : {}),
      ...(type === 'currency' ? { transformType: 'currency' as const, currencySymbol: 'USD' as const } : {}),
      extraction: { method: 'llm', instructions, valueType: e.type },
      validationRules: [
        ...(e.type === 'percent' ? [{ kind: 'regex' as const, pattern: '^\\d+(\\.\\d+)?%$', message: 'Expected a percentage such as 4.2%.' }] : []),
        ...(SEMANTIC_CHECKS[e.field] ? [{ kind: 'semantic' as const, prompt: SEMANTIC_CHECKS[e.field], decision: { type: 'yes_no' as const } }] : []),
      ],
    };
  });
  const keys = new Set(expected.map((e) => e.field));
  return {
    fields,
    crossFieldRules:
      keys.has('issue_date') && keys.has('due_date')
        ? [{ id: 'dates', kind: 'date_order', earlier: `${docType}.issue_date`, later: `${docType}.due_date`, message: 'The due date is before the issue date.' }]
        : [],
    identityKeys: (IDENTITY_KEYS[docType] ?? []).filter((k) => keys.has(k)).map((k) => `${docType}.${k}`),
  };
}
