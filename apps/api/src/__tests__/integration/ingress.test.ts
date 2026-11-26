import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer } from '../../app';
import type { Ctx } from '../../domain/common';
import { createDocOpsRoutes } from '../../http/docops';
import { openApiDocument } from '../../http/openapi';
import { dispatchOutbox } from '../../jobs/dispatcher';
import { createQueue, startWorker, type WorkerHandles } from '../../jobs/queue';
import { seedConfiguration } from '../../seed/seed';
import { INVOICE_V1, invoicePdf } from '../../seed/fixtures';
import { q, setup } from './harness';
import { PATTERN_TEMPLATES } from './harness';

let ctx: Ctx;
let server: Server;
let worker: WorkerHandles;
let base: string;
let queue: ReturnType<typeof createQueue>;
const SUBMITTER = 'dev-lakeside-submitter';
const REVIEWER = 'dev-lakeside-reviewer';

const pdf = (n: number, extra: Partial<typeof INVOICE_V1> = {}) => invoicePdf({ ...INVOICE_V1, number: `INV-2026-${String(n).padStart(4, '0')}`, ...extra });
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function capability(name: string, input: unknown, token = REVIEWER) {
  const res = await fetch(`${base}/api/appport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({ protocol: 'appport/1', type: 'request', requestId: crypto.randomUUID(), capability: { name, version: 1 }, input }),
  });
  return res.json();
}
async function progress(documentId: string) {
  return (await fetch(`${base}/api/documents/${documentId}/progress`, { headers: { ...auth(REVIEWER), 'X-Lomi-Tenant': 'lakeside' } })).json();
}
async function until(documentId: string, status: string, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const p = await progress(documentId);
    if (p.reviewStatus === status) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`still ${p.reviewStatus} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  ctx = await setup();
  ctx.config = { ...ctx.config, redisUrl: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15', queuePrefix: `lomi-ingress-${Date.now()}` };
  await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
  queue = createQueue(ctx);
  // As in the API process: publish committed work immediately.
  ctx.dispatchNow = () => void dispatchOutbox(ctx.db, queue).catch(() => undefined);
  server = createApiServer(createDocOpsRoutes(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The worker's own dispatcher polls only once a minute here, so fast processing can only come from dispatchNow.
  worker = startWorker({ ...ctx, dispatchNow: undefined }, { dispatchMs: 60_000, reconcileMs: 60_000 });
});
afterAll(async () => {
  await worker.stop();
  await queue.close();
  await new Promise((r) => server.close(r));
});

describe('tenant ingress URL', () => {
  it('accepts an electronic submission from a submitter and starts processing immediately', async () => {
    const res = await fetch(`${base}/api/in/lakeside/documents?documentType=invoice&filename=edi.pdf`, {
      method: 'POST', headers: { ...auth(SUBMITTER), 'Content-Type': 'application/pdf' }, body: new Uint8Array(await pdf(1)),
    });
    expect(res.status).toBe(202);
    const sub = await res.json();
    const ms = await until(sub.documentId, 'awaiting_review', 10_000);
    expect(ms).toBeLessThan(10_000); // far below the worker's 60 s dispatcher poll
    expect(await q(ctx, 'SELECT channel FROM submissions WHERE document_id = $1', [sub.documentId])).toEqual([{ channel: 'api' }]);
  });

  it('accepts a single upload and a bulk upload (each file accepted or rejected on its own)', async () => {
    const single = new FormData();
    single.append('documentType', 'invoice');
    single.append('file', new Blob([new Uint8Array(await pdf(2))], { type: 'application/pdf' }), 'one.pdf');
    const one = await fetch(`${base}/api/in/lakeside/documents`, { method: 'POST', headers: auth(SUBMITTER), body: single });
    expect(one.status).toBe(202);
    const oneBody = await one.json();
    expect(oneBody.outcome).toBe('new_document');

    const bulk = new FormData();
    bulk.append('documentType', 'invoice');
    bulk.append('file', new Blob([new Uint8Array(await pdf(3))], { type: 'application/pdf' }), 'a.pdf');
    bulk.append('file', new Blob([new Uint8Array(await pdf(4))], { type: 'application/pdf' }), 'b.pdf');
    bulk.append('file', new Blob(['not a pdf'], { type: 'text/plain' }), 'notes.txt');
    const many = await fetch(`${base}/api/in/lakeside/documents`, { method: 'POST', headers: auth(SUBMITTER), body: bulk });
    expect(many.status).toBe(202);
    const batch = await many.json();
    expect(batch).toMatchObject({ accepted: 2, rejected: 1 });
    expect(batch.results.find((r: any) => r.filename === 'notes.txt')).toMatchObject({ ok: false, error: expect.stringMatching(/not a PDF/) });
    const rows = await q(ctx, `SELECT channel, batch_id FROM submissions WHERE batch_id = $1`, [batch.batchId]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.channel === 'bulk')).toBe(true);
    expect(await q(ctx, 'SELECT channel FROM submissions WHERE document_id = $1', [oneBody.documentId])).toEqual([{ channel: 'upload' }]);
    for (const r of batch.results.filter((x: any) => x.ok)) await until(r.documentId, 'awaiting_review', 15_000);
  });

  it('accepts a JSON batch', async () => {
    const documents = [5, 6].map(async (n) => ({ filename: `j${n}.pdf`, contentBase64: Buffer.from(await pdf(n)).toString('base64') }));
    const res = await fetch(`${base}/api/in/lakeside/documents`, {
      method: 'POST', headers: { ...auth(SUBMITTER), 'Content-Type': 'application/json' }, body: JSON.stringify({ documentType: 'invoice', documents: await Promise.all(documents) }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: 2, rejected: 0 });
  });

  it("keeps each tenant's URL to its own members, and submitters cannot review", async () => {
    const other = await fetch(`${base}/api/in/summit/documents?documentType=invoice`, {
      method: 'POST', headers: { ...auth(SUBMITTER), 'Content-Type': 'application/pdf' }, body: new Uint8Array(await pdf(7)),
    });
    expect(other.status).toBe(404);
    const anonymous = await fetch(`${base}/api/in/lakeside/documents?documentType=invoice`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(await pdf(8)) });
    expect(anonymous.status).toBe(401);
    const [value] = await q(ctx, `SELECT id FROM extracted_values LIMIT 1`);
    expect(await capability('values.review', { tenant: 'lakeside', valueId: value.id, action: 'approve' }, SUBMITTER)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('review flow', () => {
  it('approves all verified values but leaves flagged ones, then moves to the next document', async () => {
    // Totals that do not add up: subtotal, tax and total fail the cross-field check.
    const res = await fetch(`${base}/api/in/lakeside/documents?documentType=invoice&filename=bad.pdf`, {
      method: 'POST', headers: { ...auth(SUBMITTER), 'Content-Type': 'application/pdf' }, body: new Uint8Array(await pdf(9, { total: '$9,999.00' })),
    });
    const { documentId } = await res.json();
    await until(documentId, 'awaiting_review', 10_000);

    const approved = await capability('values.verified.approve', { tenant: 'lakeside', documentId });
    expect(approved).toMatchObject({ ok: true, output: { approved: 6, progress: { pending: 3 } } });
    const doc = await capability('documents.get', { tenant: 'lakeside', documentId });
    expect(doc.output.values.filter((v: any) => v.state === 'pending').map((v: any) => v.semanticKey).sort()).toEqual(['invoice.subtotal', 'invoice.tax', 'invoice.total']);
    const decisions = await q(ctx, `SELECT count(*)::int AS n FROM review_decisions rd JOIN extracted_values ev ON ev.id = rd.value_id
      JOIN document_versions dv ON dv.id = ev.document_version_id WHERE dv.document_id = $1 AND rd.action = 'approve' AND rd.actor_kind = 'user'`, [documentId]);
    expect(decisions).toEqual([{ n: 6 }]);

    const next = await capability('documents.next', { tenant: 'lakeside', after: documentId });
    expect(next.ok).toBe(true);
    expect(next.output.documentId).not.toBe(documentId);
    expect(next.output.documentId).toBeTruthy();
    const oldest = await q(ctx, `SELECT d.id FROM documents d JOIN document_versions dv ON dv.id = d.current_version_id
      WHERE dv.processing_status = 'processed' AND d.id <> $1 AND EXISTS (SELECT 1 FROM extracted_values ev WHERE ev.document_version_id = dv.id AND ev.review_state = 'pending')
      ORDER BY dv.processed_at LIMIT 1`, [documentId]);
    expect(next.output.documentId).toBe(oldest[0].id);
  });
});

describe('OpenAPI document', () => {
  it('describes routes that exist, with resolvable references', async () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/"\$ref":"#\/components\/(schemas|parameters)\/([A-Za-z]+)"/g)) {
      expect((doc.components as any)[m[1]][m[2]], `${m[1]}/${m[2]}`).toBeDefined();
    }
    const served = await (await fetch(`${base}/api/openapi.json`)).json();
    expect(served.paths).toEqual(JSON.parse(JSON.stringify(doc.paths)));
    // Every documented operation is routed: a request never hits the generic 404 for unknown routes.
    const id = '00000000-0000-0000-0000-000000000000';
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        const url = path.replace('{tenant}', 'lakeside').replace('{id}', id);
        const res = await fetch(`${base}${url}`, { method: method.toUpperCase(), headers: { ...auth(REVIEWER), 'X-Lomi-Tenant': 'lakeside', 'Content-Type': 'application/json' }, body: method === 'get' ? undefined : '{}' });
        const body = await res.text();
        expect(body === '{"error":"Not found"}' && res.status === 404, `${method.toUpperCase()} ${path} is not routed`).toBe(false);
      }
    }
  });
});
