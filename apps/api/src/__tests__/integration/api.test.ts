import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer } from '../../app';
import type { Ctx } from '../../domain/common';
import { createDocOpsRoutes } from '../../http/docops';
import { seedConfiguration } from '../../seed/seed';
import { INVOICE_V1, invoicePdf } from '../../seed/fixtures';
import { drain, q, setup } from './harness';
import { PATTERN_TEMPLATES } from './harness';

let ctx: Ctx;
let server: Server;
let base: string;

const TOKENS = { operator: 'dev-operator', admin: 'dev-lakeside-admin', reviewer: 'dev-lakeside-reviewer', summit: 'dev-summit-reviewer', agent: 'dev-lakeside-agent' };

function api(path: string, init: RequestInit & { token?: string; tenant?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.tenant) headers.set('X-Lomi-Tenant', init.tenant);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function capability(token: string, name: string, input: unknown) {
  const res = await api('/api/appport', {
    method: 'POST', token, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'appport/1', type: 'request', requestId: crypto.randomUUID(), capability: { name, version: 1 }, input }),
  });
  return res.json();
}

async function upload(token: string, tenant = 'lakeside', bytes?: Uint8Array) {
  return api('/api/documents?documentType=invoice&filename=inv.pdf', {
    method: 'POST', token, tenant, headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes ?? (await invoicePdf(INVOICE_V1))),
  });
}

beforeAll(async () => {
  ctx = await setup();
  await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
  server = createApiServer(createDocOpsRoutes(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('REST API', () => {
  it('accepts an upload with 202 after durable acceptance, then serves document, progress and review', async () => {
    const started = Date.now();
    const res = await upload(TOKENS.reviewer);
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    const sub = await res.json();
    expect(res.headers.get('location')).toBe(`/api/documents/${sub.documentId}`);
    expect(sub).toMatchObject({ outcome: 'new_document', status: 'queued' });

    const queued = await (await api(`/api/documents/${sub.documentId}/progress`, { token: TOKENS.reviewer })).json();
    expect(queued).toMatchObject({ status: 'queued', statusLabel: 'Received — waiting to be read' });

    await drain(ctx);
    const doc = await (await api(`/documents/${sub.documentId}`, { token: TOKENS.reviewer })).json(); // un-prefixed path also served
    expect(doc.values).toHaveLength(9);
    const total = doc.values.find((v: any) => v.semanticKey === 'invoice.total');
    const review = await api(`/api/values/${total.id}/review`, {
      method: 'POST', token: TOKENS.reviewer, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'correct', value: '$4,600.00', note: 'Late fee added by phone' }),
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ state: 'corrected', oldValue: '4590.00', newValue: '4600.00' });
    const progress = await (await api(`/api/documents/${sub.documentId}/progress`, { token: TOKENS.reviewer })).json();
    expect(progress).toMatchObject({ status: 'extracted', reviewStatus: 'partially_reviewed', progress: { corrected: 1, pending: 8 }, counts: { corrected: 1, pending: 8 } });

    // Re-uploading identical bytes is recognised as a duplicate, not a new document.
    const dup = await upload(TOKENS.reviewer);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ outcome: 'duplicate_exact', documentId: sub.documentId });

    const file = await api(`/api/documents/${sub.documentId}/file`, { token: TOKENS.reviewer });
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects non-PDF uploads and unauthenticated calls', async () => {
    const bad = await upload(TOKENS.reviewer, 'lakeside', new TextEncoder().encode('hello'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/not a PDF/);
    expect((await api('/api/documents', { tenant: 'lakeside' })).status).toBe(401);
    expect((await api('/api/documents', { token: 'not-a-real-token', tenant: 'lakeside' })).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it("never shows one tenant's documents to another tenant's user", async () => {
    const sub = await (await upload(TOKENS.reviewer, 'lakeside', await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0500' }))).json();
    // Summit's reviewer naming Lakeside: indistinguishable from a tenant that does not exist.
    const named = await api(`/api/documents/${sub.documentId}`, { token: TOKENS.summit, tenant: 'lakeside' });
    expect(named.status).toBe(404);
    // Summit's reviewer using their own tenant with Lakeside's document id: not found (RLS).
    const ownTenant = await api(`/api/documents/${sub.documentId}`, { token: TOKENS.summit, tenant: 'summit' });
    expect(ownTenant.status).toBe(404);
    const list = await (await api('/api/documents', { token: TOKENS.summit })).json();
    expect(list.items).toEqual([]);
    // Uploading into another tenant is refused the same way.
    expect((await upload(TOKENS.summit, 'lakeside')).status).toBe(404);
  });

  it('keeps Lomi-internal operations away from customers', async () => {
    const asCustomer = await capability(TOKENS.admin, 'tenants.create', { slug: 'sneaky', name: 'Sneaky' });
    expect(asCustomer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const asOperator = await capability(TOKENS.operator, 'tenants.create', { slug: 'newco', name: 'NewCo' });
    expect(asOperator).toMatchObject({ ok: true, output: { slug: 'newco' } });
    const crossTenantStats = await capability(TOKENS.admin, 'operations.stats', {});
    expect(crossTenantStats).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const ownStats = await capability(TOKENS.admin, 'operations.stats', { tenant: 'lakeside' });
    expect(ownStats.ok).toBe(true);
    expect(ownStats.output.byTenant).toEqual([]);
  });
});

describe('agents through AppPort and MCP', () => {
  it('lets a delegated agent read and propose, but not decide, and audits every call', async () => {
    const sub = await (await upload(TOKENS.reviewer, 'lakeside', await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0600' }))).json();
    await drain(ctx);
    const doc = await capability(TOKENS.agent, 'documents.get', { tenant: 'lakeside', documentId: sub.documentId });
    expect(doc.ok).toBe(true);
    const value = doc.output.values[0];

    // Delegated reviews.decide, but agents can never hold it.
    const decide = await capability(TOKENS.agent, 'values.review', { tenant: 'lakeside', valueId: value.id, action: 'approve' });
    expect(decide).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });

    const propose = await capability(TOKENS.agent, 'values.propose', { tenant: 'lakeside', valueId: value.id, value: 'Northwind Office Supply Company', rationale: 'Legal name on W-9' });
    expect(propose).toMatchObject({ ok: true, output: { status: 'open', requiresHumanApproval: true } });
    const [proposal] = await q(ctx, `SELECT rp.status, p.email AS on_behalf_of FROM review_proposals rp JOIN principals p ON p.id = rp.on_behalf_of`);
    expect(proposal).toEqual({ status: 'open', on_behalf_of: 'riley@lakeside.example' });
    const after = await capability(TOKENS.reviewer, 'documents.get', { tenant: 'lakeside', documentId: sub.documentId });
    expect(after.output.values[0]).toMatchObject({ state: 'pending', proposals: [{ proposedValue: 'Northwind Office Supply Company' }] });

    const audited = await q(ctx, `SELECT detail->>'capability' AS capability, detail->>'outcome' AS outcome FROM audit_events WHERE action = 'agent.capability_invoked' ORDER BY id`);
    expect(audited).toEqual([
      { capability: 'documents.get', outcome: 'succeeded' },
      { capability: 'values.propose', outcome: 'succeeded' },
    ]);
    // Raw model prompts/responses are Lomi-operator only.
    expect(await capability(TOKENS.admin, 'documents.provenance', { tenant: 'lakeside', documentId: sub.documentId, includeRawModelIo: true })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('publishes a manifest and exposes the same capabilities as MCP tools', async () => {
    const manifest = await (await api('/api/appport/manifest')).json();
    const names = JSON.stringify(manifest);
    for (const n of ['documents.submit', 'documents.get', 'values.review', 'values.propose', 'documents.generate', 'operations.retry']) expect(names).toContain(n);

    const mcp = (body: unknown, token?: string) =>
      api('/api/mcp', { method: 'POST', token, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }).then((r) => r.json());
    await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, TOKENS.agent);
    const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, TOKENS.agent);
    const toolNames = tools.result.tools.map((t: any) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['documents_list', 'values_propose', 'values_review']));

    const listed = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'documents_list', arguments: { tenant: 'lakeside' } } }, TOKENS.agent);
    expect(listed.result.isError).toBeFalsy();
    const anonymous = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'documents_list', arguments: { tenant: 'lakeside' } } });
    expect(anonymous.result.isError).toBe(true);
  });
});
