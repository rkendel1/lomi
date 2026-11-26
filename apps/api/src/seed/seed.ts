import type { TemplateDefinition } from '@lomi/docops';
import { withSystem } from '../db/pool';
import type { Actor, Ctx } from '../domain/common';
import { addVersion, getDocument, submitDocument } from '../domain/documents';
import { reviewValue } from '../domain/review';
import { createDocumentType, publishTemplate, saveDraft, uploadBasePdf } from '../domain/templates';
import { addMembership, createPrincipal, createTenant, issueToken } from '../domain/tenants';
import { DEV_IDENTITIES } from './identities';
import {
  INVOICE_TEMPLATE, INVOICE_V1, INVOICE_V2, invoicePdf, LEASE_TEMPLATE, leaseExcerptPdf, MARKET_REPORT_TEMPLATE, marketReportPdf, outputFormPdf,
} from './fixtures';

const SEED: Actor = { principalId: null, kind: 'system', displayName: 'seed' };

const TENANTS = [
  { slug: 'lakeside', name: 'Lakeside Property Management' },
  { slug: 'summit', name: 'Summit Realty Group' },
];

const DOC_TYPES: Array<{ tenant: string; key: string; name: string; template: TemplateDefinition; formTitle: string }> = [
  { tenant: 'lakeside', key: 'invoice', name: 'Vendor invoice', template: INVOICE_TEMPLATE, formTitle: 'Invoice Approval Record' },
  { tenant: 'lakeside', key: 'lease', name: 'Lease abstract', template: LEASE_TEMPLATE, formTitle: 'Lease Abstract' },
  { tenant: 'lakeside', key: 'market_report', name: 'Market report', template: MARKET_REPORT_TEMPLATE, formTitle: 'Market Snapshot' },
  { tenant: 'summit', key: 'invoice', name: 'Vendor invoice', template: INVOICE_TEMPLATE, formTitle: 'Summit Payables Record' },
];

/** Tenants, identities, document types and published templates. Idempotent. */
export async function seedConfiguration(ctx: Ctx): Promise<Record<string, string>> {
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

  for (const dt of DOC_TYPES) {
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
 * Sample documents. Requires a running worker for the revision step: the
 * invoice is reviewed (one correction) before its revision arrives, so the
 * revision demonstrates carry-over of 7 fields and re-review of 2.
 */
export async function seedDocuments(ctx: Ctx, tenantIds: Record<string, string>, options: { waitMs?: number } = {}) {
  const lakeside = tenantIds.lakeside;
  const already = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM documents')).rows[0].n);
  if (already > 0) return { skipped: true };

  const reviewer = await withSystem(ctx.db, async (tx) => (await tx.query(`SELECT id, display_name FROM principals WHERE email = 'riley@lakeside.example'`)).rows[0]);
  const riley: Actor = { principalId: reviewer.id, kind: 'user', displayName: reviewer.display_name };

  const invoice = await submitDocument(ctx, riley, { tenantId: lakeside, documentTypeKey: 'invoice', filename: 'northwind-INV-2026-0147.pdf', title: 'Northwind invoice INV-2026-0147', bytes: await invoicePdf(INVOICE_V1) });
  await submitDocument(ctx, riley, { tenantId: lakeside, documentTypeKey: 'lease', filename: 'market-st-lease-excerpt.pdf', title: '455 Market St lease excerpt', bytes: await leaseExcerptPdf() });
  await submitDocument(ctx, riley, { tenantId: lakeside, documentTypeKey: 'market_report', filename: 'denver-office-q1-2026.pdf', title: 'Downtown Denver office Q1 2026', bytes: await marketReportPdf() });
  // The same invoice arriving again electronically through the tenant URL is recognised, not duplicated.
  await submitDocument(ctx, { ...riley, displayName: 'AP mailbox integration' }, { tenantId: lakeside, documentTypeKey: 'invoice', channel: 'api', filename: 'fwd-northwind.pdf', bytes: await invoicePdf(INVOICE_V1) });
  // Summit's data is entirely separate.
  await submitDocument(ctx, riley, { tenantId: tenantIds.summit, documentTypeKey: 'invoice', filename: 'summit-INV-2026-0901.pdf', title: 'Northwind invoice INV-2026-0901', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0901' }) }).catch(() => undefined);

  const processed = await waitForProcessing(ctx, lakeside, invoice.documentId, options.waitMs ?? 120_000);
  if (processed.status === 'failed_operator') return { skipped: false, revision: false, reason: processed.failureReason };
  for (const v of processed.values) {
    if (!v.needsAttention) continue;
    if (v.semanticKey === 'invoice.po_number') {
      await reviewValue(ctx, riley, { tenantId: lakeside, valueId: v.id, action: 'correct', value: 'PO-88213-A', note: 'Purchase order in our system includes the -A suffix.' });
    } else if (v.state !== 'gap' || !v.required) {
      await reviewValue(ctx, riley, { tenantId: lakeside, valueId: v.id, action: 'approve' });
    }
  }
  await addVersion(ctx, riley, { tenantId: lakeside, documentId: invoice.documentId, filename: 'northwind-INV-2026-0147-revised.pdf', bytes: await invoicePdf(INVOICE_V2) });
  return { skipped: false, revision: true };
}
