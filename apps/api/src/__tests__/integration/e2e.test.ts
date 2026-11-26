import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer } from '../../app';
import type { Ctx } from '../../domain/common';
import { createDocOpsRoutes } from '../../http/docops';
import { startWorker, type WorkerHandles } from '../../jobs/queue';
import { seedConfiguration } from '../../seed/seed';
import { INVOICE_TEMPLATE, INVOICE_V1, INVOICE_V2, invoicePdf } from '../../seed/fixtures';
import { q, setup } from './harness';

let ctx: Ctx;
let server: Server;
let worker: WorkerHandles;
let base: string;
const REVIEWER = 'dev-lakeside-reviewer';
const OPERATOR = 'dev-operator';

async function rest(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${init.token ?? REVIEWER}`);
  headers.set('X-Lomi-Tenant', 'lakeside');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : null };
}
async function capability(name: string, input: unknown, token = REVIEWER) {
  const res = await fetch(`${base}/api/appport`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ protocol: 'appport/1', type: 'request', requestId: crypto.randomUUID(), capability: { name, version: 1 }, input }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${name}: ${body.error.code} ${body.error.message}`);
  return body.output;
}
async function uploadPdf(path: string, bytes: Uint8Array) {
  return rest(path, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(bytes) });
}
async function waitFor(documentId: string, predicate: (p: any) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = (await rest(`/api/documents/${documentId}/progress`)).body;
    if (predicate(p)) return p;
    if (Date.now() > deadline) throw new Error(`timed out; last status ${p.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  ctx = await setup();
  ctx.config = { ...ctx.config, redisUrl: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15', queuePrefix: `lomi-e2e-${Date.now()}` };
  await seedConfiguration(ctx);
  server = createApiServer(createDocOpsRoutes(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000 });
});
afterAll(async () => {
  await worker.stop();
  await new Promise((r) => server.close(r));
});

describe('end-to-end customer workflow (HTTP API + Redis worker + PostgreSQL)', () => {
  it('upload → async processing → review → revision with carry-over → output → provenance', async () => {
    // 1–2. Upload and immediate, durable acceptance.
    const started = Date.now();
    const accepted = await uploadPdf('/api/documents?documentType=invoice&filename=northwind.pdf', await invoicePdf(INVOICE_V1));
    expect(accepted.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    const documentId = accepted.body.documentId as string;

    // 3–5. Asynchronous processing: extraction with verified evidence, validation.
    await waitFor(documentId, (p) => p.status === 'awaiting_review');
    const v1 = (await rest(`/api/documents/${documentId}`)).body;
    expect(v1.values).toHaveLength(9);
    expect(v1.values.every((v: any) => v.evidence?.quote)).toBe(true);
    expect(v1.values.find((v: any) => v.semanticKey === 'invoice.total').checks.map((c: any) => [c.ruleId, c.outcome])).toEqual(
      expect.arrayContaining([['evidence.verified', 'pass'], ['cross.totals', 'pass']])
    );

    // 6. Review: one correction, the rest approved.
    for (const v of v1.values) {
      const body = v.semanticKey === 'invoice.po_number' ? { action: 'correct', value: 'PO-88213-A', note: 'Matches our PO system' } : { action: 'approve' };
      expect((await rest(`/api/values/${v.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(200);
    }
    expect((await rest(`/api/documents/${documentId}/progress`)).body).toMatchObject({ status: 'approved', progress: { approved: 8, corrected: 1, pending: 0 } });

    // 7–9. Revised document: two changed fields reopen, seven carry over.
    const revision = await uploadPdf(`/api/documents/${documentId}/versions?filename=northwind-rev.pdf`, await invoicePdf(INVOICE_V2));
    expect(revision.status).toBe(202);
    expect(revision.body).toMatchObject({ outcome: 'new_version', version: 2 });
    // Carried-over decisions alone do not make the revision "in progress": it is ready for review of the 2 reopened fields.
    const afterRevision = await waitFor(documentId, (p) => p.version === 2 && p.status === 'awaiting_review');
    expect(afterRevision.progress).toMatchObject({ pending: 2, carriedOver: 7, gaps: 0 });
    const v2 = (await rest(`/api/documents/${documentId}`)).body;
    expect(v2.values.filter((v: any) => v.state === 'pending').map((v: any) => v.semanticKey).sort()).toEqual(['invoice.due_date', 'invoice.po_number']);
    for (const v of v2.values.filter((x: any) => x.state === 'pending')) {
      await rest(`/api/values/${v.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    }

    // 10. Output document.
    const gen = await rest(`/api/documents/${documentId}/generate`, { method: 'POST' });
    expect(gen.status).toBe(202);
    await waitFor(documentId, (p) => p.status === 'completed');
    const verified = await capability('documents.outputs.verify', { tenant: 'lakeside', generatedDocumentId: gen.body.generatedDocumentId });
    expect(verified.reproducible).toBe(true);

    // 11. Provenance.
    const prov = await capability('documents.provenance', { tenant: 'lakeside', documentId });
    expect(prov.submissions.map((s: any) => [s.version, s.outcome, s.submitted_by])).toEqual([
      [1, 'new_document', 'Riley Reviewer (Lakeside)'],
      [2, 'new_version', 'Riley Reviewer (Lakeside)'],
    ]);
    expect(prov.versions.map((v: any) => [v.version, v.template_version, v.baseline_version, v.parser])).toEqual([
      [1, 1, null, expect.stringMatching(/^pdfjs-dist@/)],
      [2, 1, 1, expect.stringMatching(/^pdfjs-dist@/)],
    ]);
    expect(prov.versions[1].model_selection.notes.join(' ')).toMatch(/semantic: laya/);
    expect(prov.modelCalls.length).toBe(2);
    expect(prov.modelCalls[0]).not.toHaveProperty('prompt'); // raw model I/O withheld from customers
    expect(prov.decisions.filter((d: any) => d.action === 'carry_over')).toHaveLength(7);
    expect(prov.decisions.find((d: any) => d.action === 'correct')).toMatchObject({ old_value: 'PO-88213', new_value: 'PO-88213-A', actor: 'Riley Reviewer (Lakeside)' });
    expect(prov.generated[0]).toMatchObject({ status: 'succeeded', template_version: 1, version: 2, renderer_version: 'lomi-pdf-renderer/1' });
    const raw = await capability('documents.provenance', { tenant: 'lakeside', documentId, includeRawModelIo: true }, OPERATOR);
    expect(raw.modelCalls[0].prompt).toContain('Northwind');
  });

  it('a newly published template version never changes earlier documents or outputs', async () => {
    const id = (await uploadPdf('/api/documents?documentType=invoice&filename=t.pdf', await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0700' }))).body.documentId;
    await waitFor(id, (p) => p.status === 'awaiting_review');
    for (const v of (await rest(`/api/documents/${id}`)).body.values) {
      await rest(`/api/values/${v.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    }
    const gen = (await rest(`/api/documents/${id}/generate`, { method: 'POST' })).body;
    await waitFor(id, (p) => p.status === 'completed');
    const [before] = await q(ctx, 'SELECT output_sha256 FROM generated_documents WHERE id = $1', [gen.generatedDocumentId]);

    // Operator publishes template v2 with a different output position for the total.
    const changed = { ...INVOICE_TEMPLATE, fields: INVOICE_TEMPLATE.fields.map((f) => (f.semanticKey === 'invoice.total' ? { ...f, x: f.x + 40 } : f)) };
    const draft = await capability('templates.drafts.save', { tenant: 'lakeside', documentType: 'invoice', definition: changed }, OPERATOR);
    expect(draft.version).toBe(2);
    await capability('templates.publish', { tenant: 'lakeside', templateVersionId: draft.id }, OPERATOR);
    // Published versions cannot be edited.
    await expect(capability('templates.drafts.save', { tenant: 'lakeside', documentType: 'invoice', definition: changed }, OPERATOR)).resolves.toMatchObject({ version: 3, status: 'draft' });

    const doc = (await rest(`/api/documents/${id}`)).body;
    expect(doc.viewing.templateVersion).toBe(1);
    const verified = await capability('documents.outputs.verify', { tenant: 'lakeside', generatedDocumentId: gen.generatedDocumentId });
    expect(verified).toMatchObject({ reproducible: true, storedSha256: before.output_sha256 });
    // A new document uses the new version.
    const fresh = (await uploadPdf('/api/documents?documentType=invoice&filename=t2.pdf', await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0701' }))).body.documentId;
    await waitFor(fresh, (p) => p.status === 'awaiting_review');
    expect((await rest(`/api/documents/${fresh}`)).body.viewing.templateVersion).toBe(2);
  });

  it('concurrent versions: the latest wins, earlier unprocessed versions are superseded and kept', async () => {
    await worker.stop(); // hold processing so both versions are queued at once
    const id = (await uploadPdf('/api/documents?documentType=invoice&filename=c1.pdf', await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0800' }))).body.documentId;
    const second = await uploadPdf(`/api/documents/${id}/versions?filename=c2.pdf`, await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0800', due: 'April 30, 2026' }));
    expect(second.body.version).toBe(2);
    worker = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000 });
    const p = await waitFor(id, (x) => x.status === 'awaiting_review');
    expect(p.version).toBe(2);
    const versions = await q(ctx, `SELECT version, processing_status FROM document_versions WHERE document_id = $1 ORDER BY version`, [id]);
    expect(versions).toEqual([
      { version: 1, processing_status: 'superseded' },
      { version: 2, processing_status: 'processed' },
    ]);
    const jobs = await q(ctx, `SELECT dv.version, j.status FROM jobs j JOIN document_versions dv ON dv.id = j.subject_id WHERE dv.document_id = $1 ORDER BY dv.version`, [id]);
    expect(jobs).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'succeeded' },
    ]);
  });
});
