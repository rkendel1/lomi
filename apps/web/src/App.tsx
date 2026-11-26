import React, { useCallback, useEffect, useState } from 'react';
import { call, can, experienceOf, getToken, me as fetchMe, setToken, type Me } from './lib/client';
import { Login } from './pages/Login';
import { DocumentsPage } from './pages/DocumentsPage';
import { DocumentDetail } from './pages/DocumentDetail';
import { OperationsPage } from './pages/OperationsPage';
import { StudioPage } from './pages/StudioPage';
import { SubmitPage } from './pages/SubmitPage';
import './docops.css';

type Route =
  | { page: 'documents' }
  | { page: 'document'; id: string }
  | { page: 'operations' }
  | { page: 'studio' }
  | { page: 'submit' };

function parseRoute(hash: string): Route | null {
  const doc = hash.match(/^#\/documents\/([0-9a-f-]{36})/);
  if (doc) return { page: 'document', id: doc[1] };
  if (hash.startsWith('#/documents')) return { page: 'documents' };
  if (hash.startsWith('#/operations')) return { page: 'operations' };
  if (hash.startsWith('#/studio')) return { page: 'studio' };
  if (hash.startsWith('#/submit')) return { page: 'submit' };
  return null;
}

/** `/in/{tenant}` is a customer's intake URL; the same page serves people uploading by hand. */
function tenantFromPath(): string | null {
  return window.location.pathname.match(/^\/in\/([a-z0-9][a-z0-9-]{1,62})\/?$/)?.[1] ?? null;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

interface TenantRef {
  slug: string;
  name: string;
}

/** Lomi Document Operations: operations, review and submission workspaces in one shell. */
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tenants, setTenants] = useState<TenantRef[]>([]);
  const [tenant, setTenant] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signIn = useCallback(async () => {
    try {
      const who = await fetchMe();
      const list = (await call<{ items: TenantRef[] }>('tenants.list')).items;
      setMe(who);
      setTenants(list);
      // Never carry a customer over from a previous identity: pick one this identity can use.
      const fromUrl = tenantFromPath();
      setTenant((current) => {
        const valid = (slug: string | null) => (slug && list.some((t) => t.slug === slug) ? slug : null);
        return valid(fromUrl) ?? valid(current) ?? list[0]?.slug ?? null;
      });
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

  const signOut = () => {
    setToken(null);
    setMe(null);
    setTenant(null);
    setTenants([]);
    // Leave any intake URL or document link behind: the next person starts at their own workspace.
    window.history.replaceState(null, '', '/');
    setRoute(null);
  };

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

  const experience = experienceOf(me, tenant);
  const showOps = me.operator || can(me, tenant, 'operations.read');
  const canReview = experience !== 'submission';
  const canSubmit = can(me, tenant, 'documents.submit');
  // Default landing page per workspace.
  const effective: Route =
    route ?? (tenantFromPath() || experience === 'submission' ? { page: 'submit' } : experience === 'operations' ? { page: 'operations' } : { page: 'documents' });
  const tenantName = tenants.find((t) => t.slug === tenant)?.name ?? tenant;
  const isActive = (...pages: Route['page'][]) => (pages.includes(effective.page) ? 'active' : '');

  return (
    <div className={`shell shell-${experience}`}>
      <header className="shell-header">
        <div className="shell-brand">
          <span className="shell-logo" aria-hidden>◧</span>
          <span>Lomi</span>
          <span className="shell-workspace">
            {experience === 'operations' ? 'Operations' : experience === 'submission' ? 'Submission' : 'Review'}
          </span>
        </div>
        <nav className="shell-nav" aria-label="Main">
          {me.operator && <a href="#/operations" className={isActive('operations')}>Operations</a>}
          {canReview && <a href="#/documents" className={isActive('documents', 'document')}>{me.operator ? 'Documents' : 'Review queue'}</a>}
          {!me.operator && showOps && <a href="#/operations" className={isActive('operations')}>Operations</a>}
          {canSubmit && !me.operator && <a href="#/submit" className={isActive('submit')}>Submit</a>}
          {me.operator && <a href="#/studio" className={isActive('studio')}>Schema Studio</a>}
        </nav>
        <div className="shell-right">
          {tenants.length > 1 ? (
            <label className="shell-tenant">
              <span>Customer</span>
              <select aria-label="Customer" value={tenant ?? ''} onChange={(e) => setTenant(e.target.value)}>
                {tenants.map((t) => (
                  <option key={t.slug} value={t.slug}>{t.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="shell-tenant-name">{tenantName}</span>
          )}
          <span className="shell-user">{me.name.replace(/\s*\(.*\)$/, '')}</span>
          <button className="btn-link" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="shell-main">
        {!tenant ? (
          <div className="empty">You do not have access to any customer yet.</div>
        ) : effective.page === 'document' && canReview ? (
          <DocumentDetail key={`${tenant}:${effective.id}`} tenant={tenant} documentId={effective.id} me={me} />
        ) : effective.page === 'operations' && showOps ? (
          <OperationsPage
            tenant={tenant}
            tenants={tenants}
            me={me}
            onTenantChange={setTenant}
            onTenantsChanged={signIn}
          />
        ) : effective.page === 'studio' && me.operator ? (
          <StudioPage key={tenant} tenant={tenant} />
        ) : effective.page === 'submit' || !canReview ? (
          canSubmit ? <SubmitPage key={tenant} tenant={tenant} tenantName={tenantName ?? tenant} /> : <div className="empty">This identity cannot submit documents.</div>
        ) : (
          <DocumentsPage key={tenant} tenant={tenant} me={me} />
        )}
      </main>
    </div>
  );
}

export default App;
