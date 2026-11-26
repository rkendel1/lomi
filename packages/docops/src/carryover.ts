import { createHash } from 'node:crypto';
import type { Field } from '@lomi/core';
import { normalizeWhitespace } from './text';
import type { FieldExtraction } from './types';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function stableHash(value: unknown): string {
  return sha256(stable(value));
}

/**
 * The parts of a field definition that change how a value is interpreted.
 * Geometry and presentation are excluded: moving a box on the output form does
 * not change what the extracted value means.
 */
export function interpretationHash(field: Field): string {
  return stableHash({
    semanticKey: field.semanticKey,
    type: field.type,
    dataType: field.dataType ?? null,
    required: field.required ?? false,
    extraction: field.extraction ?? null,
    validationRules: field.validationRules ?? [],
  });
}

/** Identity of "this value, read from this evidence, under this interpretation". */
export function evidenceFingerprint(field: Field, extraction: FieldExtraction): string | null {
  if (extraction.value === null || !extraction.evidence) return null;
  return stableHash({
    interpretation: interpretationHash(field),
    value: extraction.normalizedValue,
    quote: normalizeWhitespace(extraction.evidence.quote),
  });
}

export interface PriorFieldState {
  valueId: string;
  fingerprint: string | null;
  interpretationHash: string;
  normalizedValue: string | null;
  quote: string | null;
  /** The decision that currently stands for the prior value, if any. */
  decision: { kind: 'approved' | 'corrected' | 'auto_approved'; finalValue: string | null } | null;
}

export type CarryOverDecision =
  | { kind: 'carry_over'; fromValueId: string; finalValue: string | null; decisionKind: 'approved' | 'corrected' | 'auto_approved' }
  | { kind: 'reopen'; fromValueId: string; reasons: string[] }
  | { kind: 'new' };

/**
 * Carry a prior human decision forward only when the evidence and the
 * interpretation are unchanged. A matching value alone is not enough.
 */
export function decideCarryOver(field: Field, extraction: FieldExtraction, prior: PriorFieldState | undefined): CarryOverDecision {
  if (!prior) return { kind: 'new' };
  const fingerprint = evidenceFingerprint(field, extraction);
  if (prior.decision && fingerprint !== null && fingerprint === prior.fingerprint) {
    return { kind: 'carry_over', fromValueId: prior.valueId, finalValue: prior.decision.finalValue, decisionKind: prior.decision.kind };
  }
  const reasons: string[] = [];
  if (prior.interpretationHash !== interpretationHash(field)) reasons.push('The template definition for this field changed.');
  if ((prior.normalizedValue ?? null) !== (extraction.normalizedValue ?? null)) {
    reasons.push(`The value changed from "${prior.normalizedValue ?? '—'}" to "${extraction.normalizedValue ?? '—'}".`);
  }
  const quote = extraction.evidence ? normalizeWhitespace(extraction.evidence.quote) : null;
  if ((prior.quote ? normalizeWhitespace(prior.quote) : null) !== quote) reasons.push('The supporting evidence changed.');
  if (!prior.decision) reasons.push('The previous version was not yet reviewed.');
  if (reasons.length === 0) reasons.push('The evidence could not be matched to the previous review.');
  return { kind: 'reopen', fromValueId: prior.valueId, reasons };
}
