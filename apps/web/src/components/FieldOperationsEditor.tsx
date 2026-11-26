import React, { useEffect, useState } from 'react';
import type { Field, FieldValidationRule } from '@lomi/core';

interface Props {
  field: Field;
  update: (patch: Partial<Field>) => void;
}

/**
 * Document-operations settings for a field: how values are extracted from
 * incoming documents, which checks run, and when a person must review.
 * Validation rules are edited as JSON (regex, range, enum and typed semantic
 * decisions) and only applied when they parse.
 */
export const FieldOperationsEditor: React.FC<Props> = ({ field, update }) => {
  const [rulesText, setRulesText] = useState(() => JSON.stringify(field.validationRules ?? [], null, 2));
  const [rulesError, setRulesError] = useState<string | null>(null);
  useEffect(() => {
    setRulesText(JSON.stringify(field.validationRules ?? [], null, 2));
    setRulesError(null);
  }, [field.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const method = field.extraction?.method ?? 'none';
  const policy = field.reviewPolicy ?? { mode: 'always' as const };

  return (
    <div className="fe-ops">
      <h4 className="fe-subtitle">Document operations</h4>

      <label className="fe-label">Extraction</label>
      <select
        className="fe-select"
        aria-label="Extraction method"
        value={method}
        onChange={(e) => {
          const next = e.target.value;
          update({ extraction: next === 'none' ? undefined : { ...(field.extraction ?? {}), method: next as 'pattern' | 'llm' } });
        }}
      >
        <option value="none">Not extracted (output only)</option>
        <option value="pattern">Pattern (deterministic)</option>
        <option value="llm">Model (generative, tenant-authorized)</option>
      </select>
      {method === 'pattern' && (
        <>
          <label className="fe-label" title="First capture group is the value; the whole match is the evidence quote.">Pattern (regular expression)</label>
          <input
            className="fe-input fe-mono"
            value={field.extraction?.pattern ?? ''}
            placeholder="Total Due: (\$[\d,]+\.\d{2})"
            onChange={(e) => update({ extraction: { method: 'pattern', pattern: e.target.value, flags: field.extraction?.flags } })}
          />
        </>
      )}
      {method === 'llm' && (
        <>
          <label className="fe-label">Extraction instructions</label>
          <textarea
            className="fe-input"
            rows={3}
            value={field.extraction?.instructions ?? ''}
            placeholder="e.g. The legal name of the company issuing the invoice"
            onChange={(e) => update({ extraction: { method: 'llm', instructions: e.target.value } })}
          />
        </>
      )}

      <label className="fe-label">Human review</label>
      <select
        className="fe-select"
        aria-label="Review policy"
        value={policy.mode}
        onChange={(e) => update({ reviewPolicy: e.target.value === 'always' ? { mode: 'always' } : { mode: 'threshold', confidenceThreshold: 1 } })}
      >
        <option value="always">Always review</option>
        <option value="threshold">Auto-approve when every check passes at or above a threshold</option>
      </select>
      {policy.mode === 'threshold' && (
        <>
          <label className="fe-label">Confidence threshold</label>
          <input
            className="fe-input"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={policy.confidenceThreshold ?? 1}
            onChange={(e) => update({ reviewPolicy: { mode: 'threshold', confidenceThreshold: Number(e.target.value) } })}
          />
        </>
      )}

      <label className="fe-label" title='e.g. [{"kind":"range","min":0},{"kind":"semantic","prompt":"Is this a company name?","decision":{"type":"yes_no"}}]'>
        Validation rules (JSON)
      </label>
      <textarea
        className="fe-input fe-mono"
        rows={5}
        aria-label="Validation rules"
        value={rulesText}
        onChange={(e) => {
          setRulesText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value) as FieldValidationRule[];
            if (!Array.isArray(parsed)) throw new Error('Rules must be a JSON array');
            setRulesError(null);
            update({ validationRules: parsed });
          } catch (error) {
            setRulesError((error as Error).message);
          }
        }}
      />
      {rulesError && <div className="fe-warning">Not applied: {rulesError}</div>}
    </div>
  );
};
