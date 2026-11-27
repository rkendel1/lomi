import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addVersion, getDocument, listRecords, submitDocument } from '../../domain/documents';
import { createFormFromPdf, extendForm, type RegionFieldSpec } from '../../domain/forms';
import { rereadDocument, setDocumentType } from '../../domain/documents';
import { reviewValue } from '../../domain/review';
import type { Actor } from '../../domain/common';
import { seedConfiguration } from '../../seed/seed';
import { drain, fakeLaya, OPERATOR, PATTERN_TEMPLATES, q, setup } from './harness';

const SUBMITTER: Actor = { principalId: null, kind: 'user', displayName: 'submitter' };

/** Supplier onboarding form: title, labels on the left, ruled boxes on the right, a printed hint in the date box. */
const ROWS = [
  { label: 'Legal company name', key: 'company', type: 'text' as const },
  { label: 'Tax ID (EIN)', key: 'ein', type: 'text' as const },
  { label: 'Start date', key: 'start', type: 'date' as const, hint: 'MM/DD/YYYY' },
  { label: 'Annual spend', key: 'spend', type: 'currency' as const },
  { label: 'Payment terms (days)', key: 'terms', type: 'number' as const },
];
const boxY = (i: number) => 660 - i * 40;
const BOX = { x: 220, width: 300, height: 22 };

async function onboardingForm(opts: { values?: Record<string, string>; fillable?: boolean; agree?: boolean; edition2027?: boolean; website?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(opts.edition2027 ? 'Northwind Supplier Registration (2027)' : 'Northwind Supplier Onboarding Form', { x: 56, y: 730, size: 16, font: bold });
  page.drawText(opts.edition2027 ? 'Part 1 - About the company' : 'Section A - Company details', { x: 56, y: 700, size: 10, font: bold });
  if (opts.edition2027) {
    // The 2027 edition adds a box the current schema does not capture.
    page.drawText('Company website', { x: 56, y: 410 + 7, size: 10, font });
    page.drawRectangle({ x: 220, y: 410, width: 300, height: 22, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    if (opts.website) page.drawText(opts.website, { x: 224, y: 417, size: 10, font });
  }
  const form = doc.getForm();
  ROWS.forEach((r, i) => {
    page.drawText(r.label, { x: 56, y: boxY(i) + 7, size: 10, font });
    page.drawRectangle({ x: BOX.x, y: boxY(i), width: BOX.width, height: BOX.height, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    if (r.hint) page.drawText(r.hint, { x: 440, y: boxY(i) + 7, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
    const v = opts.values?.[r.key];
    if (opts.fillable) {
      const tf = form.createTextField(r.key);
      tf.addToPage(page, { x: BOX.x + 1, y: boxY(i) + 1, width: 200, height: BOX.height - 2, borderWidth: 0 });
      if (v) tf.setText(v);
    } else if (v) {
      page.drawText(v, { x: BOX.x + 4, y: boxY(i) + 7, size: 10, font });
    }
  });
  page.drawText('I confirm the details above', { x: 56, y: 450 + 2, size: 10, font });
  page.drawRectangle({ x: 220, y: 450, width: 12, height: 12, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  if (opts.agree) page.drawText('X', { x: 222.5, y: 452, size: 10, font });
  return doc.save();
}

/** What coordtool locates on the blank form (the boxes), as the Studio sends it. */
const LOCATED: RegionFieldSpec[] = [
  ...ROWS.map((r, i) => ({ label: r.label, type: r.type, page: 0, x: BOX.x, y: boxY(i), width: BOX.width, height: BOX.height })),
  { label: 'I confirm the details above', type: 'checkbox', page: 0, x: 220, y: 450, width: 12, height: 12 },
];

const FILLED = { company: 'Contoso Paper Co.', ein: '12-3456789', start: '03/01/2026', spend: '$48,250.00', terms: '45' };
const EXPECTED = {
  'supplier_onboarding.legal_company_name': 'Contoso Paper Co.',
  'supplier_onboarding.tax_id_ein': '12-3456789',
  'supplier_onboarding.start_date': '2026-03-01',
  'supplier_onboarding.annual_spend': '48250.00',
  'supplier_onboarding.payment_terms_days': '45',
  'supplier_onboarding.i_confirm_the_details_above': 'true',
};

async function onboardedTenant() {
  // Laya never decides here (no classification scores), so anything the layout does not identify waits for a person.
  const ctx = await setup({ laya: fakeLaya() });
  const tenants = await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
  const tenantId = tenants.lakeside;
  const form = await createFormFromPdf(ctx, OPERATOR, {
    tenantId, name: 'Supplier onboarding', description: 'A new supplier fills this in', filename: 'onboarding-blank.pdf', bytes: await onboardingForm(), fields: LOCATED,
  });
  return { ctx, tenantId, form };
}

const valuesOf = (doc: Awaited<ReturnType<typeof getDocument>>) => Object.fromEntries(doc.values.map((v) => [v.semanticKey, v.normalizedValue]));

describe('fixed-layout forms set up from the form PDF (coordtool)', () => {
  it('builds a positional template: boxes, printed hints ignored, layout anchors from the labels', async () => {
    const { ctx, form } = await onboardedTenant();
    expect(form).toMatchObject({ documentType: { key: 'supplier_onboarding' }, status: 'published' });
    expect(form.layoutAnchors).toBeGreaterThanOrEqual(6);
    const [tv] = await q(ctx, `SELECT definition FROM template_versions WHERE id = $1`, [form.templateVersionId]);
    const start = tv.definition.fields.find((f: any) => f.semanticKey === 'supplier_onboarding.start_date');
    expect(start).toMatchObject({ page: 0, x: 220, y: boxY(2), type: 'date', extraction: { method: 'region', valueType: 'date', exclude: ['mm/dd/yyyy'] } });
    expect(tv.definition.layout.anchors.map((a: any) => a.text)).toContain('Northwind Supplier Onboarding Form');
  });

  it('identifies a filled copy by its layout (no model) and normalizes every element by position', async () => {
    const { ctx, tenantId } = await onboardedTenant();
    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'contoso.pdf', bytes: await onboardingForm({ values: FILLED, agree: true }) });
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc).toMatchObject({ documentType: { key: 'supplier_onboarding' }, typeSource: 'layout', status: 'awaiting_review' });
    expect(valuesOf(doc)).toEqual(EXPECTED);
    expect(doc.values.every((v) => v.method === 'region' && v.confidenceSource === 'deterministic_match')).toBe(true);
    expect(doc.values.find((v) => v.semanticKey === 'supplier_onboarding.annual_spend')?.evidence).toMatchObject({ page: 0, quote: '$48,250.00', box: { x: 220, y: boxY(3) } });
    expect(await q(ctx, `SELECT 1 FROM model_calls WHERE document_version_id = $1`, [doc.currentVersion.id])).toEqual([]);
  });

  it('reads values typed into fillable fields the same way', async () => {
    const { ctx, tenantId } = await onboardedTenant();
    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'contoso-fillable.pdf', bytes: await onboardingForm({ values: FILLED, fillable: true }) });
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.typeSource).toBe('layout');
    expect(valuesOf(doc)).toEqual({ ...EXPECTED, 'supplier_onboarding.i_confirm_the_details_above': 'false' });
  });

  it('reports an empty box as a gap and a non-matching document is not taken for the form', async () => {
    const { ctx, tenantId } = await onboardedTenant();
    const partial = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'partial.pdf', bytes: await onboardingForm({ values: { company: 'Fabrikam' } }) });
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId, documentId: partial.documentId });
    expect(doc.values.find((v) => v.semanticKey === 'supplier_onboarding.start_date')).toMatchObject({ state: 'gap', gapReason: expect.stringMatching(/empty/) });
    const layoutRows = await q(ctx, `SELECT count(*)::int AS n FROM documents WHERE type_source = 'layout'`);
    expect(layoutRows[0].n).toBe(1);
  });

  it("projects the customer's normalized records per form; a revision re-opens only what changed", async () => {
    const { ctx, tenantId } = await onboardedTenant();
    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'contoso.pdf', bytes: await onboardingForm({ values: FILLED, agree: true }) });
    await drain(ctx);
    for (const v of (await getDocument(ctx, { tenantId, documentId: r.documentId })).values) await reviewValue(ctx, OPERATOR, { tenantId, valueId: v.id, action: 'approve' });
    await addVersion(ctx, SUBMITTER, { tenantId, documentId: r.documentId, filename: 'contoso-v2.pdf', bytes: await onboardingForm({ values: { ...FILLED, terms: '60' }, agree: true }) });
    await drain(ctx);
    const v2 = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(v2.values.filter((v) => v.state === 'pending').map((v) => [v.semanticKey, v.normalizedValue])).toEqual([['supplier_onboarding.payment_terms_days', '60']]);

    const records = await listRecords(ctx, { tenantId, documentType: 'supplier_onboarding' });
    expect(records.columns.map((c) => c.label)).toEqual(['Legal company name', 'Tax ID (EIN)', 'Start date', 'Annual spend', 'Payment terms (days)', 'I confirm the details above']);
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0].version).toBe(2);
    expect(records.rows[0].values['supplier_onboarding.annual_spend']).toEqual({ value: '48250.00', state: 'carried_over' });
    expect(records.rows[0].values['supplier_onboarding.payment_terms_days']).toEqual({ value: '60', state: 'pending' });
  });

  it('maps an unrecognized document into an existing form and extends its schema with the element it lacks', async () => {
    const { ctx, tenantId, form } = await onboardedTenant();
    const r = await submitDocument(ctx, SUBMITTER, {
      tenantId, filename: 'contoso-2027.pdf', bytes: await onboardingForm({ values: FILLED, agree: true, edition2027: true, website: 'https://contoso.example' }),
    });
    await drain(ctx);
    let doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.status).toBe('needs_type');
    // The nearest fixed-layout form is on record for the person mapping it.
    const nearest = (doc.classification as any).layoutScores[0];
    expect(nearest.key).toBe('supplier_onboarding');
    expect(nearest.score).toBeGreaterThan(0.5);
    expect(nearest.score).toBeLessThan(0.8);

    // The box is located on this document (coordtool) and added as a new element.
    const extended = await extendForm(ctx, OPERATOR, {
      tenantId, documentType: 'supplier_onboarding', documentId: r.documentId,
      regionFields: [{ label: 'Company website', type: 'text', page: 0, x: 220, y: 410, width: 300, height: 22 }],
    });
    expect(extended).toMatchObject({ previousVersion: 1, version: 2, status: 'published', added: [{ key: 'supplier_onboarding.company_website', method: 'region' }] });
    await expect(extendForm(ctx, OPERATOR, { tenantId, documentType: 'supplier_onboarding', regionFields: [{ label: 'Off page', type: 'text', page: 3, x: 1, y: 1, width: 5, height: 5 }] })).rejects.toThrow(/page 4/);

    await setDocumentType(ctx, SUBMITTER, { tenantId, documentId: r.documentId, documentType: 'supplier_onboarding' });
    await drain(ctx);
    doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.viewing.templateVersion).toBe(2);
    expect(valuesOf(doc)).toEqual({ ...EXPECTED, 'supplier_onboarding.company_website': 'https://contoso.example' });

    // Version 1 is untouched, and the records gain the new column.
    const [v1] = await q(ctx, `SELECT jsonb_array_length(definition->'fields') AS n, status FROM template_versions WHERE id = $1`, [form.templateVersionId]);
    expect(v1).toEqual({ n: 6, status: 'published' });
    const records = await listRecords(ctx, { tenantId, documentType: 'supplier_onboarding' });
    expect(records.columns.at(-1)).toEqual({ key: 'supplier_onboarding.company_website', label: 'Company website' });

    // A copy of the original edition is still identified by layout and read by the extended version (the new element is a gap there).
    const old = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'fabrikam.pdf', bytes: await onboardingForm({ values: { ...FILLED, company: 'Fabrikam' } }) });
    await drain(ctx);
    const oldDoc = await getDocument(ctx, { tenantId, documentId: old.documentId });
    expect(oldDoc.typeSource).toBe('layout');
    expect(oldDoc.values.find((v) => v.semanticKey === 'supplier_onboarding.company_website')?.state).toBe('gap');
  });

  it('re-reads an already processed document after its form gained an element: only the new element needs review', async () => {
    const { ctx, tenantId } = await onboardedTenant();
    // Sent with its type, so it is processed with v1, which has no website element.
    const r = await submitDocument(ctx, SUBMITTER, {
      tenantId, documentTypeKey: 'supplier_onboarding', filename: 'adatum-2027.pdf',
      bytes: await onboardingForm({ values: FILLED, agree: true, edition2027: true, website: 'https://adatum.example' }),
    });
    await drain(ctx);
    for (const v of (await getDocument(ctx, { tenantId, documentId: r.documentId })).values) await reviewValue(ctx, OPERATOR, { tenantId, valueId: v.id, action: 'approve' });
    await expect(rereadDocument(ctx, OPERATOR, { tenantId, documentId: r.documentId })).rejects.toThrow(/already read with the latest version/);

    await extendForm(ctx, OPERATOR, {
      tenantId, documentType: 'supplier_onboarding', documentId: r.documentId,
      regionFields: [{ label: 'Company website', type: 'text', page: 0, x: 220, y: 410, width: 300, height: 22 }],
    });
    const reread = await rereadDocument(ctx, OPERATOR, { tenantId, documentId: r.documentId });
    expect(reread.version).toBe(2);
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.viewing.templateVersion).toBe(2);
    expect(doc.values.filter((v) => v.state === 'pending').map((v) => [v.semanticKey, v.normalizedValue])).toEqual([['supplier_onboarding.company_website', 'https://adatum.example']]);
    expect(doc.values.filter((v) => v.state === 'carried_over')).toHaveLength(6);
    // Same file, not a new receipt.
    expect(doc.receipts.total).toBe(1);
    expect(doc.history.some((h) => h.action === 'document.reread')).toBe(true);
  });
});
