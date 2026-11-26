import { describe, expect, it } from 'vitest';
import { addVersion, getDocument, getProgress, submitDocument } from '../../domain/documents';
import { generatedFile, requestGeneration, verifyGenerated } from '../../domain/generation';
import { reviewValue } from '../../domain/review';
import { extractPdfText } from '@lomi/pdf/text';
import { INVOICE_V1, INVOICE_V2, invoicePdf } from '../../seed/fixtures';
import { drain, fakeLaya, OPERATOR, q, seedTemplate, setup } from './harness';

const REVIEWER = { ...OPERATOR, displayName: 'reviewer' };

describe('invoice workflow (PostgreSQL, worker logic, fake Laya)', () => {
  it('accepts durably, processes asynchronously, verifies evidence and validates', async () => {
    const ctx = await setup();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submitDocument(ctx, REVIEWER, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });

    // Durable acceptance: committed version, queued job and outbox event exist before any processing.
    expect(sub).toMatchObject({ outcome: 'new_document', version: 1, status: 'queued' });
    expect(await q(ctx, 'SELECT status FROM jobs')).toEqual([{ status: 'queued' }]);
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).toEqual([{ n: 1 }]);
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM extracted_values')).toEqual([{ n: 0 }]);

    expect(await drain(ctx)).toEqual(['succeeded']);
    const doc = await getDocument(ctx, { tenantId, documentId: sub.documentId });
    expect(doc.status).toBe('awaiting_review');
    expect(doc.values).toHaveLength(9);
    const total = doc.values.find((v) => v.semanticKey === 'invoice.total')!;
    expect(total).toMatchObject({ value: '$4,590.00', normalizedValue: '4590.00', state: 'pending', evidence: { page: 0, quote: 'Total Due: $4,590.00' } });
    expect(total.evidence!.box).toMatchObject({ x: 56 });
    expect(total.checks.find((c) => c.ruleId === 'cross.totals')).toMatchObject({ outcome: 'pass' });
    const vendor = doc.values.find((v) => v.semanticKey === 'vendor.name')!;
    expect(vendor.checks.find((c) => c.method === 'semantic')).toMatchObject({ outcome: 'pass', model: 'fake-laya@test (fake)' });
    // Choice check: the fake answers the second option ("within 30 days"), which is accepted.
    const terms = doc.values.find((v) => v.semanticKey === 'invoice.payment_terms')!;
    expect(terms.checks.find((c) => c.method === 'semantic')).toMatchObject({ outcome: 'pass' });
    expect(await q(ctx, `SELECT provider, purpose FROM model_calls`)).toEqual([{ provider: 'laya', purpose: 'semantic_validation' }]);
    const [version] = await q(ctx, 'SELECT model_selection FROM document_versions');
    expect(version.model_selection.notes.join(' ')).toMatch(/semantic: laya/);
    expect(await getProgress(ctx, { tenantId, documentId: sub.documentId })).toMatchObject({ status: 'awaiting_review', progress: { total: 9, pending: 9, gaps: 0 } });
  });

  it('records review decisions, carries unchanged reviews to a revision and reopens the two changed fields', async () => {
    const ctx = await setup();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submitDocument(ctx, REVIEWER, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });
    await drain(ctx);
    const v1 = await getDocument(ctx, { tenantId, documentId: sub.documentId });
    for (const value of v1.values) {
      if (value.semanticKey === 'invoice.po_number') {
        await reviewValue(ctx, REVIEWER, { tenantId, valueId: value.id, action: 'correct', value: 'PO-88213-A', note: 'Customer PO includes suffix' });
      } else {
        await reviewValue(ctx, REVIEWER, { tenantId, valueId: value.id, action: 'approve' });
      }
    }
    expect((await getProgress(ctx, { tenantId, documentId: sub.documentId })).status).toBe('approved');

    const rev = await addVersion(ctx, REVIEWER, { tenantId, documentId: sub.documentId, filename: 'inv-rev.pdf', bytes: await invoicePdf(INVOICE_V2) });
    expect(rev).toMatchObject({ outcome: 'new_version', version: 2 });
    await drain(ctx);
    const v2 = await getDocument(ctx, { tenantId, documentId: sub.documentId });
    const reopened = v2.values.filter((v) => v.state === 'pending').map((v) => v.semanticKey).sort();
    expect(reopened).toEqual(['invoice.due_date', 'invoice.po_number']);
    expect(v2.values.filter((v) => v.state === 'carried_over')).toHaveLength(7);

    const due = v2.values.find((v) => v.semanticKey === 'invoice.due_date')!;
    expect(due.previous).toMatchObject({ value: '2026-04-02', reviewState: 'approved', evidence: { quote: 'Due Date: April 2, 2026' }, carriedOver: false });
    expect(due.previous!.changeReasons.join(' ')).toMatch(/2026-04-02.*2026-04-17/);
    const po = v2.values.find((v) => v.semanticKey === 'invoice.po_number')!;
    expect(po.previous).toMatchObject({ finalValue: 'PO-88213-A', reviewState: 'corrected' });
    // The corrected value from v1 stays visible in v1's append-only history.
    const v1po = (await getDocument(ctx, { tenantId, documentId: sub.documentId, versionId: v1.currentVersion.id })).values.find((v) => v.semanticKey === 'invoice.po_number')!;
    expect(v1po.decisions).toMatchObject([{ action: 'correct', oldValue: 'PO-88213', newValue: 'PO-88213-A', note: 'Customer PO includes suffix' }]);
    const carried = v2.values.find((v) => v.semanticKey === 'invoice.total')!;
    expect(carried.decisions).toMatchObject([{ action: 'carry_over', actorKind: 'system' }]);
    expect(carried.finalValue).toBe('4590.00');

    // Reviewing an old version is refused.
    await expect(reviewValue(ctx, REVIEWER, { tenantId, valueId: v1po.id, action: 'approve' })).rejects.toThrow(/older version/);
    // Agents cannot decide.
    await expect(reviewValue(ctx, { ...REVIEWER, kind: 'agent' }, { tenantId, valueId: due.id, action: 'approve' })).rejects.toThrow(/Only a person/);
  });

  it('generates a reproducible output from the approved snapshot, idempotently', async () => {
    const ctx = await setup();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submitDocument(ctx, REVIEWER, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });
    await drain(ctx);
    await expect(requestGeneration(ctx, REVIEWER, { tenantId, documentId: sub.documentId })).rejects.toThrow(/9 fields still need review/);
    for (const v of (await getDocument(ctx, { tenantId, documentId: sub.documentId })).values) {
      await reviewValue(ctx, REVIEWER, { tenantId, valueId: v.id, action: 'approve' });
    }
    const first = await requestGeneration(ctx, REVIEWER, { tenantId, documentId: sub.documentId });
    const again = await requestGeneration(ctx, REVIEWER, { tenantId, documentId: sub.documentId });
    expect(again.generatedDocumentId).toBe(first.generatedDocumentId);
    expect(await drain(ctx)).toEqual(['succeeded']);

    const doc = await getDocument(ctx, { tenantId, documentId: sub.documentId });
    expect(doc.status).toBe('completed');
    expect(doc.generated[0]).toMatchObject({ status: 'succeeded', templateVersion: 1, documentVersion: 1 });
    const verify = await verifyGenerated(ctx, { tenantId, generatedDocumentId: first.generatedDocumentId });
    expect(verify).toMatchObject({ reproducible: true });
    const file = await generatedFile(ctx, { tenantId, generatedDocumentId: first.generatedDocumentId });
    const text = (await extractPdfText(file.bytes)).pages[0].items.map((i) => i.str);
    expect(text).toContain('Northwind Office Supply Co.');
    expect(text).toContain('$4,590.00');
  });

  it('treats a missing Laya model as a configuration failure: no automatic retries, no silent fallback', async () => {
    const ctx = await setup({ laya: fakeLaya({ ready: false }) });
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submitDocument(ctx, REVIEWER, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });
    expect(await drain(ctx)).toEqual(['failed']);
    const [job] = await q(ctx, 'SELECT status, attempts FROM jobs');
    expect(job).toEqual({ status: 'failed', attempts: 1 });
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).toEqual([{ n: 0 }]);
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM model_calls')).toEqual([{ n: 0 }]);
    const progress = await getProgress(ctx, { tenantId, documentId: sub.documentId });
    expect(progress.status).toBe('failed_operator');
    expect(progress.failureReason).toMatch(/semantic provider "laya" is not ready: model not found/);
    expect(progress.nextAction).toMatch(/ml-runtime model install laya/);
  });

  it('retries transient inference failures with backoff through the outbox', async () => {
    let calls = 0;
    const ctx = await setup({
      laya: fakeLaya({ onDecide: () => { if (++calls === 1) throw new Error('inference timed out'); } }),
    });
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submitDocument(ctx, REVIEWER, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });
    expect(await drain(ctx)).toEqual(['failed']);
    expect((await getProgress(ctx, { tenantId, documentId: sub.documentId })).status).toBe('failed_retryable');
    const [pending] = await q(ctx, `SELECT available_at > now() AS delayed FROM outbox WHERE published_at IS NULL`);
    expect(pending.delayed).toBe(true);
    // Make the retry due now and run it.
    await q(ctx, `UPDATE outbox SET available_at = now() WHERE published_at IS NULL`);
    await q(ctx, `UPDATE jobs SET available_at = now()`);
    expect(await drain(ctx)).toEqual(['succeeded']);
    expect(await q(ctx, 'SELECT attempt, outcome FROM job_attempts ORDER BY attempt')).toEqual([
      { attempt: 1, outcome: 'failed' },
      { attempt: 2, outcome: 'succeeded' },
    ]);
  });
});
