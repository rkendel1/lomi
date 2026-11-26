import React, { useEffect, useState } from 'react';
import { devUsers, type DevUser } from '../lib/client';

const EXPERIENCES: Array<{ key: DevUser['experience']; title: string; icon: string; description: string }> = [
  {
    key: 'operations',
    title: 'Lomi Operations',
    icon: '⚙',
    description: 'Run customer workflows: configure templates in Schema Studio, watch processing health, resolve failures, manage customers.',
  },
  {
    key: 'review',
    title: 'Customer review',
    icon: '✓',
    description: 'Review extracted values against the original document, correct what is wrong, and approve. The next document opens automatically.',
  },
  {
    key: 'submission',
    title: 'Document submission',
    icon: '⇪',
    description: "Send documents to your company's Lomi intake URL — one at a time or in bulk — and follow them as they are processed.",
  },
];

/** Choose a workspace, then an identity. Demo identities are offered only in development mode. */
export const Login: React.FC<{ onToken: (token: string) => void }> = ({ onToken }) => {
  const [users, setUsers] = useState<DevUser[] | null>(null);

  useEffect(() => {
    void devUsers().then(setUsers);
  }, []);

  return (
    <div className="login">
      <div className="login-wrap">
        <header className="login-head">
          <h1>Lomi Document Operations</h1>
          <p>Documents in, reviewed business data out — with the evidence for every value.</p>
        </header>
        <h2 className="login-prompt">Choose your workspace</h2>
        <div className="experiences">
          {EXPERIENCES.map((e) => {
            const people = (users ?? []).filter((u) => u.experience === e.key);
            return (
              <section key={e.key} className={`experience experience-${e.key}`} aria-label={e.title}>
                <div className="experience-icon" aria-hidden>{e.icon}</div>
                <h3>{e.title}</h3>
                <p>{e.description}</p>
                <div className="experience-people">
                  {people.map((u) => (
                    <button key={u.token} className="person" onClick={() => onToken(u.token)}>
                      <span className="person-name">Continue as {u.name.replace(/\s*\(.*\)$/, '')}</span>
                      <span className="person-meta">{u.operator ? 'All customers' : `${u.tenants.join(', ')} · ${u.roles.join(', ').replace('_', ' ')}`}</span>
                    </button>
                  ))}
                  {users !== null && people.length === 0 && <p className="muted small">No demo identity for this workspace.</p>}
                </div>
              </section>
            );
          })}
        </div>
        {users !== null && users.length === 0 && (
          <p className="login-note">Sign-in is provided by your organization. Demo identities are only available when the server runs with LOMI_DEV_LOGIN=1.</p>
        )}
        <p className="login-note">Integrations and agents do not sign in here: they call the API with their own token — see <a href="/api/docs">API reference</a>.</p>
      </div>
    </div>
  );
};
