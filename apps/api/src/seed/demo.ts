import { randomUUID } from 'node:crypto';
import type { TemplateDefinition } from '@lomi/docops';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { withSystem } from '../db/pool';
import { audit, type Actor, type Ctx } from '../domain/common';
import { addVersion, submitDocument, type Channel } from '../domain/documents';
import { createFormFromPdf, outputFormPdf, type RegionFieldSpec } from '../domain/forms';
import { requestGeneration } from '../domain/generation';
import { reviewValue } from '../domain/review';
import { createDocumentType, publishTemplate, saveDraft, uploadBasePdf } from '../domain/templates';
import { addMembership, createPrincipal, createTenant } from '../domain/tenants';
import { INVOICE_TEMPLATE, LEASE_TEMPLATE } from './fixtures';

/**
 * Demo workload (Lomi operators, demo deployments only). Creates two clearly
 * labelled demo customers, sets up their forms the way an operator would, and
 * sends ~120 documents through the real intake path (API, upload and bulk
 * channels). The worker processes them like any other documents. Once the
 * first versions are processed, a demo reviewer approves some, revisions and
 * identical re-sends arrive, and outputs are generated, so every scenario the
 * operator needs to show is present:
 *
 *   clean documents awaiting review · failed checks (totals, date order,
 *   limits) · gaps · possible duplicates · identical re-sends · revisions with
 *   carry-over · documents identified by layout and by Laya · documents Lomi
 *   could not identify · unreadable files (operator failures) · wrong type ·
 *   partially reviewed · approved · completed with output.
 *
 * Every document is ordinary data, recorded with its demo submitter, reviewer
 * and audit trail. Running it again adds another batch.
 *
 * The run itself lives in the API process (progress is in memory and in the
 * audit log): if the API restarts mid-run, what was already submitted stays
 * and is processed; the later steps are simply not done.
 */

export interface DemoRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  steps: Array<{ at: string; text: string }>;
  tenants: Array<{ slug: string; name: string }>;
  submitted: number;
  error: string | null;
}

let current: DemoRun | null = null;

export function demoStatus(): DemoRun | null {
  return current;
}

const DEMO_TENANTS = [
  { slug: 'harborline-demo', name: 'Harborline Freight (demo)', profile: 'large' as const },
  { slug: 'pinecrest-demo', name: 'Pinecrest Clinics (demo)', profile: 'small' as const },
];

/** Demo forms read deterministically (no semantic model checks), so the demo works offline and loads fast. */
const withoutModelChecks = (t: TemplateDefinition): TemplateDefinition => ({
  ...t,
  fields: t.fields.map((f) => ({ ...f, validationRules: (f.validationRules ?? []).filter((r) => r.kind !== 'semantic') })),
});

// ── Generated documents ────────────────────────────────────────────────────

const FIXED = new Date('2026-01-01T00:00:00Z');
async function linesPdf(title: string, lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 56, y: 730 - i * 20, size: i === 0 ? 16 : 11, font: i === 0 ? bold : font, color: rgb(0.1, 0.1, 0.1) }));
  return doc.save();
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

interface Invoice {
  vendor: string;
  number: string;
  date: Date;
  dueDays: number;
  po: string | null;
  terms: string;
  subtotal: number;
  /** Deliberate faults for the demo. */
  totalOffBy?: number;
  omitTotal?: boolean;
  billTo: string;
}

function invoicePdf(i: Invoice): Promise<Uint8Array> {
  const tax = Math.round(i.subtotal * 0.08 * 100) / 100;
  const total = Math.round((i.subtotal + tax + (i.totalOffBy ?? 0)) * 100) / 100;
  return linesPdf(`Invoice ${i.number}`, [
    'INVOICE',
    `Vendor: ${i.vendor}`,
    '1200 Harbor Way, Suite 4, Portland, OR 97209',
    `Invoice Number: ${i.number}`,
    `Invoice Date: ${longDate(i.date)}`,
    `Due Date: ${longDate(addDays(i.date, i.dueDays))}`,
    ...(i.po ? [`Purchase Order: ${i.po}`] : []),
    `Payment Terms: ${i.terms}`,
    `Bill To: ${i.billTo}`,
    'Description: Freight services and handling',
    `Subtotal: ${money(i.subtotal)}`,
    `Sales Tax: ${money(tax)}`,
    ...(i.omitTotal ? [] : [`Total Due: ${money(total)}`]),
  ]);
}

function leasePdf(n: number, tenant: string): Promise<Uint8Array> {
  const start = new Date(Date.UTC(2026, n % 12, 1));
  const rent = 9_000 + n * 750;
  return linesPdf('Lease excerpt', [
    'COMMERCIAL LEASE - EXCERPT',
    `Landlord: ${['Riverbend Holdings LP', 'Bayside Realty Trust', 'Granite Peak Partners'][n % 3]}`,
    `Tenant: ${tenant}`,
    `Premises: ${200 + n * 15} Market Street, Floor ${2 + (n % 9)}, San Francisco, CA 94105`,
    `Commencement Date: ${longDate(start)}`,
    `Expiration Date: ${longDate(new Date(Date.UTC(2031, start.getUTCMonth(), 1)))}`,
    `Base Monthly Rent: ${money(rent)}`,
    `Security Deposit: ${money(rent * 2)}`,
  ]);
}

function packingSlipPdf(n: number): Promise<Uint8Array> {
  return linesPdf('Packing slip', [
    'PACKING SLIP',
    `Shipment: SHP-${40210 + n}`,
    `Carrier: ${['Coastal Express', 'Ridgeway Haulage'][n % 2]}`,
    'Contents: 14 cartons, palletized',
    'Received by: ____________________',
  ]);
}

/** A file that starts like a PDF but is not one: it fails at parsing and goes to an operator. */
const brokenPdf = (n: number) => new Uint8Array(Buffer.from(`%PDF-1.7\n% demo: truncated upload ${n}\n1 0 obj << /Type /Catalog`));

// Supplier onboarding: a fixed-layout form (labels left, ruled boxes right).
const ONBOARDING_ROWS: Array<{ label: string; key: string; type: RegionFieldSpec['type']; hint?: string }> = [
  { label: 'Legal company name', key: 'company', type: 'text' },
  { label: 'Tax ID (EIN)', key: 'ein', type: 'text' },
  { label: 'Start date', key: 'start', type: 'date', hint: 'MM/DD/YYYY' },
  { label: 'Annual spend', key: 'spend', type: 'currency' },
  { label: 'Payment terms (days)', key: 'terms', type: 'number' },
];
const rowY = (i: number) => 660 - i * 40;

async function onboardingPdf(o: { values?: Record<string, string>; fillable?: boolean; agree?: boolean; edition2027?: boolean; website?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED);
  doc.setModificationDate(FIXED);
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(o.edition2027 ? 'Supplier Registration (2027)' : 'Supplier Onboarding Form', { x: 56, y: 730, size: 16, font: bold });
  page.drawText(o.edition2027 ? 'Part 1 - About the company' : 'Section A - Company details', { x: 56, y: 700, size: 10, font: bold });
  const form = doc.getForm();
  ONBOARDING_ROWS.forEach((r, i) => {
    page.drawText(`${r.label}:`, { x: 56, y: rowY(i) + 7, size: 10, font });
    page.drawRectangle({ x: 220, y: rowY(i), width: 300, height: 22, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    if (r.hint) page.drawText(r.hint, { x: 440, y: rowY(i) + 7, size: 7, font, color: rgb(0.5, 0.5, 0.5) });
    const v = o.values?.[r.key];
    if (o.fillable) {
      const tf = form.createTextField(r.key);
      tf.addToPage(page, { x: 221, y: rowY(i) + 1, width: 200, height: 20, borderWidth: 0 });
      if (v) tf.setText(v);
    } else if (v) {
      page.drawText(v, { x: 224, y: rowY(i) + 7, size: 10, font });
    }
  });
  page.drawText('I confirm the details above:', { x: 56, y: 452, size: 10, font });
  page.drawRectangle({ x: 220, y: 450, width: 12, height: 12, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
  if (o.agree) page.drawText('X', { x: 222.5, y: 452, size: 10, font });
  if (o.edition2027) {
    page.drawText('Company website:', { x: 56, y: 417, size: 10, font });
    page.drawRectangle({ x: 220, y: 410, width: 300, height: 22, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
    if (o.website) page.drawText(o.website, { x: 224, y: 417, size: 10, font });
  }
  return doc.save();
}

const ONBOARDING_FIELDS: RegionFieldSpec[] = [
  ...ONBOARDING_ROWS.map((r, i) => ({ label: r.label, type: r.type, page: 0, x: 220, y: rowY(i), width: 300, height: 22 })),
  { label: 'I confirm the details above', type: 'checkbox', page: 0, x: 220, y: 450, width: 12, height: 12 },
];

const VENDORS = [
  'Northwind Office Supply Co.', 'Contoso Paper Co.', 'Fabrikam Logistics Inc.', 'Adatum Fuel Services', 'Tailspin Tyres LLC', 'Litware Packaging',
  'Proseware Freight Audit', 'Wingtip Forklifts', 'Alpine Pallet Works', 'Blue Yonder Cartage', 'Coho Cold Storage', 'Lucerne Dock Services',
];
const COMPANIES = ['Granite Ridge Supply', 'Oakhurst Medical Linen', 'Bluewater Couriers', 'Summit Scrubs Ltd', 'Cedar Lane Labs', 'Harbor Lights Catering', 'Ironwood Security', 'Meadowbrook Pharma', 'Quarry Street IT', 'Riverstone Janitorial', 'Silverline Imaging', 'Topaz Waste Services'];

/** Deterministic pseudo-random numbers, so a run's documents are reproducible from its batch number. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ── The run ────────────────────────────────────────────────────────────────

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];

export function startDemo(ctx: Ctx, operator: Actor): DemoRun {
  if (current?.status === 'running') return current;
  const run: DemoRun = { id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), finishedAt: null, steps: [], tenants: DEMO_TENANTS.map(({ slug, name }) => ({ slug, name })), submitted: 0, error: null };
  current = run;
  void runDemo(ctx, operator, run).catch((error) => {
    run.status = 'failed';
    run.error = (error as Error).message;
    run.finishedAt = new Date().toISOString();
    step(run, `Stopped: ${run.error}`);
  });
  return run;
}

function step(run: DemoRun, text: string) {
  run.steps.push({ at: new Date().toISOString(), text });
}

interface Tracked {
  tenantId: string;
  documentId: string;
  kind: string;
  bytes?: Uint8Array;
  invoice?: Invoice;
}

async function ensureTenant(ctx: Ctx, operator: Actor, t: (typeof DEMO_TENANTS)[number]) {
  const existing = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT id FROM tenants WHERE slug = $1', [t.slug])).rows[0]);
  const tenantId = (existing?.id as string | undefined) ?? (await createTenant(ctx, operator, { slug: t.slug, name: t.name })).id;
  // A demo submitter (integration) and a demo reviewer, as members, so their actions are attributed.
  const people = await withSystem(ctx.db, async (tx) => {
    const ids: Record<string, string> = {};
    for (const [key, name, role] of [['intake', `Demo intake (${t.name.replace(' (demo)', '')})`, 'submitter'], ['reviewer', 'Dana Demo (reviewer)', 'reviewer']] as const) {
      const email = `${key}@${t.slug}.example`;
      const found = (await tx.query('SELECT id FROM principals WHERE email = $1', [email])).rows[0];
      ids[key] = found?.id ?? (await createPrincipal(tx, { kind: 'user', displayName: name, email }));
      await addMembership(tx, { tenantId, principalId: ids[key], role });
    }
    return ids;
  });
  const types = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT key FROM document_types WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.key as string));
  if (!types.includes('invoice')) {
    const def = withoutModelChecks(INVOICE_TEMPLATE);
    await createDocumentType(ctx, operator, { tenantId, key: 'invoice', name: 'Invoice', description: 'A bill from a supplier asking for payment' });
    const base = await uploadBasePdf(ctx, operator, { tenantId, documentType: 'invoice', filename: 'invoice-output-form.pdf', bytes: await outputFormPdf('Invoice — approved values', def.fields.map((f) => f.displayLabel)) });
    const draft = await saveDraft(ctx, operator, { tenantId, documentType: 'invoice', definition: def, basePdfId: base.id, notes: 'Demo workload' });
    await publishTemplate(ctx, operator, { tenantId, templateVersionId: draft.id });
  }
  if (t.profile === 'large' && !types.includes('lease')) {
    const def = withoutModelChecks(LEASE_TEMPLATE);
    await createDocumentType(ctx, operator, { tenantId, key: 'lease', name: 'Lease', description: 'A rental agreement for premises' });
    const base = await uploadBasePdf(ctx, operator, { tenantId, documentType: 'lease', filename: 'lease-output-form.pdf', bytes: await outputFormPdf('Lease — approved values', def.fields.map((f) => f.displayLabel)) });
    const draft = await saveDraft(ctx, operator, { tenantId, documentType: 'lease', definition: def, basePdfId: base.id, notes: 'Demo workload' });
    await publishTemplate(ctx, operator, { tenantId, templateVersionId: draft.id });
  }
  if (!types.includes('supplier_onboarding')) {
    await createFormFromPdf(ctx, operator, {
      tenantId, name: 'Supplier onboarding', key: 'supplier_onboarding', description: 'Filled in by a new supplier',
      filename: 'supplier-onboarding-blank.pdf', bytes: await onboardingPdf(), fields: ONBOARDING_FIELDS,
    });
  }
  const batch = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1', [tenantId])).rows[0].n as number);
  return { tenantId, people, batch };
}

async function runDemo(ctx: Ctx, operator: Actor, run: DemoRun) {
  const tracked: Tracked[] = [];
  for (const t of DEMO_TENANTS) {
    const { tenantId, people, batch } = await ensureTenant(ctx, operator, t);
    step(run, `${t.name}: customer, demo people and forms (invoice${t.profile === 'large' ? ', lease' : ''}, supplier onboarding) ready.`);
    const intake: Actor = { principalId: people.intake, kind: 'user', displayName: 'Demo intake' };
    const random = rng(batch + (t.profile === 'large' ? 7 : 13) + Date.now() % 997);
    const runTag = String(Date.now()).slice(-4);
    const scale = t.profile === 'large' ? 1 : 0.5;
    const n = (k: number) => Math.max(1, Math.round(k * scale));
    let seq = 0;
    const invoice = (extra: Partial<Invoice> = {}): Invoice => {
      seq++;
      return {
        vendor: VENDORS[Math.floor(random() * VENDORS.length)],
        number: `INV-${runTag}-${String(seq).padStart(4, '0')}`,
        date: new Date(Date.UTC(2026, Math.floor(random() * 10), 1 + Math.floor(random() * 27))),
        dueDays: [15, 30, 45][Math.floor(random() * 3)],
        po: `PO-${70000 + Math.floor(random() * 9999)}`,
        terms: ['Net 15', 'Net 30', 'Net 45'][Math.floor(random() * 3)],
        subtotal: Math.round((400 + random() * 24000) * 100) / 100,
        billTo: t.name.replace(' (demo)', ''),
        ...extra,
      };
    };
    const send = async (kind: string, filename: string, bytes: Uint8Array, opts: { type?: string; channel?: Channel; batchId?: string; invoice?: Invoice } = {}) => {
      try {
        const r = await submitDocument(ctx, intake, { tenantId, documentTypeKey: opts.type, filename, bytes, channel: opts.channel ?? 'api', batchId: opts.batchId });
        tracked.push({ tenantId, documentId: r.documentId, kind, bytes, invoice: opts.invoice });
        run.submitted++;
      } catch (error) {
        step(run, `${t.name}: ${filename} rejected at intake — ${(error as Error).message}`);
      }
    };

    // Clean invoices: one bulk batch, the rest by API and single upload.
    const bulk = randomUUID();
    for (let i = 0; i < n(30); i++) {
      const inv = invoice();
      await send('clean_invoice', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', channel: i < 10 ? 'bulk' : i % 2 ? 'api' : 'upload', batchId: i < 10 ? bulk : undefined, invoice: inv });
    }
    // Invoices sent without a type: identified after reading (Laya), or held for a person.
    for (let i = 0; i < n(4); i++) {
      const inv = invoice();
      await send('untyped_invoice', `scan-${inv.number}.pdf`, await invoicePdf(inv), { channel: 'upload', invoice: inv });
    }
    // Failed checks.
    for (let i = 0; i < n(5); i++) { const inv = invoice({ totalOffBy: 25 + i * 10 }); await send('totals_mismatch', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv }); }
    for (let i = 0; i < n(3); i++) { const inv = invoice({ dueDays: -10 }); await send('due_before_issue', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv }); }
    for (let i = 0; i < n(2); i++) { const inv = invoice({ subtotal: 310_000 + i * 5_000 }); await send('over_limit', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv }); }
    // Gaps: an optional field missing, and a required one missing.
    for (let i = 0; i < n(3); i++) { const inv = invoice({ po: null }); await send('gap_optional', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv }); }
    for (let i = 0; i < n(2); i++) { const inv = invoice({ omitTotal: true }); await send('gap_required', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv }); }
    // Possible duplicates: the same vendor and invoice number, a different file (another PO).
    for (let i = 0; i < n(3); i++) {
      const inv = invoice();
      await send('possible_duplicate', `${inv.number}.pdf`, await invoicePdf(inv), { type: 'invoice', invoice: inv });
      await send('possible_duplicate', `${inv.number}-copy.pdf`, await invoicePdf({ ...inv, po: `PO-${80000 + i}` }), { type: 'invoice', channel: 'upload' });
    }
    // Fixed-layout forms, sent without a type: identified by their printed layout, read by position.
    for (let i = 0; i < n(20); i++) {
      const c = COMPANIES[Math.floor(random() * COMPANIES.length)];
      const values = { company: c, ein: `${10 + Math.floor(random() * 89)}-${1000000 + Math.floor(random() * 8999999)}`, start: `0${1 + (i % 9)}/15/2026`, spend: money(Math.round(5000 + random() * 120000)), terms: String([15, 30, 45, 60][i % 4]) };
      const fillable = i % 3 === 0;
      await send(fillable ? 'form_fillable' : 'form_printed', `onboarding-${c.toLowerCase().replace(/\W+/g, '-')}-${i}.pdf`, await onboardingPdf({ values, fillable, agree: !fillable && i % 2 === 0 }), { channel: 'upload' });
    }
    for (let i = 0; i < n(4); i++) await send('form_partial', `onboarding-incomplete-${i}.pdf`, await onboardingPdf({ values: { company: COMPANIES[i], spend: money(9000 + i * 1000) } }), { channel: 'upload' });
    // A newer edition of the form with an element the current version does not capture.
    for (let i = 0; i < n(3); i++) {
      await send('form_new_edition', `registration-2027-${i}.pdf`, await onboardingPdf({ values: { company: COMPANIES[i + 3], ein: '45-2210987', start: '01/15/2027', spend: '$22,000.00', terms: '30' }, agree: true, edition2027: true, website: `https://${COMPANIES[i + 3].toLowerCase().replace(/\W+/g, '')}.example` }), { channel: 'upload' });
    }
    if (t.profile === 'large') for (let i = 0; i < 4; i++) await send('lease', `lease-${batch + i}.pdf`, await leasePdf(batch + i, t.name.replace(' (demo)', '')), { type: 'lease' });
    // Documents no form describes.
    for (let i = 0; i < n(3); i++) await send('unrecognized', `packing-slip-${batch + i}.pdf`, await packingSlipPdf(batch + i), { channel: 'upload' });
    // Unreadable files: accepted, then fail at parsing for an operator.
    for (let i = 0; i < n(2); i++) await send('unreadable', `upload-${batch + i}.pdf`, brokenPdf(batch + i + Number(runTag)), { type: 'invoice', channel: 'upload' });
    // A fixed-layout form sent as the wrong type.
    await send('wrong_type', `onboarding-sent-as-invoice-${runTag}.pdf`, await onboardingPdf({ values: { company: 'Mislabelled Supplies', spend: '$1,000.00' } }), { type: 'invoice' });
    step(run, `${t.name}: ${tracked.filter((d) => d.tenantId === tenantId).length} documents submitted (API, upload and bulk).`);
  }

  // Wait for the worker to process the first versions.
  step(run, 'Waiting for the worker to read and check everything…');
  const ids = tracked.map((d) => d.documentId);
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const left = await withSystem(ctx.db, async (tx) =>
      (await tx.query(`SELECT count(*)::int AS n FROM documents d JOIN document_versions dv ON dv.id = d.current_version_id WHERE d.id = ANY($1::uuid[]) AND dv.processing_status = ANY($2::text[])`, [ids, IN_FLIGHT])).rows[0].n as number
    );
    if (left === 0) break;
    if (Date.now() > deadline) {
      step(run, `${left} documents are still processing after 15 minutes; continuing with the rest.`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  step(run, 'First versions processed.');

  // A demo reviewer works part of the queue; some outputs are generated; revisions and re-sends arrive.
  for (const t of DEMO_TENANTS) {
    const tenantId = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT id FROM tenants WHERE slug = $1', [t.slug])).rows[0].id as string);
    const reviewerId = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT id FROM principals WHERE email = $1', [`reviewer@${t.slug}.example`])).rows[0].id as string);
    const reviewer: Actor = { principalId: reviewerId, kind: 'user', displayName: 'Dana Demo (reviewer)' };
    const intakeId = await withSystem(ctx.db, async (tx) => (await tx.query('SELECT id FROM principals WHERE email = $1', [`intake@${t.slug}.example`])).rows[0].id as string);
    const intake: Actor = { principalId: intakeId, kind: 'user', displayName: 'Demo intake' };
    const clean = tracked.filter((d) => d.tenantId === tenantId && d.kind === 'clean_invoice');
    const pending = async (documentId: string) =>
      withSystem(ctx.db, async (tx) => (await tx.query(
        `SELECT ev.id FROM documents d JOIN extracted_values ev ON ev.document_version_id = d.current_version_id
         JOIN document_versions dv ON dv.id = d.current_version_id
         WHERE d.id = $1 AND dv.processing_status = 'processed' AND ev.review_state = 'pending' AND ev.disposition <> 'gap' ORDER BY ev.semantic_key`,
        [documentId]
      )).rows.map((r) => r.id as string));

    const approveAll = clean.slice(0, Math.round(clean.length * 0.4));
    let approved = 0;
    for (const d of approveAll) {
      for (const valueId of await pending(d.documentId)) await reviewValue(ctx, reviewer, { tenantId, valueId, action: 'approve', note: 'Checked against the original (demo)' });
      approved++;
    }
    // Some approved documents get their output generated (completed).
    let generated = 0;
    for (const d of approveAll.slice(0, Math.ceil(approveAll.length / 2))) {
      await requestGeneration(ctx, reviewer, { tenantId, documentId: d.documentId }).then(() => generated++).catch(() => undefined);
    }
    // Partly reviewed.
    for (const d of clean.slice(approveAll.length, approveAll.length + 4)) {
      const values = await pending(d.documentId);
      for (const valueId of values.slice(0, Math.ceil(values.length / 2))) await reviewValue(ctx, reviewer, { tenantId, valueId, action: 'approve' });
    }
    // Revisions of approved invoices: the due date and total change; everything else carries over.
    let revised = 0;
    for (const d of approveAll.slice(-3)) {
      if (!d.invoice) continue;
      const inv = { ...d.invoice, dueDays: d.invoice.dueDays + 15, subtotal: Math.round(d.invoice.subtotal * 1.06 * 100) / 100 };
      await addVersion(ctx, intake, { tenantId, documentId: d.documentId, filename: `${inv.number}-revised.pdf`, bytes: await invoicePdf(inv), channel: 'api' });
      revised++;
    }
    // Identical re-sends: recorded as receipts, not reprocessed.
    let resent = 0;
    for (const d of clean.slice(-4)) {
      if (!d.bytes) continue;
      await submitDocument(ctx, intake, { tenantId, documentTypeKey: 'invoice', filename: `resend-${d.invoice?.number ?? 'invoice'}.pdf`, bytes: d.bytes, channel: 'upload' });
      resent++;
    }
    step(run, `${t.name}: ${approved} approved by the demo reviewer, ${generated} outputs requested, 4 partly reviewed, ${revised} revised, ${resent} re-sent.`);
    await withSystem(ctx.db, (tx) =>
      audit(tx, { tenantId, actor: { ...{ principalId: null, kind: 'system' as const, displayName: 'demo workload' } }, action: 'demo.workload_loaded', subjectType: 'tenant', subjectId: tenantId, detail: { runId: run.id, documents: tracked.filter((d) => d.tenantId === tenantId).length } })
    );
  }
  run.status = 'done';
  run.finishedAt = new Date().toISOString();
  step(run, 'Done. Revisions and outputs finish processing in the background.');
}
