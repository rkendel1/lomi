import React from 'react';

const STATUS_TONE: Record<string, string> = {
  received: 'info', queued: 'info', parsing: 'info', extracting: 'info', validating: 'info',
  awaiting_review: 'action', partially_reviewed: 'action',
  approved: 'good', completed: 'good',
  failed_retryable: 'warn', failed_operator: 'bad', superseded: 'muted',
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
