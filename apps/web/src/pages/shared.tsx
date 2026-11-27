import React from 'react';
import { call, type IngressInfo } from '../lib/client';

const STATUS_TONE: Record<string, string> = {
  received: 'info', queued: 'info', parsing: 'info', extracting: 'info', validating: 'info',
  awaiting_review: 'action', partially_reviewed: 'action',
  approved: 'good', completed: 'good',
  failed_retryable: 'warn', failed_operator: 'bad', needs_type: 'action', superseded: 'muted',
};

export const StatusBadge: React.FC<{ status: string; label: string }> = ({ status, label }) => (
  <span className={`badge badge-${STATUS_TONE[status] ?? 'muted'}`}>{label}</span>
);

export interface Progress {
  total: number;
  pending: number;
  gaps: number;
  approved: number;
  autoApproved: number;
  corrected: number;
  carriedOver: number;
  failedChecks: number;
}

/** Decided vs open fields, with the open part split into "needs review" and "missing". */
export const ProgressBar: React.FC<{ progress: Progress }> = ({ progress: p }) => {
  const decided = p.approved + p.autoApproved + p.corrected + p.carriedOver;
  const pct = (n: number) => (p.total ? `${(n / p.total) * 100}%` : '0%');
  return (
    <div className="progress" title={`${decided} of ${p.total} decided`}>
      <div className="progress-track">
        <span className="seg seg-done" style={{ width: pct(decided) }} />
        <span className="seg seg-pending" style={{ width: pct(p.pending) }} />
        <span className="seg seg-gap" style={{ width: pct(p.gaps) }} />
      </div>
      <span className="progress-label">{decided}/{p.total}</span>
    </div>
  );
};

export const ProgressCounts: React.FC<{ progress: Progress }> = ({ progress: p }) => (
  <ul className="counts" aria-label="Review progress">
    <li className="c-pending"><strong>{p.pending}</strong> pending</li>
    <li className="c-gap"><strong>{p.gaps}</strong> missing</li>
    <li className="c-approved"><strong>{p.approved + p.autoApproved}</strong> approved</li>
    <li className="c-corrected"><strong>{p.corrected}</strong> corrected</li>
    <li className="c-carried"><strong>{p.carriedOver}</strong> carried over</li>
    <li className="c-failed"><strong>{p.failedChecks}</strong> failed checks</li>
  </ul>
);

export const STATE_LABELS: Record<string, string> = {
  pending: 'Needs review',
  gap: 'Missing',
  approved: 'Approved',
  auto_approved: 'Approved by policy',
  corrected: 'Corrected',
  carried_over: 'Carried over',
};

export interface TypeInfo {
  documentType: { key: string; name: string } | null;
  typeSource?: string;
  classification?: { scores?: Array<{ key: string; score: number }>; typeKey?: string | null } | null;
}

/** The document's type and how it was decided (sent with it, identified by Laya, chosen by a person…). */
export const TypeTag: React.FC<{ doc: TypeInfo }> = ({ doc }) => {
  if (!doc.documentType) return <span className="muted">{doc.typeSource === 'pending' ? 'Not identified yet' : '—'}</span>;
  const score = doc.classification?.scores?.find((s) => s.key === doc.documentType?.key)?.score;
  const how =
    doc.typeSource === 'detected' ? `identified automatically${score !== undefined ? ` (Laya ${score.toFixed(2)})` : ''}`
    : doc.typeSource === 'person' ? 'chosen by a person'
    : doc.typeSource === 'only_type' ? 'the only form set up'
    : doc.typeSource === 'ingress_default' ? 'intake default'
    : null;
  return (
    <span className="type-tag">
      {doc.documentType.name}
      {how && <span className="small muted"> · {how}</span>}
    </span>
  );
};

/**
 * Lomi could not tell which kind of document this is: a person chooses, and
 * processing continues on its own. Options are the customer's published forms.
 */
export const TypeChooser: React.FC<{
  tenant: string;
  documentId: string;
  reason?: string | null;
  scores?: Array<{ key: string; score: number }>;
  onChosen: () => void;
}> = ({ tenant, documentId, reason, scores, onChosen }) => {
  const [types, setTypes] = React.useState<Array<{ key: string; name: string }>>([]);
  const [choice, setChoice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    void call<IngressInfo>('ingress.get', { tenant })
      .then((i) => {
        // Most likely first, when Laya gave scores.
        const rank = (k: string) => -(scores?.find((s) => s.key === k)?.score ?? 0);
        const sorted = [...i.documentTypes].sort((a, b) => rank(a.key) - rank(b.key));
        setTypes(sorted);
        setChoice(sorted[0]?.key ?? '');
      })
      .catch((e) => setError(e.message));
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('documents.type.set', { tenant, documentId, documentType: choice });
      onChosen();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="type-chooser" onClick={(e) => e.stopPropagation()}>
      {reason && <p className="small muted">{reason}</p>}
      {types.length === 0 ? (
        <p className="small">No forms are set up for this customer yet. Lomi has been asked to add one.</p>
      ) : (
        <div className="form-row">
          <label>
            This document is a
            <select aria-label="Choose document type" value={choice} onChange={(e) => setChoice(e.target.value)}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>{t.name}</option>
              ))}
            </select>
          </label>
          <button className="btn-primary" disabled={!choice || busy} onClick={() => void choose()}>
            {busy ? 'Saving…' : 'Process as this type'}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
};
