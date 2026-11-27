import React, { useEffect, useMemo, useState } from 'react';
import type { Field } from '@lomi/core';
import { call } from '../../lib/client';
import { detectFormFields, isReadable, overlapsExistingRegion, toRegionSpec } from '../../lib/formDetection';
import { Mapper } from '../studio/Mapper';

interface TypeRow {
  key: string;
  name: string;
  versions: Array<{ id: string; version: number; status: string }>;
}
type ValueType = 'string' | 'date' | 'money' | 'number' | 'percent';
interface Described {
  label: string;
  type: ValueType;
  instructions: string;
}

/**
 * Map a document Lomi could not identify into one of the customer's existing
 * forms (Lomi operators). The form's current elements are shown on the
 * document; anything the document has that the form does not capture can be
 * added — boxes located by coordtool for fixed-layout forms, described fields
 * for forms read by Laya. That saves a new version of the form (earlier
 * versions and documents are unchanged), then this document is processed with
 * it and lands in the same records as every other copy.
 */
export const MapIntoForm: React.FC<{
  tenant: string;
  documentId: string;
  file: File | null;
  classification?: { scores?: Array<{ key: string; score: number }>; layoutScores?: Array<{ key: string; score: number }> } | null;
  /** Extend mode: the document is already processed as this form; new elements are added and it is read again. */
  currentType?: string;
  onDone: () => void;
}> = ({ tenant, documentId, file, classification, currentType, onDone }) => {
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [typeKey, setTypeKey] = useState('');
  const [existing, setExisting] = useState<Field[] | null>(null);
  const [candidates, setCandidates] = useState<Field[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [described, setDescribed] = useState<Described[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [located, setLocated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const layoutScore = (k: string) => classification?.layoutScores?.find((s) => s.key === k)?.score;
  const modelScore = (k: string) => classification?.scores?.find((s) => s.key === k)?.score;

  useEffect(() => {
    void call<{ items: TypeRow[] }>('templates.list', { tenant })
      .then((r) => {
        const usable = r.items.filter((t) => t.versions.some((v) => v.status === 'published'));
        // Nearest first: printed layout, then Laya's yes/no score.
        usable.sort((a, b) => (layoutScore(b.key) ?? -1) - (layoutScore(a.key) ?? -1) || (modelScore(b.key) ?? -1) - (modelScore(a.key) ?? -1));
        setTypes(currentType ? usable.filter((t) => t.key === currentType) : usable);
        setTypeKey(currentType ?? usable[0]?.key ?? '');
      })
      .catch((e) => setError(e.message));
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps

  const type = types.find((t) => t.key === typeKey);
  useEffect(() => {
    if (!type || !file) return;
    let cancelled = false;
    setExisting(null);
    setLocated(false);
    setCandidates([]);
    setDescribed([]);
    setError(null);
    void (async () => {
      const tv = await call<{ definition: { fields: Field[] } }>('templates.get', { tenant, templateVersionId: type.versions[0].id });
      const current = tv.definition.fields.filter((f) => f.extraction);
      if (cancelled) return;
      setExisting(current);
      if (current.some((f) => f.extraction?.method === 'region')) {
        setStatus('Locating elements on this document…');
        const report = await detectFormFields(file, { onProgress: (m) => !cancelled && setStatus(m) });
        if (cancelled) return;
        // Proposed new elements: located boxes the form does not already read.
        const fresh = report.fields.filter((f) => isReadable(f) && !overlapsExistingRegion(f, current.filter((e) => e.page === f.page)));
        setCandidates(fresh);
        setFields([...current, ...fresh]);
        setStatus(null);
        setLocated(true);
      }
    })().catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [type?.key, file]); // eslint-disable-line react-hooks/exhaustive-deps

  const existingIds = useMemo(() => new Set((existing ?? []).map((f) => f.id)), [existing]);
  const fixed = Boolean(existing?.some((f) => f.extraction?.method === 'region'));
  const added = fixed ? fields.filter((f) => !existingIds.has(f.id) && isReadable(f)) : [];
  const addedDescribed = described.filter((d) => d.label.trim());
  const newCount = added.length + addedDescribed.length;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (newCount) {
        await call('templates.fields.add', {
          tenant, documentType: typeKey, documentId,
          ...(added.length ? { regionFields: added.map(toRegionSpec) } : {}),
          ...(addedDescribed.length ? { describedFields: addedDescribed.map((d) => ({ label: d.label, type: d.type, ...(d.instructions.trim() ? { instructions: d.instructions } : {}) })) } : {}),
        });
      }
      if (currentType) {
        // Already processed: read the same file again with the extended version.
        await call('documents.reread', { tenant, documentId });
      } else {
        await call('documents.type.set', { tenant, documentId, documentType: typeKey });
      }
      onDone();
    } catch (e) {
      const details = (e as { details?: { problems?: string[] } }).details;
      setError(details?.problems?.join(' ') ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const score = (k: string) => {
    const l = layoutScore(k);
    const m = modelScore(k);
    return l !== undefined ? ` — layout ${Math.round(l * 100)}% in place` : m !== undefined ? ` — Laya ${m.toFixed(2)}` : '';
  };

  return (
    <section className="card card-action map-into-form">
      <h2>{currentType ? 'Capture more from this document' : 'Map into a form'}</h2>
      <p className="small muted">
        {currentType
          ? 'Add elements this document has that its form does not capture yet. The form gets a new version, and this document is read again with it: unchanged reviewed values carry over; only the new elements need review.'
          : 'Choose the form this document is. Elements it has that the form does not capture yet can be added; the form gets a new version and this document is processed with it.'}
      </p>
      <div className="form-row">
        <label>
          Form
          <select aria-label="Form to map into" value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.name}{score(t.key)}</option>)}
          </select>
        </label>
        {type && <span className="small muted">current version v{type.versions[0].version} · {existing?.length ?? '…'} elements</span>}
      </div>
      {status && <div className="notice" role="status">{status}</div>}

      {fixed && file && existing && located && (
        <>
          <p className="small">
            {candidates.length
              ? <>coordtool found <strong>{candidates.length}</strong> box{candidates.length === 1 ? '' : 'es'} the form does not read yet. Name them, delete what isn't data, or draw more.</>
              : 'Every located box is already read by this form. Draw a box for anything else to capture.'}
            {' '}<span className="muted">Existing elements are shown for reference; changing them here has no effect.</span>
          </p>
          {added.length > 0 && <p className="small"><strong>New:</strong> {added.map((f) => f.displayLabel || f.name).join(' · ')}</p>}
          <div className="studio-canvas map-canvas">
            <Mapper key={`${typeKey}:${candidates.length}`} embedded initialFile={file} initialFields={[...existing, ...candidates]} onFieldsChange={setFields} />
          </div>
        </>
      )}

      {!fixed && existing && (
        <div>
          <p className="small">This form is read by Laya: {existing.map((f) => f.displayLabel).join(' · ')}. Add elements it does not capture:</p>
          {described.map((d, i) => (
            <div key={i} className="form-row">
              <input aria-label={`New element ${i + 1} label`} placeholder="Purchase order number" value={d.label} onChange={(e) => setDescribed(described.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <select aria-label={`New element ${i + 1} type`} value={d.type} onChange={(e) => setDescribed(described.map((x, j) => (j === i ? { ...x, type: e.target.value as ValueType } : x)))}>
                <option value="string">Text</option><option value="date">Date</option><option value="money">Amount</option><option value="number">Number</option><option value="percent">Percentage</option>
              </select>
              <input className="grow" aria-label={`New element ${i + 1} instructions`} placeholder="what to look for (optional)" value={d.instructions} onChange={(e) => setDescribed(described.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))} />
              <button type="button" className="btn-link" onClick={() => setDescribed(described.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setDescribed([...described, { label: '', type: 'string', instructions: '' }])}>+ Add element</button>
        </div>
      )}

      <div className="form-row">
        <span className="grow" />
        <button className="btn-primary" disabled={!typeKey || busy || !existing || (fixed && !located)} onClick={() => void apply()}>
          {busy
            ? 'Saving…'
            : newCount
              ? `Add ${newCount} element${newCount === 1 ? '' : 's'} (new version v${(type?.versions[0].version ?? 0) + 1}) and ${currentType ? 'read again' : 'process'}`
              : currentType ? 'Read again with the latest version' : `Process as ${type?.name ?? '…'}`}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
};
