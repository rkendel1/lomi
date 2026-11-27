import { describe, expect, it } from 'vitest';
import { getDocument, listDocuments, setDocumentType, submitDocument } from '../../domain/documents';
import { createForm } from '../../domain/forms';
import { addMember, changeMemberRole, createTenant, listMembers, removeMember } from '../../domain/tenants';
import type { Actor } from '../../domain/common';
import type { LayaNative } from '../../llm/laya';
import { nativeLaya } from '../../llm/laya';
import { buildProviders } from '../../llm/providers';
import { decideType } from '../../llm/layaClassification';
import { seedConfiguration } from '../../seed/seed';
import { fixturePdf, loadManifest } from '../../seed/lomiFixtures';
import { INVOICE_V1, invoicePdf } from '../../seed/fixtures';
import { drain, fakeLaya, OPERATOR, PATTERN_TEMPLATES, q, seedTemplate, setup } from './harness';

/**
 * A fake Laya that answers classification questions from a table keyed by a
 * word in the question ("invoice", "lease", ...); every other decision gets the
 * harness's favourable answer.
 */
function classifyingLaya(scores: Record<string, number>, onClassify?: (req: any) => void): LayaNative {
  const base = fakeLaya();
  return {
    selfTest: base.selfTest,
    create: async () => {
      const inner = await base.create({});
      return {
        decideAsync: async (req: any) => {
          if (!String(req.decisions[0]?.instructions ?? '').startsWith('Is this document a')) return inner.decideAsync(req);
          onClassify?.(req);
          return {
            model: { identifier: 'fake-laya', revision: 'test' },
            backend: 'fake',
            decisions: req.decisions.map((d: any) => {
              const hit = Object.entries(scores).find(([word]) => d.instructions.toLowerCase().includes(`a ${word}`));
              const p = hit ? hit[1] : 0;
              return { name: d.name, kind: 'noul', value: { type: 'noul', value: p > 0.5 }, probabilities: { true: p, false: 1 - p }, confidence: Math.max(p, 1 - p) };
            }),
          };
        },
      };
    },
  };
}

const SUBMITTER: Actor = { principalId: null, kind: 'user', displayName: 'submitter' };

describe('document type detection', () => {
  it('decides deterministically from scores: clear winner, too weak, too close', () => {
    expect(decideType([{ key: 'invoice', score: 0.99 }, { key: 'lease', score: 0.05 }]).typeKey).toBe('invoice');
    expect(decideType([{ key: 'invoice', score: 0.4 }, { key: 'lease', score: 0.05 }]).typeKey).toBeNull();
    expect(decideType([{ key: 'invoice', score: 0.9 }, { key: 'lease', score: 0.75 }]).typeKey).toBeNull();
  });

  it('identifies an untyped submission with Laya, records how, and processes it with that type', async () => {
    const asked: any[] = [];
    const ctx = await setup({ laya: classifyingLaya({ invoice: 0.97, lease: 0.02, 'market report': 0.1 }, (r) => asked.push(r)) });
    const tenants = await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
    const tenantId = tenants.lakeside;
    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'scan.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-DETECT-1' }) });
    expect(r.status).toBe('queued');
    await drain(ctx);

    const doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.documentType?.key).toBe('invoice');
    expect(doc.typeSource).toBe('detected');
    expect(doc.status).toBe('awaiting_review');
    expect(doc.values.length).toBeGreaterThan(0);
    expect((doc.classification as any).scores.find((s: any) => s.key === 'invoice').score).toBeCloseTo(0.97);
    // One question per published type, over the document's own text.
    expect(asked).toHaveLength(1);
    expect(asked[0].decisions).toHaveLength(3);
    expect(asked[0].input).toContain('INV-DETECT-1');
    const calls = await q(ctx, `SELECT purpose, provider FROM model_calls WHERE document_version_id = $1 AND purpose = 'classification'`, [doc.currentVersion.id]);
    expect(calls).toEqual([{ purpose: 'classification', provider: 'laya' }]);
    expect(doc.history.some((h) => h.action === 'document.type_detected')).toBe(true);
  });

  it('holds an unclear document for a person, who chooses the type; processing then continues by itself', async () => {
    const ctx = await setup({ laya: classifyingLaya({ invoice: 0.7, lease: 0.65 }) });
    const tenants = await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
    const tenantId = tenants.lakeside;
    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'unclear.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-UNCLEAR' }) });
    await drain(ctx);

    let doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.status).toBe('needs_type');
    expect(doc.documentType).toBeNull();
    expect(doc.typeSource).toBe('pending');
    expect(doc.failureReason).toMatch(/Ambiguous between invoice/);
    expect(doc.nextAction).toMatch(/Choose which kind of document/);
    // Shows up in lists (LEFT JOIN) and is not lost.
    expect((await listDocuments(ctx, { tenantId })).some((d) => d.id === r.documentId)).toBe(true);

    await expect(setDocumentType(ctx, SUBMITTER, { tenantId, documentId: r.documentId, documentType: 'nope' })).rejects.toThrow(/not a published document type/);
    await setDocumentType(ctx, SUBMITTER, { tenantId, documentId: r.documentId, documentType: 'invoice' });
    await drain(ctx);
    doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.typeSource).toBe('person');
    expect(doc.status).toBe('awaiting_review');
    await expect(setDocumentType(ctx, SUBMITTER, { tenantId, documentId: r.documentId, documentType: 'lease' })).rejects.toThrow(/only be chosen while/);
  });

  it('uses the only published type without asking a model, and an explicit type as sent', async () => {
    let classified = 0;
    const ctx = await setup({ laya: classifyingLaya({}, () => classified++) });
    const { tenantId } = await seedTemplate(ctx, 'solo', 'invoice', PATTERN_TEMPLATES.invoice);
    const untyped = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'a.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-SOLO-1' }) });
    const typed = await submitDocument(ctx, SUBMITTER, { tenantId, documentTypeKey: 'invoice', filename: 'b.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-SOLO-2' }) });
    await drain(ctx);
    expect((await getDocument(ctx, { tenantId, documentId: untyped.documentId })).typeSource).toBe('only_type');
    expect((await getDocument(ctx, { tenantId, documentId: typed.documentId })).typeSource).toBe('submitted');
    expect(classified).toBe(0);
  });

  it('waits for a person when no classifier is available instead of guessing', async () => {
    const ctx = await setup({ laya: fakeLaya({ ready: false }) });
    const tenants = await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
    const r = await submitDocument(ctx, SUBMITTER, { tenantId: tenants.lakeside, filename: 'x.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-NOLAYA' }) });
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId: tenants.lakeside, documentId: r.documentId });
    expect(doc.status).toBe('needs_type');
    expect(doc.failureReason).toMatch(/Automatic identification is unavailable/);
  });
});

describe('quick form setup', () => {
  it('creates a published type from a field list; untyped submissions are then identified against it', async () => {
    const ctx = await setup({ laya: classifyingLaya({ 'purchase order': 0.95, invoice: 0.1 }) });
    const { tenantId } = await seedTemplate(ctx, 'acme', 'invoice', PATTERN_TEMPLATES.invoice);
    const form = await createForm(ctx, OPERATOR, {
      tenantId, name: 'Purchase order', description: 'An order a buyer sends to a supplier',
      fields: [
        { label: 'PO number', type: 'string' },
        { label: 'Order date', type: 'date', instructions: 'date the order was placed' },
        { label: 'Order total', type: 'money', required: true },
        { label: '', type: 'string' }, // blank rows are ignored
      ],
    });
    expect(form).toMatchObject({ documentType: { key: 'purchase_order', name: 'Purchase order' }, status: 'published' });
    expect(form.fields.map((f) => f.key)).toEqual(['purchase_order.po_number', 'purchase_order.order_date', 'purchase_order.order_total']);
    const [tv] = await q(ctx, `SELECT tv.definition, bp.id AS base FROM template_versions tv JOIN base_pdfs bp ON bp.id = tv.base_pdf_id WHERE tv.id = $1`, [form.templateVersionId]);
    expect(tv.definition.fields[1].extraction).toEqual({ method: 'llm', instructions: 'date the order was placed', valueType: 'date' });
    expect(tv.definition.fields[2].required).toBe(true);

    await expect(createForm(ctx, OPERATOR, { tenantId, name: 'Purchase order', fields: [{ label: 'x', type: 'string' }] })).rejects.toThrow(/already exists/);
    await expect(createForm(ctx, OPERATOR, { tenantId, name: 'Empty', fields: [] })).rejects.toThrow(/at least one field/);
    await expect(createForm(ctx, OPERATOR, { tenantId, name: 'Dup', fields: [{ label: 'Total', type: 'money' }, { label: 'total', type: 'money' }] })).rejects.toThrow(/both be called/);
    // Nothing was written by the rejected requests.
    expect((await q(ctx, `SELECT key FROM document_types WHERE tenant_id = $1 ORDER BY key`, [tenantId])).map((r) => r.key)).toEqual(['invoice', 'purchase_order']);

    const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: 'po.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'PO-1' }) });
    await drain(ctx);
    const doc = await getDocument(ctx, { tenantId, documentId: r.documentId });
    expect(doc.documentType?.key).toBe('purchase_order');
    expect(doc.values.map((v) => v.semanticKey).sort()).toEqual(['purchase_order.order_date', 'purchase_order.order_total', 'purchase_order.po_number']);
  });
});

describe('customers and their people', () => {
  it('rejects a short name that cannot be an intake URL with a clear message (not an internal error)', async () => {
    const ctx = await setup();
    await expect(createTenant(ctx, OPERATOR, { slug: 'Acme Corp', name: 'Acme' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/lowercase letters/) });
    await expect(createTenant(ctx, OPERATOR, { slug: 'a', name: 'A' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createTenant(ctx, OPERATOR, { slug: 'acme', name: '  ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await createTenant(ctx, OPERATOR, { slug: ' acme-corp ', name: ' Acme Corp ' })).toMatchObject({ slug: 'acme-corp', name: 'Acme Corp' });
  });

  it('lets an admin add people with roles, never leaving the customer without an admin', async () => {
    const ctx = await setup();
    const tenants = await seedConfiguration(ctx, { templates: PATTERN_TEMPLATES });
    const tenantId = tenants.lakeside;
    const added = await addMember(ctx, OPERATOR, { tenantId, name: 'Nia New', email: 'Nia@Lakeside.example', role: 'submitter' });
    expect(added.signInToken).toMatch(/^lomi_/);
    expect(added.email).toBe('nia@lakeside.example');
    await expect(addMember(ctx, OPERATOR, { tenantId, name: 'Nia', email: 'nia@lakeside.example', role: 'viewer' })).rejects.toThrow(/already has access/);
    // An existing identity joins another customer without a new token.
    const again = await addMember(ctx, OPERATOR, { tenantId: tenants.summit, name: 'Nia', email: 'nia@lakeside.example', role: 'viewer' });
    expect(again.signInToken).toBeNull();

    const members = await listMembers(ctx, tenantId);
    const admin = members.find((m) => m.role === 'customer_admin')!;
    expect(members.find((m) => m.email === 'nia@lakeside.example')?.role).toBe('submitter');
    await expect(changeMemberRole(ctx, OPERATOR, { tenantId, principalId: admin.principalId, role: 'reviewer' })).rejects.toThrow(/only admin/);
    await expect(removeMember(ctx, OPERATOR, { tenantId, principalId: admin.principalId })).rejects.toThrow(/only admin/);
    await changeMemberRole(ctx, OPERATOR, { tenantId, principalId: added.principalId, role: 'customer_admin' });
    await changeMemberRole(ctx, OPERATOR, { tenantId, principalId: admin.principalId, role: 'reviewer' });

    // Removing a person also removes agents delegated by them.
    const riley = members.find((m) => m.email === 'riley@lakeside.example')!;
    await removeMember(ctx, OPERATOR, { tenantId, principalId: riley.principalId });
    const after = await listMembers(ctx, tenantId);
    expect(after.some((m) => m.email === 'riley@lakeside.example' || m.email === 'agent@lakeside.example')).toBe(false);
  });
});

const modelDir = process.env.LAYA_TEST_MODEL_DIR;
describe.skipIf(!modelDir)('document type detection with the real Laya model (set LAYA_TEST_MODEL_DIR)', () => {
  it('identifies every assignment fixture without being told its type', async () => {
    const ctx = await setup();
    ctx.providers = buildProviders({ extractionModel: 'x', semanticModel: 'x', layaEnabled: true, layaNative: nativeLaya(), layaModelRoot: modelDir, extractionDefault: 'none', semanticDefault: 'none' });
    const tenants = await seedConfiguration(ctx);
    const tenantId = tenants.lakeside;
    const expected: Record<string, string> = {};
    for (const d of loadManifest()) {
      for (const v of d.versions) {
        const r = await submitDocument(ctx, SUBMITTER, { tenantId, filename: v.file.split('/').pop()!, title: `${d.title} v${v.version}`, bytes: fixturePdf(v.file) });
        expected[r.documentId] = d.type;
      }
    }
    await drain(ctx);
    for (const [documentId, type] of Object.entries(expected)) {
      const doc = await getDocument(ctx, { tenantId, documentId });
      expect({ title: doc.title, type: doc.documentType?.key, source: doc.typeSource }).toEqual({ title: doc.title, type, source: 'detected' });
    }
  }, 300_000);
});
