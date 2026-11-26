import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AppPortApplication } from '@appport/core';
import { createRequest } from '@appport/protocol';
import type { AuthenticatedIdentity } from '../capabilities/auth';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `Request body exceeds ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const STATUS: Record<string, number> = {
  INVALID_INPUT: 400, INVALID_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PAYLOAD_TOO_LARGE: 413,
};

/**
 * Invoke a capability on behalf of an authenticated caller. REST endpoints are
 * adapters over this: the same validation, authorization and handler run for
 * REST, AppPort HTTP and MCP callers.
 */
export async function invoke<T = any>(app: AppPortApplication, identity: AuthenticatedIdentity | null, name: string, input: unknown, idempotencyKey?: string): Promise<T> {
  const response = await app.handleRequest(
    createRequest({ requestId: randomUUID(), capability: { name, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    identity ? { session: identity.session, principal: identity.principal, transport: 'rest' } : { transport: 'rest' }
  );
  if (response.ok) return response.output as T;
  throw new HttpError(STATUS[response.error.code] ?? 500, response.error.message, { error: response.error });
}

/** Tenant for a REST call: explicit header/query, else the caller's only membership. */
export function tenantFor(req: IncomingMessage, url: URL, identity: AuthenticatedIdentity | null): string {
  const explicit = (req.headers['x-lomi-tenant'] as string | undefined) ?? url.searchParams.get('tenant') ?? undefined;
  if (explicit) return explicit;
  if (identity && identity.memberships.length === 1) return identity.memberships[0].slug;
  throw new HttpError(400, 'Specify the tenant with the X-Lomi-Tenant header or ?tenant=');
}

/** Bridge a Node request to a fetch-style handler (used for the MCP adapter). */
export async function toFetchRequest(req: IncomingMessage, body: Buffer | undefined): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body: body && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(body) : undefined,
  });
}

export async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
