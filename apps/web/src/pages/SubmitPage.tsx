import React, { useCallback, useEffect, useState } from 'react';
import { call, type IngressInfo, type SubmissionResult } from '../lib/client';
import { UploadPanel } from '../components/ops/UploadPanel';
import { StatusBadge } from './shared';

interface Tracked extends SubmissionResult {
  status?: string;
  statusLabel?: string;
  nextAction?: string;
  submittedAt: number;
}

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];

/**
 * A customer's intake page (`/in/{tenant}`): submit documents by hand, or copy the
 * URL integrations post to. Each submission is followed live until it is ready
 * for Lomi's automated checks and human review.
 */
export const SubmitPage: React.FC<{ tenant: string; tenantName: string }> = ({ tenant, tenantName }) => {
  const [info, setInfo] = useState<IngressInfo | null>(null);
  const [tracked, setTracked] = useState<Tracked[]>([]);

  useEffect(() => {
    void call<IngressInfo>('ingress.get', { tenant }).then(setInfo).catch(() => setInfo(null));
  }, [tenant]);

  const refresh = useCallback(async (items: Tracked[]) => {
    return Promise.all(
      items.map(async (t) => {
        if (!t.ok || !t.documentId || (t.status && !IN_FLIGHT.includes(t.status))) return t;
        try {
          const p = await call('documents.progress', { tenant, documentId: t.documentId });
          return { ...t, status: p.status, statusLabel: p.statusLabel, nextAction: p.nextAction };
        } catch {
          return t;
        }
      })
    );
  }, [tenant]);

  useEffect(() => {
    if (!tracked.some((t) => t.ok && (!t.status || IN_FLIGHT.includes(t.status)))) return;
    const timer = setTimeout(() => void refresh(tracked).then(setTracked), 700);
    return () => clearTimeout(timer);
  }, [tracked, refresh]);

  const origin = window.location.origin;
  return (
    <div className="page submit-page">
      <div className="page-head">
        <div>
          <h1>Submit documents to {tenantName}</h1>
          <p className="muted">Documents sent here are processed immediately, checked automatically, and queued for {tenantName}'s reviewers.</p>
        </div>
      </div>

      <div className="submit-grid">
        <section className="card">
          <h2>Upload</h2>
          <UploadPanel
            tenant={tenant}
            onSubmitted={(results) =>
              void refresh(results.map((r) => ({ ...r, submittedAt: Date.now() }))).then((fresh) => setTracked((prev) => [...fresh, ...prev]))
            }
          />
        </section>

        <aside className="card ingress-card">
          <h2>Your intake URL</h2>
          <p className="small muted">One address for this customer. People can open it to upload; systems can post to it.</p>
          <label className="small">For people</label>
          <code className="url">{origin}{info?.submissionPage ?? `/in/${tenant}`}</code>
          <label className="small">For integrations (electronic, single or bulk)</label>
          <code className="url">POST {origin}{info?.apiEndpoint ?? `/api/in/${tenant}/documents`}</code>
          <p className="small muted">
            Send <code>application/pdf</code>, or <code>multipart/form-data</code> with one or more <code>file</code> parts, using a submitter token.{' '}
            <a href="/api/docs#tag/Ingress" target="_blank" rel="noreferrer">API reference</a>
          </p>
        </aside>
      </div>

      <section className="card">
        <h2>Submitted in this session</h2>
        {tracked.length === 0 ? (
          <p className="muted">Nothing yet. Submitted documents appear here with their live status.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>File</th><th>Status</th><th>What happens next</th></tr>
            </thead>
            <tbody>
              {tracked.map((t, i) => (
                <tr key={`${t.filename}-${i}`}>
                  <td>{t.filename}</td>
                  <td>
                    {!t.ok ? <span className="badge badge-bad">Rejected</span>
                      : t.outcome === 'duplicate_exact' ? <span className="badge badge-muted">Already received</span>
                      : t.status ? <StatusBadge status={t.status} label={t.statusLabel ?? t.status} />
                      : <span className="badge badge-info">Received</span>}
                  </td>
                  <td className="small">
                    {!t.ok ? t.error
                      : t.outcome === 'duplicate_exact' ? 'This exact file was received before; nothing new was created.'
                      : t.status && !IN_FLIGHT.includes(t.status) ? (t.status === 'failed_operator' ? t.nextAction : 'Checked automatically — waiting for human review')
                      : 'Reading and checking…'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
