import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call, can, fileToBase64, type Me } from '../lib/client';
import { ProgressBar, StatusBadge } from './shared';

export interface DocumentSummary {
  id: string;
  title: string;
  documentType: { key: string; name: string };
  currentVersion: { id: string; number: number };
  submittedAt: string;
  status: string;
  statusLabel: string;
  nextAction: string;
  failureReason: string | null;
  progress: null | { total: number; pending: number; gaps: number; approved: number; autoApproved: number; corrected: number; carriedOver: number; failedChecks: number };
  relatedDocuments: number;
}

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];
const STATUS_FILTERS = [
  ['', 'All'],
  ['awaiting_review', 'Ready for review'],
  ['partially_reviewed', 'Review in progress'],
  ['approved', 'Approved'],
  ['completed', 'Completed'],
  ['failed_operator', 'On hold'],
];

export const DocumentsPage: React.FC<{ tenant: string; me: Me }> = ({ tenant, me }) => {
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [types, setTypes] = useState<Array<{ key: string; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await call<{ items: DocumentSummary[] }>('documents.list', {
        tenant, ...(search ? { search } : {}), ...(status ? { status } : {}), ...(type ? { documentType: type } : {}),
      });
      setItems(result.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tenant, search, status, type]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while anything is still being processed, so status changes appear without a refresh.
  useEffect(() => {
    if (!items.some((i) => IN_FLIGHT.includes(i.status))) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [items, load]);

  useEffect(() => {
    void call<{ items: Array<{ key: string; name: string; versions: Array<{ status: string }> }> }>('templates.list', { tenant })
      .then((r) => {
        const usable = r.items.filter((t) => t.versions.some((v) => v.status === 'published'));
        setTypes(usable);
        setUploadType(usable[0]?.key ?? '');
      })
      .catch(() => setTypes([]));
  }, [tenant]);

  const upload = async (file: File) => {
    setUploading(true);
    setNotice(null);
    try {
      const result = await call('documents.submit', { tenant, documentType: uploadType, filename: file.name, contentBase64: await fileToBase64(file) });
      setNotice(
        result.outcome === 'duplicate_exact'
          ? `"${file.name}" was already received (version ${result.duplicateOf.version}); nothing new was created.`
          : `"${file.name}" was received. Lomi is reading it now.`
      );
      await load();
    } catch (e) {
      setNotice(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const waiting = items.filter((i) => ['awaiting_review', 'partially_reviewed'].includes(i.status)).length;
  const onHold = items.filter((i) => i.status === 'failed_operator').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="muted">
            {items.length} document{items.length === 1 ? '' : 's'} · {waiting} need review{onHold ? ` · ${onHold} on hold` : ''}
          </p>
        </div>
        {can(me, tenant, 'documents.submit') && types.length > 0 && (
          <div className="upload-box">
            <select aria-label="Document type" value={uploadType} onChange={(e) => setUploadType(e.target.value)}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>{t.name}</option>
              ))}
            </select>
            <input ref={fileRef} type="file" accept="application/pdf" aria-label="Upload PDF" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button className="btn-primary" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Upload PDF'}
            </button>
          </div>
        )}
      </div>
      {notice && <div className="notice">{notice}</div>}
      <div className="filters">
        <input type="search" placeholder="Search title, file or invoice number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <select aria-label="Type filter" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t.key} value={t.key}>{t.name}</option>
          ))}
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <table className="doc-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Type</th>
            <th>Version</th>
            <th>Received</th>
            <th>Status</th>
            <th>Review progress</th>
            <th>Next action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} onClick={() => (window.location.hash = `/documents/${d.id}`)} className={d.status === 'failed_operator' ? 'row-hold' : ''}>
              <td>
                <a href={`#/documents/${d.id}`}>{d.title}</a>
                {d.relatedDocuments > 0 && <span className="tag" title="Another document carries the same identifying values">possible duplicate</span>}
              </td>
              <td>{d.documentType.name}</td>
              <td>v{d.currentVersion.number}</td>
              <td>{new Date(d.submittedAt).toLocaleString()}</td>
              <td><StatusBadge status={d.status} label={d.statusLabel} /></td>
              <td>{d.progress ? <ProgressBar progress={d.progress} /> : <span className="muted">—</span>}</td>
              <td className={['awaiting_review', 'partially_reviewed', 'approved'].includes(d.status) ? 'next-action strong' : 'next-action'}>{d.nextAction}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">No documents match.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
