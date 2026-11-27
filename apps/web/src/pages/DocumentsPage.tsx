import React, { useCallback, useEffect, useState } from 'react';
import { call, can, type Me } from '../lib/client';
import { UploadPanel } from '../components/ops/UploadPanel';
import { ProgressBar, StatusBadge, TypeTag, type TypeInfo } from './shared';

export interface DocumentSummary {
  id: string;
  title: string;
  documentType: { key: string; name: string } | null;
  typeSource: string;
  classification: TypeInfo['classification'];
  currentVersion: { id: string; number: number };
  submittedAt: string;
  status: string;
  statusLabel: string;
  nextAction: string;
  failureReason: string | null;
  progress: null | { total: number; pending: number; gaps: number; approved: number; autoApproved: number; corrected: number; carriedOver: number; failedChecks: number };
  relatedDocuments: number;
  warning: string | null;
  extractionStatus: 'queued' | 'extracting' | 'extracted' | 'failed' | 'superseded';
  receipts: { total: number; revisions: number; identicalResends: number; resendChannels: string[] };
}

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];
const STATUS_FILTERS = [
  ['', 'All'],
  ['awaiting_review', 'Ready for review'],
  ['partially_reviewed', 'Review in progress'],
  ['approved', 'Approved'],
  ['completed', 'Completed'],
  ['needs_type', 'Needs document type'],
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
  const [showUpload, setShowUpload] = useState(false);

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
      })
      .catch(() => setTypes([]));
  }, [tenant]);

  const waiting = items.filter((i) => ['awaiting_review', 'partially_reviewed'].includes(i.status)).length;
  const startReviewing = async () => {
    const next = await call<{ documentId: string | null }>('documents.next', { tenant });
    if (next.documentId) window.location.hash = `/documents/${next.documentId}`;
  };
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
        <div className="head-actions">
          {can(me, tenant, 'documents.submit') && (
            <button onClick={() => setShowUpload((v) => !v)}>{showUpload ? 'Close upload' : 'Upload documents'}</button>
          )}
          {can(me, tenant, 'reviews.decide') && (
            <button className="btn-primary" disabled={waiting === 0} onClick={() => void startReviewing()}>
              {waiting ? `Start reviewing (${waiting})` : 'Nothing to review'}
            </button>
          )}
        </div>
      </div>
      {showUpload && (
        <section className="card">
          <UploadPanel
            tenant={tenant}
            compact
            onSubmitted={(results) => {
              const ok = results.filter((r) => r.ok && r.outcome !== 'duplicate_exact').length;
              const dup = results.filter((r) => r.outcome === 'duplicate_exact').length;
              const bad = results.filter((r) => !r.ok);
              setNotice([ok && `${ok} document${ok === 1 ? '' : 's'} received — processing has started.`, dup && `${dup} already received before.`, bad.length && `Rejected: ${bad.map((b) => `${b.filename} (${b.error})`).join(', ')}`].filter(Boolean).join(' '));
              setShowUpload(false);
              void load();
            }}
          />
        </section>
      )}
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
            <th>Extraction</th>
            <th>Status</th>
            <th>Review progress</th>
            <th>Next action</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} onClick={() => (window.location.hash = `/documents/${d.id}`)} className={d.status === 'failed_operator' ? 'row-hold' : d.status === 'needs_type' ? 'row-action' : ''}>
              <td>
                <a href={`#/documents/${d.id}`}>{d.title}</a>
                {d.receipts.revisions > 0 && <span className="tag tag-info" title="A revised version arrived; unchanged reviews were carried over">revised · v{d.currentVersion.number}</span>}
                {d.receipts.identicalResends > 0 && (
                  <span className="tag tag-muted" title={`The identical file arrived again (${d.receipts.resendChannels.join(', ')}); it was recorded, not reprocessed`}>
                    re-sent ×{d.receipts.identicalResends}
                  </span>
                )}
                {d.relatedDocuments > 0 && <span className="tag" title="Another document carries the same identifying values (e.g. vendor and invoice number). Not merged.">possible duplicate</span>}
                {d.warning && <span className="tag tag-bad" title={d.warning}>check document type</span>}
              </td>
              <td><TypeTag doc={d} /></td>
              <td>v{d.currentVersion.number}</td>
              <td>{new Date(d.submittedAt).toLocaleString()}</td>
              <td><span className={`xs xs-${d.extractionStatus}`}>{d.extractionStatus}</span></td>
              <td><StatusBadge status={d.status} label={d.statusLabel} /></td>
              <td>{d.progress ? <ProgressBar progress={d.progress} /> : <span className="muted">—</span>}</td>
              <td className={['awaiting_review', 'partially_reviewed', 'approved'].includes(d.status) ? 'next-action strong' : 'next-action'}>{d.nextAction}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={8} className="empty">No documents match.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
