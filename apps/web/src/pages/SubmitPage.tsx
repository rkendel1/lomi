import React, { useCallback, useEffect, useState } from 'react';
import { call, type IngressInfo, type SubmissionResult } from '../lib/client';
import { UploadPanel } from '../components/ops/UploadPanel';
import { StatusBadge, TypeChooser, TypeTag, type TypeInfo } from './shared';

interface MyDocument extends TypeInfo {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  nextAction: string;
  failureReason: string | null;
  submittedAt: string;
  currentVersion: { number: number };
  receipts: { identicalResends: number };
}

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];

/** What the person who sent a document needs to know, in their terms. */
function whatNext(d: MyDocument): string {
  if (IN_FLIGHT.includes(d.status)) return d.documentType ? 'Reading and checking…' : 'Reading it and working out what kind of document it is…';
  if (d.status === 'needs_type') return 'Lomi could not tell what kind of document this is. Choose below and it is processed straight away.';
  if (d.status === 'failed_operator') return d.nextAction;
  if (d.status === 'superseded') return 'Replaced by a newer version.';
  if (d.status === 'approved' || d.status === 'completed') return 'Reviewed and approved.';
  return 'Checked automatically — with the reviewers now.';
}

/**
 * A customer's intake page (`/in/{tenant}`), the submitter's workspace: send
 * documents (Lomi identifies each one's type), then follow everything you sent
 * — not just this session — until it is reviewed. Documents Lomi could not
 * identify ask the sender, who knows what they sent.
 */
export const SubmitPage: React.FC<{ tenant: string; tenantName: string }> = ({ tenant, tenantName }) => {
  const [info, setInfo] = useState<IngressInfo | null>(null);
  const [mine, setMine] = useState<MyDocument[] | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showIntegration, setShowIntegration] = useState(false);

  useEffect(() => {
    void call<IngressInfo>('ingress.get', { tenant }).then(setInfo).catch(() => setInfo(null));
  }, [tenant]);

  const load = useCallback(async () => {
    try {
      setMine((await call<{ items: MyDocument[] }>('documents.list', { tenant, mine: true, limit: 50 })).items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tenant]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!mine?.some((d) => IN_FLIGHT.includes(d.status))) return;
    const timer = setTimeout(() => void load(), 1000);
    return () => clearTimeout(timer);
  }, [mine, load]);

  const onSubmitted = (results: SubmissionResult[]) => {
    const rejected = results.filter((r) => !r.ok).map((r) => `${r.filename}: ${r.error}`);
    const resent = results.filter((r) => r.ok && r.outcome === 'duplicate_exact').map((r) => `${r.filename} was already received — nothing new was created.`);
    setNotices([...rejected, ...resent]);
    void load();
  };

  const waiting = mine?.filter((d) => d.status === 'needs_type') ?? [];
  const origin = window.location.origin;
  return (
    <div className="page submit-page">
      <div className="page-head">
        <div>
          <h1>Send documents to {tenantName}</h1>
          <p className="muted">Drop in PDFs — one or many, any mix. Lomi works out what each one is, reads it, checks it, and passes it to {tenantName}'s reviewers.</p>
        </div>
      </div>

      <section className="card">
        <UploadPanel tenant={tenant} onSubmitted={onSubmitted} />
        {notices.map((n) => (
          <div key={n} className="notice">{n}</div>
        ))}
      </section>

      {waiting.length > 0 && (
        <section className="card card-action">
          <h2>{waiting.length === 1 ? '1 document needs' : `${waiting.length} documents need`} you to say what it is</h2>
          {waiting.map((d) => (
            <div key={d.id} className="needs-type-row">
              <strong>{d.title}</strong>
              <TypeChooser tenant={tenant} documentId={d.id} reason={d.failureReason} scores={d.classification?.scores} onChosen={() => void load()} />
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>What you've sent</h2>
        {error && <div className="error">{error}</div>}
        {mine === null ? (
          <p className="muted">Loading…</p>
        ) : mine.length === 0 ? (
          <p className="muted">Nothing yet. Documents you send appear here with their live status.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Document</th><th>Type</th><th>Status</th><th>What happens next</th><th>Sent</th></tr>
            </thead>
            <tbody>
              {mine.map((d) => (
                <tr key={d.id} className={d.status === 'needs_type' ? 'row-action' : ''}>
                  <td>
                    {d.title}
                    {d.currentVersion.number > 1 && <span className="small muted"> · v{d.currentVersion.number}</span>}
                    {d.receipts.identicalResends > 0 && <span className="small muted"> · re-sent ×{d.receipts.identicalResends}</span>}
                  </td>
                  <td><TypeTag doc={d} /></td>
                  <td><StatusBadge status={d.status} label={d.statusLabel} /></td>
                  <td className="small">{whatNext(d)}</td>
                  <td className="small muted">{new Date(d.submittedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card ingress-card">
        <button className="btn-link" aria-expanded={showIntegration} onClick={() => setShowIntegration(!showIntegration)}>
          {showIntegration ? '▾' : '▸'} Sending from another system?
        </button>
        {showIntegration && (
          <>
            <p className="small muted">One address for this customer. People can open it to upload; systems can post to it.</p>
            <label className="small">For people</label>
            <code className="url">{origin}{info?.submissionPage ?? `/in/${tenant}`}</code>
            <label className="small">For integrations (electronic, single or bulk)</label>
            <code className="url">POST {origin}{info?.apiEndpoint ?? `/api/in/${tenant}/documents`}</code>
            <p className="small muted">
              Send <code>application/pdf</code>, or <code>multipart/form-data</code> with one or more <code>file</code> parts, using a submitter token.
              Leave out <code>documentType</code> and Lomi identifies each file.{' '}
              <a href="/api/docs#tag/Ingress" target="_blank" rel="noreferrer">API reference</a>
            </p>
          </>
        )}
      </section>
    </div>
  );
};
