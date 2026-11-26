import type { Field } from '@lomi/core';
import { parseAmount, parseDate, valueKind } from './values';
import type {
  CrossFieldRule,
  Disposition,
  FieldExtraction,
  FieldValidationResult,
  ModelCallRecord,
  ParsedDocument,
  SemanticCheckRequest,
  SemanticValidator,
  TemplateDefinition,
} from './types';

/** Bump when deterministic rule semantics change, so stored results stay interpretable. */
export const DETERMINISTIC_RULES_VERSION = 'det-1';

function result(
  semanticKey: string,
  ruleId: string,
  outcome: FieldValidationResult['outcome'],
  explanation: string
): FieldValidationResult {
  return { semanticKey, ruleId, method: 'deterministic', ruleVersion: DETERMINISTIC_RULES_VERSION, outcome, explanation };
}

const FORMAT_CHECKS: Partial<Record<Field['type'], { test: (v: string) => boolean; label: string }>> = {
  phone: { test: (v) => v.replace(/\D/g, '').length === 10, label: 'a 10-digit phone number' },
  zip: { test: (v) => /^\d{5}(-\d{4})?$/.test(v.trim()), label: 'a ZIP code' },
  ssn: { test: (v) => /^\d{3}-?\d{2}-?\d{4}$/.test(v.trim()), label: 'an SSN' },
  ein: { test: (v) => /^\d{2}-?\d{7}$/.test(v.trim()), label: 'an EIN' },
};

/** Field-level deterministic checks: evidence, required, type format, configured rules. */
export function validateField(field: Field, extraction: FieldExtraction): FieldValidationResult[] {
  const key = field.semanticKey;
  const out: FieldValidationResult[] = [];

  if (extraction.value === null) {
    out.push(
      result(key, 'evidence.verified', extraction.unverified ? 'fail' : 'skipped', extraction.gapReason ?? 'No value extracted.')
    );
    out.push(
      field.required
        ? result(key, 'required', 'fail', `${field.displayLabel || key} is required but no supported value was found.`)
        : result(key, 'required', 'pass', 'Optional field.')
    );
    return out;
  }

  out.push(result(key, 'evidence.verified', 'pass', `Quote found verbatim on page ${(extraction.evidence?.page ?? 0) + 1}.`));
  if (field.required) out.push(result(key, 'required', 'pass', 'Value present.'));

  const kind = valueKind(field);
  if (kind === 'date') {
    out.push(
      parseDate(extraction.value)
        ? result(key, 'format.date', 'pass', 'Recognised date.')
        : result(key, 'format.date', 'fail', `"${extraction.value}" is not a recognisable date.`)
    );
  } else if (kind === 'amount') {
    out.push(
      parseAmount(extraction.value) !== null
        ? result(key, 'format.amount', 'pass', 'Recognised amount.')
        : result(key, 'format.amount', 'fail', `"${extraction.value}" is not a recognisable amount.`)
    );
  }
  const format = FORMAT_CHECKS[field.type];
  if (format) {
    out.push(
      format.test(extraction.value)
        ? result(key, `format.${field.type}`, 'pass', `Valid ${format.label}.`)
        : result(key, `format.${field.type}`, 'fail', `"${extraction.value}" is not ${format.label}.`)
    );
  }

  (field.validationRules ?? []).forEach((rule, index) => {
    const id = `rule.${index}.${rule.kind}`;
    const v = extraction.normalizedValue ?? extraction.value!;
    if (rule.kind === 'regex') {
      const ok = new RegExp(rule.pattern).test(extraction.value!);
      out.push(result(key, id, ok ? 'pass' : 'fail', ok ? 'Matches the required pattern.' : rule.message ?? `Does not match ${rule.pattern}.`));
    } else if (rule.kind === 'range') {
      const n = parseAmount(v);
      const ok = n !== null && (rule.min === undefined || n >= rule.min) && (rule.max === undefined || n <= rule.max);
      out.push(
        result(key, id, ok ? 'pass' : 'fail', ok ? 'Within the allowed range.' : rule.message ?? `Outside the allowed range ${rule.min ?? '-∞'}…${rule.max ?? '∞'}.`)
      );
    } else if (rule.kind === 'enum') {
      const ok = rule.values.some((allowed) => allowed.toLowerCase() === v.toLowerCase());
      out.push(result(key, id, ok ? 'pass' : 'fail', ok ? 'An allowed value.' : rule.message ?? `Expected one of: ${rule.values.join(', ')}.`));
    }
    // `semantic` rules are evaluated by runSemanticValidation.
  });
  return out;
}

/** Cross-field deterministic rules. Each result is attached to every field it involves. */
export function validateCrossField(rules: CrossFieldRule[], values: Map<string, FieldExtraction>): FieldValidationResult[] {
  const out: FieldValidationResult[] = [];
  for (const rule of rules) {
    if (rule.kind === 'sum') {
      const keys = [...rule.terms, rule.equals];
      const missing = keys.filter((k) => values.get(k)?.normalizedValue == null);
      let outcome: FieldValidationResult['outcome'];
      let explanation: string;
      if (missing.length) {
        outcome = 'skipped';
        explanation = `Cannot check ${rule.terms.join(' + ')} = ${rule.equals}: missing ${missing.join(', ')}.`;
      } else {
        const sum = rule.terms.reduce((acc, k) => acc + Number(values.get(k)!.normalizedValue), 0);
        const total = Number(values.get(rule.equals)!.normalizedValue);
        const ok = Math.abs(sum - total) <= (rule.tolerance ?? 0.01);
        outcome = ok ? 'pass' : 'fail';
        explanation = ok
          ? `${rule.terms.join(' + ')} = ${rule.equals} (${total.toFixed(2)}).`
          : rule.message ?? `${rule.terms.join(' + ')} is ${sum.toFixed(2)}, but ${rule.equals} is ${total.toFixed(2)}.`;
      }
      for (const k of keys) out.push(result(k, `cross.${rule.id}`, outcome, explanation));
    } else {
      const a = values.get(rule.earlier)?.normalizedValue;
      const b = values.get(rule.later)?.normalizedValue;
      let outcome: FieldValidationResult['outcome'] = 'skipped';
      let explanation = `Cannot compare ${rule.earlier} and ${rule.later}: a date is missing.`;
      if (a && b) {
        outcome = a <= b ? 'pass' : 'fail';
        explanation = a <= b ? `${rule.earlier} is on or before ${rule.later}.` : rule.message ?? `${rule.earlier} (${a}) is after ${rule.later} (${b}).`;
      }
      for (const k of [rule.earlier, rule.later]) out.push(result(k, `cross.${rule.id}`, outcome, explanation));
    }
  }
  return out;
}

export function semanticCheckRequests(template: TemplateDefinition, values: Map<string, FieldExtraction>): SemanticCheckRequest[] {
  const requests: SemanticCheckRequest[] = [];
  for (const field of template.fields) {
    const extraction = values.get(field.semanticKey);
    if (!extraction || extraction.value === null || !extraction.evidence) continue;
    for (const rule of field.validationRules ?? []) {
      if (rule.kind === 'semantic') {
        requests.push({ semanticKey: field.semanticKey, value: extraction.value, quote: extraction.evidence.quote, prompt: rule.prompt });
      }
    }
  }
  return requests;
}

/**
 * Semantic checks are batched into one model call per document. Without a
 * validator they are recorded as skipped (never as passed).
 */
export async function runSemanticValidation(
  document: ParsedDocument,
  requests: SemanticCheckRequest[],
  validator: SemanticValidator | null
): Promise<{ results: FieldValidationResult[]; calls: ModelCallRecord[] }> {
  if (requests.length === 0) return { results: [], calls: [] };
  if (!validator) {
    return {
      results: requests.map((r) => ({
        semanticKey: r.semanticKey,
        ruleId: 'semantic',
        method: 'semantic' as const,
        ruleVersion: 'none',
        outcome: 'skipped' as const,
        explanation: 'Semantic validation is not configured; a reviewer should check this manually.',
      })),
      calls: [],
    };
  }
  const { results, call } = await validator.check(document, requests);
  return {
    calls: [call],
    results: requests.map((r) => {
      const found = results.find((x) => x.semanticKey === r.semanticKey);
      return {
        semanticKey: r.semanticKey,
        ruleId: 'semantic',
        method: 'semantic' as const,
        ruleVersion: call.promptVersion,
        model: call.model,
        promptVersion: call.promptVersion,
        outcome: !found ? ('error' as const) : found.outcome === 'pass' ? ('pass' as const) : ('fail' as const),
        explanation: found
          ? `${found.outcome === 'uncertain' ? 'Uncertain: ' : ''}${found.explanation}`
          : 'The model returned no result for this check.',
        confidence: found?.confidence ?? null,
        confidenceSource: 'model_self_reported' as const,
      };
    }),
  };
}

/**
 * Decide whether a value needs a human. Self-reported model confidence is only
 * used when a tenant has explicitly opted into threshold review; it is never
 * treated as a calibrated probability.
 */
export function decideDisposition(field: Field, extraction: FieldExtraction, validations: FieldValidationResult[]): Disposition {
  if (extraction.value === null) return 'gap';
  const policy = field.reviewPolicy ?? { mode: 'always' as const };
  if (policy.mode !== 'threshold') return 'needs_review';
  const clean = validations.every((v) => v.outcome === 'pass' || (v.outcome === 'skipped' && v.method === 'deterministic'));
  const threshold = policy.confidenceThreshold ?? 1;
  const confident = (extraction.confidence ?? 0) >= threshold;
  return clean && confident ? 'auto_approved' : 'needs_review';
}
