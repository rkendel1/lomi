import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ExtractionProvider } from '@lomi/docops';
import { createApiServer } from '../../app';
import type { Ctx } from '../../domain/common';
import { createDocOpsRoutes } from '../../http/docops';
import { seedConfiguration } from '../../seed/seed';
import { fixturePdf } from '../../seed/lomiFixtures';
import { oracle, registry } from './fixtureOracle';
import { drain, q, setup } from './harness';

/**
 * The assignment's REST contract, exercised exactly as written in the brief:
 * multipart `type` + `file`, the four extraction statuses, progress counts,
 * failure as a retryable state — plus clear identification of re-sends and
 * possible duplicates.
 */
let ctx: Ctx;
let server: Server;
let base: string;
let failNext = false;

const flaky = (inner: ExtractionProvider): ExtractionProvider => ({
  ...inner,
  async extract(req) {
    if (failNext) throw new Error('The extraction model is unavailable (simulated outage)');
    return inner.extract(req);
  },
});

async function upload(file: string, type = 'invoice', path = '/documents') {
  const form = new FormData();
  form.append('type', type);
  form.append('file', new Blob([new Uint8Array(fixturePdf(file))], { type: 'application/pdf' }), file.split('/').pop());
  return fetch(`${base}${path}`, { method: 'POST', body: form }); // no token: the dev default identity applies
}
const get = async (path: string) => (await fetch(`${base}${path}`)).json();

beforeAll(async () => {
  ctx = await setup();
  ctx.providers = registry(flaky(oracle()));
  ctx.config = { ...ctx.config, devDefaultToken: 'dev-lakeside-admin' };
  await seedConfiguration(ctx);
  server = createApiServer(createDocOpsRoutes(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('the brief’s REST contract', () => {
  it('POST /documents (type + file) responds immediately; status goes queued → extracted with values', async () => {
    const started = Date.now();
    const res = await upload('documents/invoice-001.pdf');
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(1500);
    const { documentId } = await res.json();
    expect(await get(`/documents/${documentId}`)).toMatchObject({ status: 'queued', values: [] });
    await drain(ctx);
    const doc = await get(`/documents/${documentId}`);
    expect(doc).toMatchObject({ status: 'extracted', reviewStatus: 'awaiting_review', currentVersion: { number: 1 } });
    expect(doc.values).toHaveLength(5);
    expect(await get(`/documents/${documentId}/progress`)).toMatchObject({ status: 'extracted', counts: { pending: 5, approved: 0, corrected: 0, carriedOver: 0, gaps: 0 } });

    // POST /documents/:id/versions with the same form
    const v2 = await upload('documents/invoice-001.v2.pdf', 'invoice', `/documents/${documentId}/versions`);
    expect(v2.status).toBe(202);
    expect(await get(`/documents/${documentId}`)).toMatchObject({ status: 'queued', currentVersion: { number: 2 } });
  });

  it('a failure is a visible, retryable state', async () => {
    failNext = true;
    const { documentId } = await (await upload('documents/lease-excerpt-001.pdf', 'lease')).json();
    await drain(ctx);
    // Transient failures retry automatically with backoff; make the retries run now and fail too.
    for (let i = 0; i < 3; i++) {
      await q(ctx, `UPDATE outbox SET available_at = now() WHERE published_at IS NULL`);
      await q(ctx, `UPDATE jobs SET available_at = now()`);
      await drain(ctx);
    }
    const failed = await get(`/documents/${documentId}`);
    expect(failed).toMatchObject({ status: 'failed', reviewStatus: 'failed_operator', failureReason: expect.stringMatching(/simulated outage/) });

    failNext = false;
    const retry = await fetch(`${base}/documents/${documentId}/retry`, { method: 'POST' });
    expect(retry.status).toBe(202);
    await drain(ctx);
    expect(await get(`/documents/${documentId}`)).toMatchObject({ status: 'extracted' });
  });

  it('clearly identifies identical re-sends and possible duplicates', async () => {
    const first = await (await upload('documents/market-report-excerpt-001.pdf', 'market_report')).json();
    await drain(ctx);
    // The exact same file again (as an integration would re-send it): recognised, not reprocessed.
    const again = await upload('documents/market-report-excerpt-001.pdf', 'market_report');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: 'duplicate_exact', duplicateOf: { documentId: first.documentId, version: 1 } });
    const doc = await get(`/documents/${first.documentId}`);
    expect(doc.receipts).toMatchObject({ total: 2, identicalResends: 1, revisions: 0 });
    expect(doc.receiptLog.map((r: { label: string }) => r.label)).toEqual(['First received', 'Identical re-send of version 1 — not reprocessed']);

    // The revised invoice sent as a *new* document (not as a version): same vendor + invoice
    // number as the original, different bytes → flagged as possibly the same transaction, never merged.
    const summit = async (file: string) => {
      const form = new FormData();
      form.append('type', 'invoice');
      form.append('file', new Blob([new Uint8Array(fixturePdf(file))], { type: 'application/pdf' }), file.split('/').pop());
      return (await fetch(`${base}/documents`, { method: 'POST', headers: { Authorization: 'Bearer dev-operator', 'X-Lomi-Tenant': 'summit' }, body: form })).json();
    };
    const original = await summit('documents/invoice-001.pdf');
    const revisedAsNew = await summit('documents/invoice-001.v2.pdf');
    expect(revisedAsNew.outcome).toBe('new_document');
    await drain(ctx);
    const flagged = await (await fetch(`${base}/documents/${revisedAsNew.documentId}`, { headers: { Authorization: 'Bearer dev-operator', 'X-Lomi-Tenant': 'summit' } })).json();
    expect(flagged.related).toEqual([
      { documentId: original.documentId, title: expect.any(String), kind: 'possible_same_transaction', reason: 'Both documents carry the same invoice.vendor_name + invoice.invoice_number.' },
    ]);
    expect(flagged.relatedDocuments).toBe(1);
    expect(await q(ctx, `SELECT count(*)::int AS n FROM documents WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'summit')`)).toEqual([{ n: 2 }]);
  });
});
