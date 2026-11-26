import React, { useCallback, useEffect, useState } from 'react';
import { call, can, type Me } from '../lib/client';

interface Stats {
  documents: { received: number; processed: number; inProgress: number; awaitingReview: number; failedNeedsOperator: number; failedRetrying: number };
  medianProcessingSeconds: number | null;
  medianReviewSeconds: number | null;
  failureReasons: Array<{ reason: string; count: number }>;
  corrections: Array<{ semantic_key: string; document_type: string; template_version: number; corrected: number; reviewed: number; correctionRate: number }>;
  semanticVsHuman: Array<{ model: string; outcome: string; human_approved: number; human_corrected: number }>;
  byTenant: Array<{ slug: string; name: string; documents: number; needs_operator: number; awaiting_review: number }>;
}

const secs = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Operational visibility for Lomi operators (all customers) and customer admins (their own). */
export const OperationsPage: React.FC<{
  tenant: string;
  tenants: Array<{ slug: string; name: string }>;
  me: Me;
  onTenantChange: (slug: string) => void;
  onTenantsChanged: () => void;
}> = ({ tenant, tenants, me, onTenantChange, onTenantsChanged }) => {
  const [scope, setScope] = useState<'tenant' | 'all'>(me.operator ? 'all' : 'tenant');
  const [stats, setStats] = useState<Stats | null>(null);
  const [failures, setFailures] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTenant, setNewTenant] = useState({ slug: '', name: '' });

  const load = useCallback(async () => {
    try {
      const input = scope === 'all' ? {} : { tenant };
      setStats(await call<Stats>('operations.stats', input));
      setFailures((await call<{ items: any[] }>('operations.failures', input)).items);
      if (me.operator) setProviders((await call<{ items: any[] }>('operations.providers')).items);
      const tenants = (await call<{ items: any[] }>('tenants.list')).items;
      setModels(tenants.find((t) => t.slug === tenant)?.models ?? {});
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, tenant, me.operator]);

  useEffect(() => void load(), [load]);

  const retry = async (f: any) => {
    try {
      await call('operations.retry', { tenant: f.tenant, jobId: f.jobId });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setPolicy = async (patch: Record<string, unknown>) => {
    try {
      setModels(await call('tenants.models.configure', { tenant, ...patch }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Operations</h1>
          <p className="muted">All figures are computed from recorded processing and review history.</p>
        </div>
        {me.operator && (
          <label className="scope-select">
            <span>Showing</span>
            <select
              aria-label="Customer scope"
              value={scope === 'all' ? '*' : tenant}
              onChange={(e) => {
                if (e.target.value === '*') setScope('all');
                else {
                  setScope('tenant');
                  onTenantChange(e.target.value);
                }
              }}
            >
              <option value="*">All customers</option>
              {tenants.map((t) => (
                <option key={t.slug} value={t.slug}>{t.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && <div className="error">{error}</div>}

      {stats && (
        <>
          <div className="kpis">
            <div className="kpi"><span>Received</span><strong>{stats.documents.received}</strong></div>
            <div className="kpi"><span>Processed</span><strong>{stats.documents.processed}</strong></div>
            <div className="kpi"><span>Awaiting review</span><strong>{stats.documents.awaitingReview}</strong></div>
            <div className="kpi kpi-bad"><span>Need Lomi</span><strong>{stats.documents.failedNeedsOperator}</strong></div>
            <div className="kpi"><span>Retrying</span><strong>{stats.documents.failedRetrying}</strong></div>
            <div className="kpi"><span>Median processing</span><strong>{secs(stats.medianProcessingSeconds)}</strong></div>
            <div className="kpi"><span>Median review</span><strong>{secs(stats.medianReviewSeconds)}</strong></div>
          </div>

          {stats.byTenant.length > 0 && (
            <section className="card">
              <h2>Customers needing attention</h2>
              <table className="table">
                <thead><tr><th>Customer</th><th>Documents</th><th>Awaiting review</th><th>Need Lomi</th></tr></thead>
                <tbody>
                  {stats.byTenant.map((t) => (
                    <tr key={t.slug} className={t.needs_operator ? 'row-hold clickable' : 'clickable'} onClick={() => { setScope('tenant'); onTenantChange(t.slug); }}><td><a href="#/operations" onClick={(e) => e.preventDefault()}>{t.name}</a></td><td>{t.documents}</td><td>{t.awaiting_review}</td><td>{t.needs_operator}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            <h2>Failures</h2>
            {failures.length === 0 ? <p className="muted">Nothing is failing.</p> : (
              <table className="table">
                <thead><tr><th>Customer</th><th>Document</th><th>Work</th><th>Reason</th><th>Action</th><th /></tr></thead>
                <tbody>
                  {failures.map((f) => (
                    <tr key={f.jobId}>
                      <td>{f.tenant}</td>
                      <td>{f.documentId ? <a href={`#/documents/${f.documentId}`}>{f.title} v{f.version}</a> : '—'}</td>
                      <td>{f.kind === 'process_version' ? 'Processing' : 'Output generation'} · attempt {f.attempts}/{f.maxAttempts}</td>
                      <td className="small">{f.reason}</td>
                      <td className="small">{f.action}</td>
                      <td>{f.retryable && (me.operator || can(me, f.tenant, 'operations.retry')) && <button onClick={() => void retry(f)}>Retry</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {stats.failureReasons.length > 0 && (
              <p className="small muted">Most common: {stats.failureReasons.map((r) => `${r.reason} (${r.count})`).join('; ')}</p>
            )}
          </section>

          <section className="card">
            <h2>Fields most often corrected</h2>
            {stats.corrections.length === 0 ? <p className="muted">No human decisions yet.</p> : (
              <table className="table">
                <thead><tr><th>Field</th><th>Document type</th><th>Template</th><th>Corrected / reviewed</th><th>Correction rate</th></tr></thead>
                <tbody>
                  {stats.corrections.map((c, i) => (
                    <tr key={i}><td className="mono">{c.semantic_key}</td><td>{c.document_type}</td><td>v{c.template_version}</td><td>{c.corrected} / {c.reviewed}</td><td>{Math.round(c.correctionRate * 100)}%</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {stats.semanticVsHuman.length > 0 && (
            <section className="card">
              <h2>Model checks vs. reviewer decisions</h2>
              <p className="small muted">Collected so confidence thresholds can be calibrated against real outcomes. Model confidence is not treated as a probability.</p>
              <table className="table">
                <thead><tr><th>Model</th><th>Check outcome</th><th>Reviewer approved</th><th>Reviewer corrected</th></tr></thead>
                <tbody>
                  {stats.semanticVsHuman.map((r, i) => (
                    <tr key={i}><td className="small">{r.model}</td><td>{r.outcome}</td><td>{r.human_approved}</td><td>{r.human_corrected}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {(me.operator || can(me, tenant, 'models.authorize')) && models && (
        <section className="card">
          <h2>Model processing for {tenant}</h2>
          <div className="form-row">
            <label>
              Semantic checks
              <select aria-label="Semantic provider" value={models.semantic ?? ''} onChange={(e) => void setPolicy({ semantic: e.target.value || undefined })}>
                <option value="">Deployment default (local)</option>
                <option value="laya">Laya (local, in Lomi's infrastructure)</option>
                <option value="anthropic">Anthropic (external)</option>
                <option value="none">None (reviewers check manually)</option>
              </select>
            </label>
            <label>
              Fallback if the local model is unavailable
              <select aria-label="Semantic fallback" value={models.semanticFallback ?? 'none'} onChange={(e) => void setPolicy({ semanticFallback: e.target.value })}>
                <option value="none">None — stop and alert Lomi</option>
                <option value="anthropic">Anthropic (external)</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={Boolean(models.externalProcessing?.allowed)} onChange={(e) => void setPolicy({ externalProcessingAllowed: e.target.checked })} />
              Customer authorizes sending document content to external model providers
            </label>
          </div>
          {models.externalProcessing?.allowed && <p className="small muted">Authorized {models.externalProcessing.authorizedAt ? new Date(models.externalProcessing.authorizedAt).toLocaleString() : ''}.</p>}
        </section>
      )}

      {me.operator && (
        <>
          <section className="card">
            <h2>Model providers on workers</h2>
            {providers.length === 0 ? <p className="muted">No worker has reported yet.</p> : (
              <table className="table">
                <thead><tr><th>Worker</th><th>Role</th><th>Provider</th><th>Ready</th><th>Detail</th><th>Checked</th></tr></thead>
                <tbody>
                  {providers.map((p, i) => (
                    <tr key={i} className={p.ready ? '' : 'row-hold'}>
                      <td>{p.workerId}</td><td>{p.role}</td><td>{p.provider}</td><td>{p.ready ? 'yes' : 'no'}{p.stale ? ' (stale)' : ''}</td>
                      <td className="small">{p.model ?? p.detail}</td><td className="small">{new Date(p.checkedAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card">
            <h2>New customer</h2>
            <form
              className="form-row"
              onSubmit={(e) => {
                e.preventDefault();
                void call('tenants.create', newTenant).then(() => { setNewTenant({ slug: '', name: '' }); onTenantsChanged(); }, (err) => setError(err.message));
              }}
            >
              <label>Short name<input aria-label="Tenant slug" value={newTenant.slug} placeholder="acme" onChange={(e) => setNewTenant({ ...newTenant, slug: e.target.value })} /></label>
              <label>Name<input aria-label="Tenant name" value={newTenant.name} placeholder="Acme Corp" onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })} /></label>
              <button className="btn-primary" type="submit">Create customer</button>
            </form>
            <p className="small muted">New customers get portal and API ingress endpoints. Configure document types and templates in Schema Studio.</p>
          </section>
        </>
      )}
    </div>
  );
};
