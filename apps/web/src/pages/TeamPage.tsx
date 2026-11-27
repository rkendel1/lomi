import React, { useCallback, useEffect, useState } from 'react';
import { call, type IngressInfo, type Me } from '../lib/client';

interface Member {
  principalId: string;
  name: string;
  email: string | null;
  kind: string;
  role: string;
  delegatedBy: string | null;
  addedAt: string;
}

const ROLES: Array<{ key: string; name: string; does: string }> = [
  { key: 'customer_admin', name: 'Admin', does: 'Manages the team and model settings, sees operations, reviews and submits.' },
  { key: 'reviewer', name: 'Reviewer', does: 'Checks extracted values against the document, corrects and approves.' },
  { key: 'submitter', name: 'Submitter', does: 'Sends documents and follows what they sent.' },
  { key: 'viewer', name: 'Viewer', does: 'Reads documents and results; changes nothing.' },
];
const roleName = (key: string) => ROLES.find((r) => r.key === key)?.name ?? (key === 'agent' ? 'Agent' : key);

/**
 * The customer admin's workspace: who has access and with which role, and
 * what this customer's intake accepts. Lomi operators see the same page for
 * any customer.
 */
export const TeamPage: React.FC<{ tenant: string; tenantName: string; me: Me }> = ({ tenant, tenantName, me }) => {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [intake, setIntake] = useState<IngressInfo | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'reviewer' });
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers((await call<{ items: Member[] }>('members.list', { tenant })).items);
      setIntake(await call<IngressInfo>('ingress.get', { tenant }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tenant]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = () =>
    act(async () => {
      const r = await call<{ name: string; signInToken: string | null }>('members.add', { tenant, ...form });
      setIssued(r.signInToken ? { name: r.name, token: r.signInToken } : null);
      setForm({ name: '', email: '', role: form.role });
    }, `${form.name} now has access as ${roleName(form.role)}.`);

  const people = members?.filter((m) => m.kind !== 'agent') ?? [];
  const agents = members?.filter((m) => m.kind === 'agent') ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Team · {tenantName}</h1>
          <p className="muted">Who can see and act on {tenantName}'s documents. Every change is recorded in the audit log.</p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {issued && (
        <div className="notice token-notice">
          <strong>Sign-in token for {issued.name}</strong> — shown once; Lomi stores only its hash. Send it to them securely; they paste it on the sign-in page.
          <code className="url">{issued.token}</code>
          <button className="btn-link" onClick={() => setIssued(null)}>I've copied it</button>
        </div>
      )}

      <section className="card">
        <h2>Add a person</h2>
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label>Name<input aria-label="Member name" value={form.name} placeholder="Jordan Lee" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email<input aria-label="Member email" type="email" value={form.email} placeholder="jordan@example.com" onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Role
            <select aria-label="Member role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </select>
          </label>
          <button className="btn-primary" type="submit" disabled={!form.name.trim() || !form.email.trim()}>Add</button>
        </form>
        <p className="small muted">{ROLES.find((r) => r.key === form.role)?.does}</p>
      </section>

      <section className="card">
        <h2>People ({people.length})</h2>
        {members === null ? <p className="muted">Loading…</p> : (
          <table className="table stack">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Since</th><th /></tr></thead>
            <tbody>
              {people.map((m) => (
                <tr key={m.principalId}>
                  <td data-label="Name">{m.name.replace(/\s*\(.*\)$/, '')}{m.principalId === me.id && <span className="small muted"> (you)</span>}</td>
                  <td data-label="Email" className="small">{m.email}</td>
                  <td data-label="Role">
                    <select
                      aria-label={`Role of ${m.name}`}
                      value={m.role}
                      onChange={(e) => void act(() => call('members.role.change', { tenant, principalId: m.principalId, role: e.target.value }), `${m.name} is now ${roleName(e.target.value)}.`)}
                    >
                      {ROLES.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select>
                  </td>
                  <td data-label="Since" className="small muted">{new Date(m.addedAt).toLocaleDateString()}</td>
                  <td data-label="">
                    <button
                      className="btn-link"
                      onClick={() => {
                        if (window.confirm(`Remove ${m.name}'s access to ${tenantName}? Agents acting for them lose access too.`)) {
                          void act(() => call('members.remove', { tenant, principalId: m.principalId }), `${m.name} no longer has access.`);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {agents.length > 0 && (
          <>
            <h3>Agents</h3>
            <ul className="list">
              {agents.map((a) => (
                <li key={a.principalId}>{a.name} <span className="small muted">acts for {a.delegatedBy ?? 'nobody'}; can only propose changes, never decide</span></li>
              ))}
            </ul>
          </>
        )}
      </section>

      {intake && (
        <section className="card">
          <h2>Intake</h2>
          <p className="small">
            {intake.enabled ? 'Accepting documents' : 'Not accepting documents'} at <code>{window.location.origin}{intake.submissionPage}</code>
            {intake.defaultDocumentType ? ` — everything sent is treated as ${intake.defaultDocumentType}.` : ' — each document is identified automatically.'}
          </p>
          <p className="small muted">
            Forms set up: {intake.documentTypes.map((t) => t.name).join(', ') || 'none yet'}. Lomi sets up and changes forms; ask your Lomi contact for a new one.
          </p>
        </section>
      )}
    </div>
  );
};
