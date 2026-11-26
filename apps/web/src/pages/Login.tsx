import React, { useEffect, useState } from 'react';
import { devUsers } from '../lib/client';

/** Sign in with an API token. In development, seeded demo identities are offered as one-click sign-ins. */
export const Login: React.FC<{ onToken: (token: string) => void }> = ({ onToken }) => {
  const [users, setUsers] = useState<Awaited<ReturnType<typeof devUsers>>>([]);
  const [token, setTokenValue] = useState('');

  useEffect(() => {
    void devUsers().then(setUsers);
  }, []);

  return (
    <div className="login">
      <div className="login-card">
        <h1>Lomi Document Operations</h1>
        <p className="muted">Documents in, reviewed business data out — with the evidence for every value.</p>
        {users.length > 0 && (
          <>
            <h2>Demo identities</h2>
            <p className="muted small">Development mode only. Each identity sees what its role allows.</p>
            <ul className="login-users">
              {users.map((u) => (
                <li key={u.token}>
                  <button onClick={() => onToken(u.token)}>
                    <strong>{u.name}</strong>
                    <span className="muted small">{u.operator ? 'All customers · Lomi operator' : u.tenants.join(', ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <form
          className="login-token"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) onToken(token.trim());
          }}
        >
          <label htmlFor="token">API token</label>
          <input id="token" type="password" value={token} onChange={(e) => setTokenValue(e.target.value)} autoComplete="off" />
          <button type="submit" className="btn-primary">Sign in</button>
        </form>
      </div>
    </div>
  );
};
