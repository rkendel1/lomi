import type { TemplateDefinition } from '@lomi/docops';
import { withSystem } from '../db/pool';
import type { Actor, Ctx } from '../domain/common';
import { getDocument, submitDocument } from '../domain/documents';
import { createDocumentType, publishTemplate, saveDraft, uploadBasePdf } from '../domain/templates';
import { addMembership, createPrincipal, createTenant, issueToken } from '../domain/tenants';
import { DEV_IDENTITIES } from './identities';
import { outputFormPdf } from './fixtures';
import { DOCUMENT_TYPE_NAMES, fixturePdf, loadExpectedFields, loadManifest, templateFromExpected } from './lomiFixtures';

const SEED: Actor = { principalId: null, kind: 'system', displayName: 'seed' };

const TENANTS = [
  { slug: 'lakeside', name: 'Lakeside Property Management' },
  { slug: 'summit', name: 'Summit Realty Group' },
];

/** Document types and templates come from the assignment fixtures (expected-fields.json). */
function docTypes(overrides: Record<string, TemplateDefinition> = {}) {
  const expected = loadExpectedFields();
  return TENANTS.flatMap((t) =>
    Object.entries(expected).map(([key, fields]) => ({
      tenant: t.slug,
      key,
      name: DOCUMENT_TYPE_NAMES[key] ?? key,
      template: overrides[key] ?? templateFromExpected(key, fields),
      formTitle: `${DOCUMENT_TYPE_NAMES[key] ?? key} — approved values`,
    }))
  );
}

/** Tenants, identities, document types and published templates. Idempotent. */
/** `templates` overrides the fixture-derived template per document type (used by tests). */
export async function seedConfiguration(ctx: Ctx, options: { templates?: Record<string, TemplateDefinition> } = {}): Promise<Record<string, string>> {
  const tenantIds: Record<string, string> = {};
  for (const t of TENANTS) {
    const existing = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT id FROM tenants WHERE slug = $1', [t.slug])).rows[0]);
    tenantIds[t.slug] = existing?.id ?? (await createTenant(ctx, SEED, t)).id;
  }

  await withSystem(ctx.db, async (tx) => {
    const principalIds: Record<string, string> = {};
    for (const who of DEV_IDENTITIES) {
      const found = (await tx.query('SELECT id FROM principals WHERE email = $1', [who.email])).rows[0];
      principalIds[who.key] = found?.id ?? (await createPrincipal(tx, { kind: who.kind, displayName: who.name, email: who.email, isOperator: who.operator }));
      if (!found) await issueToken(tx, principalIds[who.key], 'development seed token', who.token);
    }
    for (const who of DEV_IDENTITIES) {
      for (const m of who.memberships) {
        await addMembership(tx, {
          tenantId: tenantIds[m.tenant], principalId: principalIds[who.key], role: m.role,
          delegatedBy: m.delegatedBy ? principalIds[m.delegatedBy] : undefined, scopes: m.scopes,
        });
      }
    }
  });

  for (const dt of docTypes(options.templates)) {
    const tenantId = tenantIds[dt.tenant];
    const exists = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT 1 FROM document_types WHERE tenant_id = $1 AND key = $2', [tenantId, dt.key])).rows[0]);
    if (exists) continue;
    await createDocumentType(ctx, SEED, { tenantId, key: dt.key, name: dt.name });
    const base = await uploadBasePdf(ctx, SEED, {
      tenantId, documentType: dt.key, filename: `${dt.key}-output-form.pdf`,
      bytes: await outputFormPdf(dt.formTitle, dt.template.fields.map((f) => f.displayLabel)),
    });
    const draft = await saveDraft(ctx, SEED, { tenantId, documentType: dt.key, definition: dt.template, basePdfId: base.id, notes: 'Initial template (seed)' });
    await publishTemplate(ctx, SEED, { tenantId, templateVersionId: draft.id });
  }
  return tenantIds;
}

async function waitForProcessing(ctx: Ctx, tenantId: string, documentId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const doc = await getDocument(ctx, { tenantId, documentId });
    if (!['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'].includes(doc.status)) return doc;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${doc.title}" to be processed (status ${doc.status}). Is the worker running?`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Seed version 1 of every fixture document (per the manifest) into Lakeside,
 * and the invoice into Summit to show tenant separation. Later versions are
 * left for people to upload. Then wait for the worker and report what was
 * extracted, so a broken fixture or model shows up at startup.
 */
export async function seedDocuments(ctx: Ctx, tenantIds: Record<string, string>, options: { waitMs?: number } = {}) {
  const already = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM documents')).rows[0].n);
  if (already > 0) return { skipped: true, documents: [] as unknown[] };

  const submitter = await withSystem(ctx.db, async (tx) => (await tx.query(`SELECT id, display_name FROM principals WHERE email = 'pat@lakeside.example'`)).rows[0]);
  const actor: Actor = { principalId: submitter.id, kind: 'user', displayName: submitter.display_name };
  const seeded: Array<{ tenant: string; tenantId: string; id: string; title: string }> = [];
  for (const doc of loadManifest()) {
    const v1 = doc.versions.find((v) => v.version === 1)!;
    const targets = doc.type === 'invoice' ? ['lakeside', 'summit'] : ['lakeside'];
    for (const tenant of targets) {
      const r = await submitDocument(ctx, actor, {
        tenantId: tenantIds[tenant], documentTypeKey: doc.type, filename: v1.file.split('/').pop()!, title: doc.title, bytes: fixturePdf(v1.file), channel: 'api',
      });
      seeded.push({ tenant, tenantId: tenantIds[tenant], id: r.documentId, title: doc.title });
    }
  }

  const report = [];
  for (const d of seeded) {
    const doc = await waitForProcessing(ctx, d.tenantId, d.id, options.waitMs ?? 180_000);
    report.push({
      tenant: d.tenant,
      title: d.title,
      status: doc.status,
      failure: doc.failureReason,
      values: doc.values.map((v) => ({ field: v.semanticKey, value: v.normalizedValue, gap: v.gapReason })),
    });
  }
  return { skipped: false, documents: report };
}
