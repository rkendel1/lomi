import React, { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../lib/client';

interface Run {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  steps: Array<{ at: string; text: string }>;
  tenants: Array<{ slug: string; name: string }>;
  submitted: number;
  error: string | null;
}

/** Where each scenario shows up once the demo workload is loaded. */
const GUIDE: Array<[string, string]> = [
  ['Operations → Failures', 'unreadable uploads held for Lomi, with Retry'],
  ['Documents → status "Needs document type"', 'packing slips no form describes: map them, or have the sender choose'],
  ['Documents (Harborline)', 'clean invoices to review; failed checks (totals, due date before issue, over limit); gaps'],
  ['Tags in the list', '"possible duplicate", "re-sent ×N", "revised · v2" with carried-over reviews'],
  ['Supplier onboarding', 'identified by layout and read by position (printed and fillable); the 2027 edition → Capture more…'],
  ['Documents → Records', 'the normalized table per form, with CSV'],
  ['Operations KPIs', 'processing and review times, correction rates, per-customer workload'],
];

/**
 * Operators on demo deployments: load two demo customers with a realistic
 * workload, processed live by the worker, to walk through every scenario.
 */
export const DemoWorkload: React.FC<{ onLoaded: (slug: string) => void; onProgress: () => void }> = ({ onLoaded, onProgress }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The parent's callback changes every render; keep the latest without re-creating the poller.
  const progress = useRef(onProgress);
  progress.current = onProgress;

  const poll = useCallback(async () => {
    try {
      const s = await call<{ enabled: boolean; run: Run | null }>('demo.status');
      setEnabled(s.enabled);
      setRun((prev) => {
        // Refresh the operations figures while documents arrive, and once more at the end.
        if (s.run && (s.run.status === 'running' || prev?.status === 'running')) progress.current();
        return s.run;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void poll(), [poll]);
  useEffect(() => {
    if (run?.status !== 'running') return;
    const t = setTimeout(() => void poll(), 2000);
    return () => clearTimeout(t);
  }, [run, poll]);

  if (enabled === false) return null;
  const load = async () => {
    setError(null);
    try {
      setRun(await call<Run>('demo.load'));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const running = run?.status === 'running';
  return (
    <section className="card demo-card">
      <div className="page-head">
        <div>
          <h2>Demo workload</h2>
          <p className="small muted">
            Adds two demo customers (Harborline Freight, Pinecrest Clinics), their forms, and about 120 documents sent through the real intake.
            The worker processes them live; then a demo reviewer approves some, revisions and re-sends arrive, and outputs are generated.
            Running it again adds another batch.
          </p>
        </div>
        <button className="btn-primary" disabled={running} onClick={() => void load()}>
          {running ? `Loading… ${run?.submitted ?? 0} sent` : run?.status === 'done' ? 'Load another batch' : 'Load demo workload'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {run && (
        <>
          <ol className="demo-steps small" aria-live="polite">
            {run.steps.map((s, i) => <li key={i}><span className="muted">{new Date(s.at).toLocaleTimeString()}</span> {s.text}</li>)}
          </ol>
          {run.status === 'failed' && <div className="error">The run stopped: {run.error}. What was already sent stays and is processed.</div>}
          {run.status !== 'running' && (
            <div className="form-row">
              {run.tenants.map((t) => <button key={t.slug} onClick={() => onLoaded(t.slug)}>Show {t.name}</button>)}
            </div>
          )}
        </>
      )}
      <details className="demo-guide">
        <summary>Where to look</summary>
        <ul className="small">
          {GUIDE.map(([where, what]) => <li key={where}><strong>{where}</strong> — {what}</li>)}
        </ul>
      </details>
    </section>
  );
};
