import React, { useState } from 'react';
import { call } from '../../lib/client';

type ValueType = 'string' | 'date' | 'money' | 'number' | 'percent';
interface Row {
  label: string;
  type: ValueType;
  instructions: string;
  required: boolean;
}

const TYPES: Array<[ValueType, string]> = [
  ['string', 'Text'],
  ['date', 'Date'],
  ['money', 'Amount'],
  ['number', 'Number'],
  ['percent', 'Percentage'],
];
const blank = (): Row => ({ label: '', type: 'string', instructions: '', required: false });

/** A first guess at the value type from the label; the operator can change it. */
function guessType(label: string): ValueType {
  const l = label.toLowerCase();
  if (/\b(date|due|issued|start|end|expir)/.test(l)) return 'date';
  if (/\b(amount|total|price|cost|rent|deposit|fee|balance|tax|subtotal)\b/.test(l)) return 'money';
  if (/(rate|percent|%|growth)/.test(l)) return 'percent';
  if (/\b(months|years|count|quantity|qty|units)\b/.test(l)) return 'number';
  return 'string';
}

/**
 * Quick form setup (Lomi operators): name the kind of document, list what to
 * read from it, and it is ready for submissions. Lomi generates the output
 * form and the template; layout, rules and checks can be refined afterwards.
 */
export const QuickForm: React.FC<{
  tenant: string;
  onCreated: (key: string, message: string) => void;
  onCancel: () => void;
  onBlank: () => void;
}> = ({ tenant, onCreated, onCancel, onBlank }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.label.trim());

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ documentType: { key: string; name: string }; status: string; fields: unknown[] }>('templates.forms.create', {
        tenant,
        name,
        ...(description.trim() ? { description } : {}),
        publish,
        fields: filled.map((f) => ({ label: f.label, type: f.type, ...(f.instructions.trim() ? { instructions: f.instructions } : {}), ...(f.required ? { required: true } : {}) })),
      });
      onCreated(
        r.documentType.key,
        r.status === 'published'
          ? `${r.documentType.name} is published with ${r.fields.length} fields. Documents of this kind can be sent now and are recognized automatically. Refine layout and checks here at any time.`
          : `${r.documentType.name} saved as a draft with ${r.fields.length} fields. Publish it when ready.`
      );
    } catch (e) {
      const details = (e as { details?: { problems?: string[] } }).details;
      setError(details?.problems?.join(' ') ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="quick-form card" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <h2>New form</h2>
      <p className="small muted">Say what kind of document it is and what to read from it. Lomi creates the template and output form; you can adjust everything later.</p>
      <div className="form-row">
        <label>Name<input aria-label="Form name" value={name} placeholder="Purchase order" onChange={(e) => setName(e.target.value)} /></label>
        <label className="grow">What it is <span className="muted">(helps Lomi recognize it)</span>
          <input aria-label="Form description" value={description} placeholder="An order a buyer sends to a supplier" onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <table className="table quick-fields">
        <thead><tr><th>Field to read</th><th>Kind of value</th><th>What to look for <span className="muted">(optional)</span></th><th>Required</th><th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input aria-label={`Field ${i + 1} label`} value={r.label} placeholder={i === 0 ? 'PO number' : i === 1 ? 'Order date' : i === 2 ? 'Order total' : ''}
                onChange={(e) => update(i, { label: e.target.value, ...(r.label ? {} : { type: guessType(e.target.value) }) })}
                onBlur={() => r.label && r.type === 'string' && update(i, { type: guessType(r.label) })} /></td>
              <td>
                <select aria-label={`Field ${i + 1} type`} value={r.type} onChange={(e) => update(i, { type: e.target.value as ValueType })}>
                  {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </td>
              <td><input aria-label={`Field ${i + 1} instructions`} value={r.instructions} placeholder={r.label ? r.label.toLowerCase() : 'e.g. final total due, not the subtotal'} onChange={(e) => update(i, { instructions: e.target.value })} /></td>
              <td><input type="checkbox" aria-label={`Field ${i + 1} required`} checked={r.required} onChange={(e) => update(i, { required: e.target.checked })} /></td>
              <td>{rows.length > 1 && <button type="button" className="btn-link" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}>remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row">
        <button type="button" onClick={() => setRows([...rows, blank()])} disabled={rows.length >= 20}>+ Add field</button>
        <label className="check"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish now (ready for documents)</label>
        <span className="grow" />
        <button type="button" className="btn-link" onClick={onBlank}>Start blank on your own PDF instead</button>
        <button type="button" className="btn-link" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" type="submit" disabled={busy || !name.trim() || filled.length === 0}>
          {busy ? 'Creating…' : publish ? `Create and publish (${filled.length} field${filled.length === 1 ? '' : 's'})` : 'Create draft'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
};
