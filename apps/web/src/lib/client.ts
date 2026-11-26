/**
 * Browser client for Lomi. The UI calls the same AppPort capabilities as
 * integrations and agents (standard request envelopes to /api/appport), so it
 * gets no special authority of its own.
 */
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const TOKEN_KEY = 'lomi.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function call<T = any>(capability: string, input: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/appport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ protocol: 'appport/1', type: 'request', requestId: crypto.randomUUID(), capability: { name: capability, version: 1 }, input }),
  });
  const body = await res.json().catch(() => null);
  if (!body) throw new ApiError('NETWORK', `The server returned ${res.status}`);
  if (!body.ok) throw new ApiError(body.error?.code ?? 'ERROR', body.error?.message ?? 'Request failed', body.error?.details);
  return body.output as T;
}

export interface Me {
  id: string;
  name: string;
  kind: string;
  operator: boolean;
  memberships: Array<{ tenantId: string; slug: string; role: string; permissions: string[] }>;
}

export async function me(): Promise<Me> {
  const res = await fetch(`${API_BASE}/api/me`, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status === 401 ? 'UNAUTHORIZED' : 'ERROR', 'Not signed in');
  return res.json();
}

export async function devUsers(): Promise<Array<{ name: string; email: string; operator: boolean; token: string; tenants: string[] }>> {
  const res = await fetch(`${API_BASE}/api/auth/dev-users`);
  if (!res.ok) return [];
  return (await res.json()).users;
}

/** Fetch an authorized PDF as a File (for the PDF.js viewer or download). */
export async function fetchPdf(path: string, tenant: string, filename = 'document.pdf'): Promise<File> {
  const res = await fetch(`${API_BASE}${path}${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(tenant)}`, { headers: authHeaders() });
  if (!res.ok) throw new ApiError('ERROR', `Could not load the file (${res.status})`);
  return new File([await res.blob()], filename, { type: 'application/pdf' });
}

export function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
}

export function can(me: Me | null, tenant: string | null, permission: string): boolean {
  if (!me) return false;
  if (me.operator) return true;
  const m = me.memberships.find((x) => x.slug === tenant);
  return Boolean(m?.permissions.includes(permission));
}
