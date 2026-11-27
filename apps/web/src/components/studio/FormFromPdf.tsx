import React, { useState } from 'react';
import type { Field } from '@lomi/core';
import { call, fileToBase64 } from '../../lib/client';
import { detectFormFields, isReadable, toRegionSpec, type DetectionReport } from '../../lib/formDetection';
import { Mapper } from './Mapper';

/**
 * New form from the form itself (Lomi operators). coordtool locates every
 * field on every page — fillable fields exactly, printed boxes from the page
 * (OCR for scans) — the operator corrects them in the mapper, and Lomi saves a
 * template that reads each element from its own box on incoming copies and
 * recognizes those copies by the form's printed layout.
 */
export const FormFromPdf: React.FC<{ tenant: string; onCreated: (key: string, message: string) => void; onCancel: () => void }> = ({ tenant, onCreated, onCancel }) => {
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<DetectionReport | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (f: File) => {
    setError(null);
    setFile(null);
    setDetected(null);
    if (!name) setName(f.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').replace(/\b(blank|empty|template)\b/gi, '').trim());
    try {
      const report = await detectFormFields(f, { onProgress: setProgress });
      setDetected(report);
      setFields(report.fields);
      setFile(f);
    } catch (e) {
      setError(`The PDF could not be analysed: ${(e as Error).message}`);
    } finally {
      setProgress(null);
    }
  };

  const readable = fields.filter(isReadable);
  const create = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ documentType: { key: string; name: string }; fields: unknown[]; layoutAnchors: number; status: string }>('templates.forms.import', {
        tenant, name, ...(description.trim() ? { description } : {}), filename: file.name, contentBase64: await fileToBase64(file), fields: readable.map(toRegionSpec),
      });
      onCreated(
        r.documentType.key,
        `${r.documentType.name} is ${r.status} with ${r.fields.length} elements read by position. Filled copies are recognized by the form's printed layout (${r.layoutAnchors} anchors) and each element is normalized into this customer's records.`
      );
    } catch (e) {
      const details = (e as { details?: { problems?: string[] } }).details;
      setError(details?.problems?.join(' ') ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-from-pdf">
      <div className="card">
        <h2>New form from the form's PDF</h2>
        <p className="small muted">Upload the form (blank or a filled sample). Lomi locates its fields; you check them, name them, and publish.</p>
        <div className="form-row">
          <label>
            Form PDF
            <input type="file" accept="application/pdf" aria-label="Form PDF" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
          </label>
          <label>Name<input aria-label="Form name" value={name} placeholder="Supplier onboarding" onChange={(e) => setName(e.target.value)} /></label>
          <label className="grow">What it is <span className="muted">(optional)</span>
            <input aria-label="Form description" value={description} placeholder="Filled in by new suppliers" onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        {progress && <div className="notice" role="status">{progress}</div>}
        {detected && (
          <p className="small">
            Located <strong>{detected.fields.length}</strong> fields on {detected.pages} page{detected.pages === 1 ? '' : 's'}
            {detected.native ? ` · ${detected.native} fillable` : ''}{detected.flat ? ` · ${detected.flat} printed boxes` : ''}{detected.ocrPages ? ` · ${detected.ocrPages} page(s) read with OCR` : ''}.
            {' '}Rename, retype, delete or draw boxes below. {fields.length - readable.length > 0 && <span className="muted">{fields.length - readable.length} signature/initials boxes are not read.</span>}
          </p>
        )}
        <div className="form-row">
          <span className="grow" />
          <button type="button" className="btn-link" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={!file || busy || !name.trim() || readable.length === 0} onClick={() => void create()}>
            {busy ? 'Creating…' : `Create and publish (${readable.length} element${readable.length === 1 ? '' : 's'})`}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      {file && detected && (
        <div className="studio-canvas">
          <Mapper minimal key={`${file.name}:${file.size}`} embedded initialFile={file} initialFields={detected.fields} onFieldsChange={setFields} />
        </div>
      )}
    </div>
  );
};
