import React, { useEffect, useRef, useState } from 'react';
import { call, submitFiles, type IngressInfo, type SubmissionResult } from '../../lib/client';

/**
 * Upload one or many PDFs to a customer's ingress URL. Choosing a document type
 * shows what Lomi will read from it, so the choice is visible and deliberate.
 */
export const UploadPanel: React.FC<{ tenant: string; onSubmitted: (results: SubmissionResult[]) => void; compact?: boolean }> = ({ tenant, onSubmitted, compact }) => {
  const [info, setInfo] = useState<IngressInfo | null>(null);
  const [type, setType] = useState<string>('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void call<IngressInfo>('ingress.get', { tenant })
      .then((i) => {
        setInfo(i);
        setType(i.defaultDocumentType ?? i.documentTypes[0]?.key ?? '');
      })
      .catch((e) => setError(e.message));
  }, [tenant]);

  const chosen = info?.documentTypes.find((t) => t.key === type);
  const add = (list: FileList | null) => {
    if (!list) return;
    // Copy now: the input is cleared right after this call, which empties a live FileList.
    const picked = Array.from(list);
    setFiles((prev) => [...prev, ...picked.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
  };

  const submit = async () => {
    if (!files.length || !type) return;
    setBusy(true);
    setError(null);
    try {
      const results = await submitFiles(tenant, files, type);
      setFiles([]);
      onSubmitted(results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (info && !info.enabled) return <div className="notice">This customer is not accepting submissions right now.</div>;
  return (
    <div className={`upload-panel${compact ? ' compact' : ''}`}>
      <div className="upload-step">
        <span className="step">1</span>
        <div className="upload-types" role="radiogroup" aria-label="Document type">
          {info?.documentTypes.map((t) => (
            <button key={t.key} role="radio" aria-checked={t.key === type} className={`type-card${t.key === type ? ' chosen' : ''}`} onClick={() => setType(t.key)}>
              <strong>{t.name}</strong>
              <span className="small muted">{t.fields.length} fields</span>
            </button>
          ))}
        </div>
      </div>
      {chosen && (
        <p className="type-fields small">
          Lomi will read: {chosen.fields.join(' · ')}
        </p>
      )}
      <div className="upload-step">
        <span className="step">2</span>
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); add(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Choose PDF files"
        >
          <input ref={input} type="file" accept="application/pdf" multiple hidden aria-label="PDF files" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          {files.length === 0 ? (
            <span>Drop PDFs here or <u>choose files</u> — one or many</span>
          ) : (
            <ul className="file-list" onClick={(e) => e.stopPropagation()}>
              {files.map((f) => (
                <li key={f.name + f.size}>
                  {f.name} <span className="muted small">{Math.round(f.size / 1024)} KB</span>
                  <button className="btn-link" onClick={() => setFiles((prev) => prev.filter((p) => p !== f))} aria-label={`Remove ${f.name}`}>remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="upload-step">
        <span className="step">3</span>
        <button className="btn-primary" disabled={!files.length || !type || busy} onClick={() => void submit()}>
          {busy ? 'Submitting…' : files.length > 1 ? `Submit ${files.length} documents as ${chosen?.name ?? '…'}` : `Submit as ${chosen?.name ?? '…'}`}
        </button>
        <span className="small muted">Processing starts immediately.</span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
};
