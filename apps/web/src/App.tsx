import React, { useCallback, useEffect, useState } from 'react';
import { call, can, getToken, me as fetchMe, setToken, type Me } from './lib/client';
import { Login } from './pages/Login';
import { DocumentsPage } from './pages/DocumentsPage';
import { DocumentDetail } from './pages/DocumentDetail';
import { OperationsPage } from './pages/OperationsPage';
import { StudioPage } from './pages/StudioPage';
import './docops.css';

type Route = { page: 'documents' } | { page: 'document'; id: string } | { page: 'operations' } | { page: 'studio' };

function parseRoute(hash: string): Route {
  const doc = hash.match(/^#\/documents\/([0-9a-f-]{36})/);
  if (doc) return { page: 'document', id: doc[1] };
  if (hash.startsWith('#/operations')) return { page: 'operations' };
  if (hash.startsWith('#/studio')) return { page: 'studio' };
  return { page: 'documents' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

/** Lomi Document Operations: customer portal, operator console and Schema Studio in one shell. */
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tenants, setTenants] = useState<Array<{ slug: string; name: string }>>([]);
  const [tenant, setTenant] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signIn = useCallback(async () => {
    try {
      const who = await fetchMe();
      setMe(who);
      const list = (await call<{ items: Array<{ slug: string; name: string }> }>('tenants.list')).items;
      setTenants(list);
      setTenant((current) => current ?? list[0]?.slug ?? null);
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (getToken()) void signIn();
  }, [signIn]);

  if (checking) return <div className="shell-loading">Loading…</div>;
  if (!me) {
    return (
      <Login
        onToken={(token) => {
          setToken(token);
          setChecking(true);
          void signIn();
        }}
      />
    );
  }

  const showOps = me.operator || can(me, tenant, 'operations.read');
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-brand">
          <span className="shell-logo" aria-hidden>◧</span>
          <span>Lomi Document Operations</span>
        </div>
        <nav className="shell-nav" aria-label="Main">
          <a href="#/documents" className={route.page === 'documents' || route.page === 'document' ? 'active' : ''}>Documents</a>
          {showOps && <a href="#/operations" className={route.page === 'operations' ? 'active' : ''}>Operations</a>}
          {me.operator && <a href="#/studio" className={route.page === 'studio' ? 'active' : ''}>Schema Studio</a>}
        </nav>
        <div className="shell-right">
          <label className="shell-tenant">
            <span>Customer</span>
            <select aria-label="Customer" value={tenant ?? ''} onChange={(e) => { setTenant(e.target.value); navigate('/documents'); }}>
              {tenants.map((t) => (
                <option key={t.slug} value={t.slug}>{t.name}</option>
              ))}
            </select>
          </label>
          <span className="shell-user" title={me.operator ? 'Lomi operator' : me.memberships.find((m) => m.slug === tenant)?.role}>
            {me.name}
          </span>
          <button className="btn-link" onClick={() => { setToken(null); setMe(null); }}>Sign out</button>
        </div>
      </header>
      <main className="shell-main">
        {!tenant ? (
          <div className="empty">You do not have access to any customer yet.</div>
        ) : route.page === 'document' ? (
          <DocumentDetail key={route.id} tenant={tenant} documentId={route.id} me={me} />
        ) : route.page === 'operations' && showOps ? (
          <OperationsPage tenant={tenant} me={me} onTenantsChanged={signIn} />
        ) : route.page === 'studio' && me.operator ? (
          <StudioPage tenant={tenant} />
        ) : (
          <DocumentsPage tenant={tenant} me={me} />
        )}
      </main>
    </div>
  );
}

export default App;
