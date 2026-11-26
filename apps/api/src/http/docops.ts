import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHttpBinding, createServer as createAppPortServer } from '@appport/server';
import { handleNodeRequest } from '@appport/server/node';
import { createMcpHandler } from '@appport/mcp';
import { errors } from '@appport/protocol';
import { APPLICATION_ID, buildApplication } from '../capabilities/app';
import { authenticateToken, type AuthenticatedIdentity } from '../capabilities/auth';
import type { Ctx } from '../domain/common';
import { MAX_UPLOAD_BYTES } from '../domain/documents';
import { DEV_IDENTITIES } from '../seed/identities';
import { parseMultipart } from './multipart';
import { API_DOCS_HTML, openApiDocument } from './openapi';
import { HttpError, invoke, readBody, sendJson, tenantFor, toFetchRequest, writeFetchResponse } from './rest';

/**
 * REST speaks the brief's status vocabulary: `status` is the extraction status
 * (queued | extracting | extracted | failed); the review state is `reviewStatus`.
 */
function restStatus<T extends { status: string; extractionStatus: string }>(doc: T) {
  return { ...doc, status: doc.extractionStatus, reviewStatus: doc.status };
}

function bearer(headers: Readonly<Record<string, string | string[] | undefined>>): string | undefined {
  const value = headers['authorization'];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
}

/**
 * Lomi's HTTP surface on the existing node:http server:
 * - `/api/appport`, `/api/appport/manifest`, `/.well-known/appport`: AppPort's own HTTP binding
 * - `/api/mcp`: the AppPort MCP adapter (tools are projected from the same capabilities)
 * - `/api/documents…`, `/api/values/:id/review`: REST adapters over the same capabilities
 * The `/api` prefix is optional on REST routes (`POST /documents` also works).
 */
export function createDocOpsRoutes(ctx: Ctx) {
  const application = buildApplication(ctx);
  // Development only (LOMI_DEV_DEFAULT_TOKEN): calls without a token act as that identity, so the
  // brief's plain `curl` examples work against the demo stack. Never set it in production.
  const authenticate = async (headers: Readonly<Record<string, string | string[] | undefined>>): Promise<AuthenticatedIdentity | null> =>
    authenticateToken(ctx.db, bearer(headers) ?? ctx.config.devDefaultToken, APPLICATION_ID);

  const appport = createAppPortServer({
    application,
    authenticate: async ({ headers }) => {
      const identity = await authenticate(headers ?? {});
      return identity ? { session: identity.session, principal: identity.principal } : {};
    },
    endpoints: { request: '/api/appport', manifest: '/api/appport/manifest' },
  });
  const binding = createHttpBinding({ server: appport, maxBodyBytes: Math.ceil(MAX_UPLOAD_BYTES * 1.4) });
  const mcp = createMcpHandler(application, {
    async context({ headers }) {
      const identity = await authenticate(headers as Record<string, string>);
      if (!bearer(headers as Record<string, string>)) return undefined;
      if (!identity) throw errors.unauthorized('Invalid credentials');
      return { session: identity.session, principal: identity.principal };
    },
  });

  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path === '/api/appport' || path.startsWith('/api/appport/') || path === '/.well-known/appport') {
      await handleNodeRequest(binding, req, res);
      return true;
    }
    if (path === '/api/mcp') {
      const body = req.method === 'POST' ? await readBody(req, 30 * 1024 * 1024) : undefined;
      await writeFetchResponse(res, await mcp(await toFetchRequest(req, body)));
      return true;
    }
    if (path === '/api/auth/dev-users' && req.method === 'GET') {
      if (!ctx.config.devLogin) return false;
      // Development only (LOMI_DEV_LOGIN=1): lists the seeded demo identities so the UI can sign in.
      sendJson(res, 200, {
        users: DEV_IDENTITIES.filter((u) => u.kind === 'user').map((u) => ({ name: u.name, email: u.email, operator: u.operator, experience: u.experience, token: u.token, tenants: u.memberships.map((m) => m.tenant), roles: u.memberships.map((m) => m.role) })),
      });
      return true;
    }
    if (path === '/api/me' && req.method === 'GET') {
      const identity = await authenticate(req.headers);
      if (!identity) throw new HttpError(401, 'Authentication is required');
      sendJson(res, 200, {
        id: identity.principal.id, name: identity.principal.displayName, kind: identity.kind, operator: identity.operator,
        memberships: identity.memberships.map((m) => ({ tenantId: m.tenantId, slug: m.slug, role: m.role, permissions: m.permissions })),
      });
      return true;
    }

    // ── Tenant ingress URL: one endpoint per customer for API, single and bulk submissions ──
    const ingressMatch = path.match(/^\/api\/in\/([a-z0-9][a-z0-9-]{1,62})\/documents$/);
    if (ingressMatch && req.method === 'POST') {
      const identity = await authenticate(req.headers);
      const tenant = ingressMatch[1];
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
      const documentType = url.searchParams.get('documentType') ?? undefined;
      let documents: Array<{ filename: string; contentBase64: string; documentType?: string; title?: string }>;
      let channel: 'api' | 'upload' | 'bulk';
      let formType: string | undefined;
      if (type === 'multipart/form-data') {
        const { files, fields } = await parseMultipart(req, { fileBytes: MAX_UPLOAD_BYTES, files: 100 });
        if (!files.length) throw new HttpError(400, 'No files in the upload (use form field "file").');
        documents = files.map((f) => ({ filename: f.filename, contentBase64: f.bytes.toString('base64') }));
        channel = files.length > 1 ? 'bulk' : 'upload';
        formType = fields.documentType || undefined;
      } else if (type === 'application/pdf') {
        documents = [{ filename: url.searchParams.get('filename') ?? 'submission.pdf', contentBase64: (await readBody(req, MAX_UPLOAD_BYTES + 1024)).toString('base64') }];
        channel = 'api';
      } else if (type === 'application/json') {
        const json = JSON.parse((await readBody(req, 140 * 1024 * 1024)).toString('utf8'));
        documents = Array.isArray(json.documents) ? json.documents : [json];
        channel = Array.isArray(json.documents) ? 'bulk' : 'api';
        formType = json.documentType;
      } else {
        throw new HttpError(415, 'Send application/pdf, multipart/form-data (field "file", repeatable) or application/json.');
      }
      const chosenType = documentType ?? formType;
      if (documents.length === 1 && channel !== 'bulk') {
        const d = documents[0];
        const result = await invoke(application, identity, 'documents.submit', {
          tenant, filename: d.filename, contentBase64: d.contentBase64, channel,
          ...(d.documentType ?? chosenType ? { documentType: d.documentType ?? chosenType } : {}),
          ...(d.title ? { title: d.title } : {}),
        }, req.headers['idempotency-key'] as string | undefined);
        sendJson(res, result.outcome === 'duplicate_exact' ? 200 : 202, result, { Location: `/api/documents/${result.documentId}` });
      } else {
        const result = await invoke(application, identity, 'documents.batch.submit', { tenant, ...(chosenType ? { documentType: chosenType } : {}), documents });
        sendJson(res, 202, result);
      }
      return true;
    }
    if (path === '/api/openapi.json' && req.method === 'GET') {
      sendJson(res, 200, openApiDocument());
      return true;
    }
    if (path === '/api/docs' && req.method === 'GET') {
      const html = Buffer.from(API_DOCS_HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      res.end(html);
      return true;
    }

    const rest = path.startsWith('/api/') ? path.slice(4) : path;
    const m = (re: RegExp) => rest.match(re);
    let match: RegExpMatchArray | null;

    if (req.method === 'POST' && rest === '/documents') {
      const identity = await authenticate(req.headers);
      const tenant = tenantFor(req, url, identity);
      const input = await uploadInput(req, url);
      const result = await invoke(application, identity, 'documents.submit', { tenant, ...input }, req.headers['idempotency-key'] as string | undefined);
      sendJson(res, result.outcome === 'duplicate_exact' ? 200 : 202, result, { Location: `/api/documents/${result.documentId}` });
      return true;
    }
    if (req.method === 'GET' && rest === '/documents') {
      const identity = await authenticate(req.headers);
      const q = Object.fromEntries(url.searchParams);
      const result = await invoke(application, identity, 'documents.list', {
        tenant: tenantFor(req, url, identity),
        ...(q.search ? { search: q.search } : {}), ...(q.status ? { status: q.status } : {}), ...(q.documentType ? { documentType: q.documentType } : {}),
      });
      sendJson(res, 200, { items: result.items.map(restStatus) });
      return true;
    }
    if (req.method === 'POST' && (match = m(/^\/documents\/([0-9a-f-]{36})\/versions$/))) {
      const identity = await authenticate(req.headers);
      const input = await uploadInput(req, url);
      const result = await invoke(application, identity, 'documents.versions.add', { tenant: tenantFor(req, url, identity), documentId: match[1], filename: input.filename, contentBase64: input.contentBase64 });
      sendJson(res, result.outcome === 'duplicate_exact' ? 200 : 202, result);
      return true;
    }
    if (req.method === 'GET' && (match = m(/^\/documents\/([0-9a-f-]{36})$/))) {
      const identity = await authenticate(req.headers);
      const versionId = url.searchParams.get('versionId');
      const doc = await invoke(application, identity, 'documents.get', { tenant: tenantFor(req, url, identity), documentId: match[1], ...(versionId ? { versionId } : {}) });
      sendJson(res, 200, restStatus(doc));
      return true;
    }
    if (req.method === 'GET' && (match = m(/^\/documents\/([0-9a-f-]{36})\/progress$/))) {
      const identity = await authenticate(req.headers);
      const p = await invoke(application, identity, 'documents.progress', { tenant: tenantFor(req, url, identity), documentId: match[1] });
      sendJson(res, 200, {
        ...restStatus(p),
        counts: { pending: p.progress.pending, approved: p.progress.approved + p.progress.autoApproved, corrected: p.progress.corrected, carriedOver: p.progress.carriedOver, gaps: p.progress.gaps },
      });
      return true;
    }
    if (req.method === 'POST' && (match = m(/^\/documents\/([0-9a-f-]{36})\/retry$/))) {
      const identity = await authenticate(req.headers);
      sendJson(res, 202, await invoke(application, identity, 'documents.retry', { tenant: tenantFor(req, url, identity), documentId: match[1] }));
      return true;
    }
    if (req.method === 'POST' && (match = m(/^\/values\/([0-9a-f-]{36})\/review$/))) {
      const identity = await authenticate(req.headers);
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
      sendJson(res, 200, await invoke(application, identity, 'values.review', { tenant: tenantFor(req, url, identity), valueId: match[1], ...body }));
      return true;
    }
    if (req.method === 'POST' && (match = m(/^\/documents\/([0-9a-f-]{36})\/generate$/))) {
      const identity = await authenticate(req.headers);
      sendJson(res, 202, await invoke(application, identity, 'documents.generate', { tenant: tenantFor(req, url, identity), documentId: match[1] }));
      return true;
    }
    if (req.method === 'GET' && (match = m(/^\/documents\/([0-9a-f-]{36})\/file$/))) {
      const identity = await authenticate(req.headers);
      const versionId = url.searchParams.get('versionId');
      const outputId = url.searchParams.get('output');
      const file = await invoke(application, identity, 'documents.download', {
        tenant: tenantFor(req, url, identity), documentId: match[1], ...(versionId ? { versionId } : {}), ...(outputId ? { generatedDocumentId: outputId } : {}),
      });
      const bytes = Buffer.from(file.contentBase64, 'base64');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Content-Disposition': `inline; filename="${file.filename.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' });
      res.end(bytes);
      return true;
    }
    if (req.method === 'GET' && (match = m(/^\/templates\/basepdfs\/([0-9a-f-]{36})\/file$/))) {
      const identity = await authenticate(req.headers);
      const file = await invoke(application, identity, 'templates.basepdfs.download', { tenant: tenantFor(req, url, identity), basePdfId: match[1] });
      const bytes = Buffer.from(file.contentBase64, 'base64');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store' });
      res.end(bytes);
      return true;
    }
    return false;
  };

  async function uploadInput(req: IncomingMessage, url: URL) {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
    if (type === 'multipart/form-data') {
      // The brief's form: `type` (document type) + `file` (the PDF).
      const { files, fields } = await parseMultipart(req, { fileBytes: MAX_UPLOAD_BYTES, files: 1 });
      if (!files.length) throw new HttpError(400, 'Missing form field "file" (the PDF).');
      const documentType = fields.type || fields.documentType || url.searchParams.get('documentType') || url.searchParams.get('type') || undefined;
      return {
        filename: files[0].filename,
        contentBase64: files[0].bytes.toString('base64'),
        ...(documentType ? { documentType } : {}),
        ...(fields.title ? { title: fields.title } : {}),
      };
    }
    const body = await readBody(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 4096);
    if (type === 'application/pdf') {
      const p = url.searchParams;
      return {
        filename: p.get('filename') ?? 'upload.pdf',
        contentBase64: body.toString('base64'),
        ...((p.get('documentType') ?? p.get('type')) ? { documentType: (p.get('documentType') ?? p.get('type'))! } : {}),
        ...(p.get('title') ? { title: p.get('title')! } : {}),
      };
    }
    if (type === 'application/json') {
      const json = JSON.parse(body.toString('utf8'));
      if (typeof json.contentBase64 !== 'string' || typeof json.filename !== 'string') throw new HttpError(400, 'JSON uploads need filename and contentBase64');
      if (json.type && !json.documentType) json.documentType = json.type;
      delete json.type;
      return json as { filename: string; contentBase64: string; documentType?: string; title?: string };
    }
    throw new HttpError(415, 'Upload multipart/form-data with fields type and file, application/pdf (with ?type=&filename=), or JSON with contentBase64');
  }
}
