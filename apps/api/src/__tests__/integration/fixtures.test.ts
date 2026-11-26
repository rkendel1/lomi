import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../domain/common';
import { addVersion, getDocument, listDocuments } from '../../domain/documents';
import { reviewValue } from '../../domain/review';
import { buildProviders } from '../../llm/providers';
import { oracle, registry, TRUTH } from './fixtureOracle';
import { nativeLaya } from '../../llm/laya';
import { seedConfiguration, seedDocuments } from '../../seed/seed';
import { fixturePdf, loadManifest } from '../../seed/lomiFixtures';
import { drain, OPERATOR, q, setup } from './harness';

async function seedFixtures(ctx: Ctx) {
  const tenants = await seedConfiguration(ctx);
  const pending = seedDocuments(ctx, tenants, { waitMs: 120_000 });
  // seedDocuments waits for the worker; act as the worker meanwhile.
  for (let i = 0; i < 400; i++) {
    await drain(ctx);
    const done = await Promise.race([pending.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
    if (done) break;
  }
  return { tenants, report: await pending };
}

async function invoiceOf(ctx: Ctx, tenantId: string) {
  const list = await listDocuments(ctx, { tenantId, documentType: 'invoice' });
  return list[0];
}

describe('assignment fixtures (oracle extraction; runs everywhere)', () => {
  it('seeds version 1 of each manifest document and extracts every expected field, with the missing one as a gap', async () => {
    const ctx = await setup();
    ctx.providers = registry(oracle());
    const { tenants, report } = await seedFixtures(ctx);
    expect(report.skipped).toBe(false);
    const lakeside = await listDocuments(ctx, { tenantId: tenants.lakeside });
    expect(lakeside.map((d) => d.title).sort()).toEqual(loadManifest().map((d) => d.title).sort());
    expect(lakeside.every((d) => d.currentVersion.number === 1)).toBe(true);
    for (const d of lakeside) {
      const doc = await getDocument(ctx, { tenantId: tenants.lakeside, documentId: d.id });
      for (const v of doc.values) {
        expect(v.normalizedValue, v.semanticKey).toBe(TRUTH[v.semanticKey]);
        if (TRUTH[v.semanticKey] === null) expect(v).toMatchObject({ state: 'gap', gapReason: expect.stringMatching(/No value/) });
        else expect(v.evidence?.quote).toBeTruthy();
      }
    }
    // Summit got its own copy and sees only that.
    expect((await listDocuments(ctx, { tenantId: tenants.summit })).map((d) => d.documentType.key)).toEqual(['invoice']);
  });

  it('turns a quote that is not in the PDF into a gap and keeps the model output', async () => {
    const ctx = await setup();
    ctx.providers = registry(oracle({ hallucinate: 'invoice.vendor_name' }));
    const { tenants } = await seedFixtures(ctx);
    const doc = await getDocument(ctx, { tenantId: tenants.lakeside, documentId: (await invoiceOf(ctx, tenants.lakeside)).id });
    const vendor = doc.values.find((v) => v.semanticKey === 'invoice.vendor_name')!;
    expect(vendor).toMatchObject({ value: null, state: 'gap', gapReason: expect.stringMatching(/does not appear verbatim/) });
    expect(vendor.unverified).toMatchObject({ value: 'ACME Corp', quote: 'Vendor: ACME Corp' });
    const [call] = await q(ctx, `SELECT raw_response FROM model_calls mc JOIN document_versions dv ON dv.id = mc.document_version_id WHERE mc.purpose = 'extraction' AND dv.document_id = $1`, [doc.id]);
    expect(call.raw_response).toContain('ACME Corp');
  });

  it('re-extracts the revised invoice: exactly the two changed fields go back to review; v1 stays intact', async () => {
    const ctx = await setup();
    ctx.providers = registry(oracle());
    const { tenants } = await seedFixtures(ctx);
    const tenantId = tenants.lakeside;
    const invoice = await invoiceOf(ctx, tenantId);
    const v1 = await getDocument(ctx, { tenantId, documentId: invoice.id });
    for (const v of v1.values) await reviewValue(ctx, OPERATOR, { tenantId, valueId: v.id, action: 'approve' });

    await addVersion(ctx, OPERATOR, { tenantId, documentId: invoice.id, filename: 'invoice-001.v2.pdf', bytes: fixturePdf('documents/invoice-001.v2.pdf') });
    await drain(ctx);
    const v2 = await getDocument(ctx, { tenantId, documentId: invoice.id });
    expect(v2.viewing.number).toBe(2);
    expect(v2.values.filter((v) => v.state === 'pending').map((v) => v.semanticKey).sort()).toEqual(['invoice.due_date', 'invoice.total_amount']);
    expect(v2.values.filter((v) => v.state === 'carried_over').map((v) => v.semanticKey).sort()).toEqual(['invoice.invoice_number', 'invoice.issue_date', 'invoice.vendor_name']);
    const total = v2.values.find((v) => v.semanticKey === 'invoice.total_amount')!;
    expect(total).toMatchObject({ normalizedValue: '6126.45', previous: { value: '5230.29', reviewState: 'approved', evidence: { quote: 'Total Due: $5,230.29' } } });

    // Version 1 remains queryable with its own evidence and reviews.
    const old = await getDocument(ctx, { tenantId, documentId: invoice.id, versionId: v1.viewing.versionId });
    const oldDue = old.values.find((v) => v.semanticKey === 'invoice.due_date')!;
    expect(oldDue).toMatchObject({ normalizedValue: '2025-10-14', state: 'approved', evidence: { quote: 'Due Date: 2025-10-14' } });
  });
});

const modelDir = process.env.LAYA_TEST_MODEL_DIR;
describe.skipIf(!modelDir)('assignment fixtures with the real Laya model (set LAYA_TEST_MODEL_DIR)', () => {
  it('extracts all 16 expected fields correctly, then re-extracts the revised invoice with exactly 2 to re-review', async () => {
    const ctx = await setup();
    ctx.providers = buildProviders({ extractionModel: 'x', semanticModel: 'x', layaEnabled: true, layaNative: nativeLaya(), layaModelRoot: modelDir, extractionDefault: 'laya', semanticDefault: 'laya' });
    const { tenants } = await seedFixtures(ctx);
    const tenantId = tenants.lakeside;
    const results: Record<string, string | null> = {};
    for (const d of await listDocuments(ctx, { tenantId })) {
      for (const v of (await getDocument(ctx, { tenantId, documentId: d.id })).values) results[v.semanticKey] = v.normalizedValue;
    }
    expect(results).toEqual(TRUTH);

    const invoice = await invoiceOf(ctx, tenantId);
    for (const v of (await getDocument(ctx, { tenantId, documentId: invoice.id })).values) await reviewValue(ctx, OPERATOR, { tenantId, valueId: v.id, action: 'approve' });
    await addVersion(ctx, OPERATOR, { tenantId, documentId: invoice.id, filename: 'invoice-001.v2.pdf', bytes: fixturePdf('documents/invoice-001.v2.pdf') });
    await drain(ctx);
    const v2 = await getDocument(ctx, { tenantId, documentId: invoice.id });
    expect(v2.values.filter((v) => v.state === 'pending').map((v) => [v.semanticKey, v.normalizedValue]).sort()).toEqual([
      ['invoice.due_date', '2025-11-13'],
      ['invoice.total_amount', '6126.45'],
    ]);
  }, 300_000);
});
