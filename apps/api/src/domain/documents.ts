import type { Tx } from '../db/pool';
import { withTenant } from '../db/pool';
import { sha256Hex, storeObject } from '../storage/objectStore';
import { audit, DomainError, enqueueJob, notFound, type Actor, type Ctx } from './common';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type DocumentStatus =
  | 'received'
  | 'queued'
  | 'parsing'
  | 'extracting'
  | 'validating'
  | 'awaiting_review'
  | 'partially_reviewed'
  | 'approved'
  | 'completed'
  | 'failed_retryable'
  | 'failed_operator'
  | 'superseded';

export interface Progress {
  total: number;
  pending: number;
  gaps: number;
  approved: number;
  autoApproved: number;
  corrected: number;
  carriedOver: number;
  failedChecks: number;
}

/** Customer-facing language: describes the business state, not the machinery. */
const STATUS_LABELS: Record<DocumentStatus, string> = {
  received: 'Received',
  queued: 'Received — waiting to be read',
  parsing: 'Reading document',
  extracting: 'Reading document',
  validating: 'Checking extracted information',
  awaiting_review: 'Ready for review',
  partially_reviewed: 'Review in progress',
  approved: 'Approved',
  completed: 'Completed',
  failed_retryable: 'Delayed — retrying automatically',
  failed_operator: 'On hold — Lomi is resolving an issue',
  superseded: 'Replaced by a newer version',
};

export function deriveStatus(processingStatus: string, progress: Progress | null, hasOutput: boolean): DocumentStatus {
  if (processingStatus !== 'processed') return processingStatus as DocumentStatus;
  if (!progress) return 'awaiting_review';
  const open = progress.pending + progress.gaps;
  if (open === 0) return hasOutput ? 'completed' : 'approved';
  const decided = progress.approved + progress.corrected + progress.carriedOver + progress.autoApproved;
  return decided > 0 && progress.approved + progress.corrected > 0 ? 'partially_reviewed' : 'awaiting_review';
}

export function nextAction(status: DocumentStatus, progress: Progress | null, failureAction: string | null): string {
  switch (status) {
    case 'awaiting_review':
    case 'partially_reviewed': {
      const parts = [];
      if (progress?.gaps) parts.push(`provide ${progress.gaps} missing value${progress.gaps === 1 ? '' : 's'}`);
      if (progress?.pending) parts.push(`review ${progress.pending} field${progress.pending === 1 ? '' : 's'}`);
      const text = parts.join(' and ');
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case 'approved':
      return 'Generate the output document';
    case 'completed':
      return 'None — download the output';
    case 'failed_operator':
      return failureAction ?? 'Lomi has been notified';
    case 'failed_retryable':
      return 'None — retrying automatically';
    case 'superseded':
      return 'Open the latest version';
    default:
      return 'None — processing';
  }
}

export async function progressFor(tx: Tx, versionId: string): Promise<Progress> {
  const { rows } = await tx.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE review_state = 'pending' AND disposition <> 'gap')::int AS pending,
       count(*) FILTER (WHERE review_state = 'pending' AND disposition = 'gap')::int AS gaps,
       count(*) FILTER (WHERE review_state = 'approved' AND disposition <> 'auto_approved')::int AS approved,
       count(*) FILTER (WHERE review_state = 'approved' AND disposition = 'auto_approved')::int AS auto_approved,
       count(*) FILTER (WHERE review_state = 'corrected')::int AS corrected,
       count(*) FILTER (WHERE review_state = 'carried_over')::int AS carried_over,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM validation_results vr WHERE vr.value_id = ev.id AND vr.outcome = 'fail'))::int AS failed_checks
     FROM extracted_values ev WHERE document_version_id = $1`,
    [versionId]
  );
  const r = rows[0];
  return {
    total: r.total,
    pending: r.pending,
    gaps: r.gaps,
    approved: r.approved,
    autoApproved: r.auto_approved,
    corrected: r.corrected,
    carriedOver: r.carried_over,
    failedChecks: r.failed_checks,
  };
}

function assertPdf(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new DomainError('INVALID_INPUT', 'The uploaded file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 'The uploaded file exceeds 20 MB.');
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new DomainError('INVALID_INPUT', 'The uploaded file is not a PDF.');
  }
}

async function resolveIngress(tx: Tx, tenantId: string, ingressKey: string | undefined) {
  const key = ingressKey ?? 'portal';
  const { rows } = await tx.query(
    'SELECT id, enabled, default_document_type_id FROM ingress_endpoints WHERE tenant_id = $1 AND key = $2',
    [tenantId, key]
  );
  if (!rows[0]) throw new DomainError('INVALID_INPUT', `Unknown ingress "${key}".`);
  if (!rows[0].enabled) throw new DomainError('FORBIDDEN', `Ingress "${key}" is disabled.`);
  return rows[0] as { id: string; default_document_type_id: string | null };
}

export interface SubmissionResult {
  submissionId: string;
  documentId: string;
  versionId: string;
  version: number;
  outcome: 'new_document' | 'new_version' | 'duplicate_exact';
  status: DocumentStatus;
  duplicateOf?: { documentId: string; versionId: string; version: number };
}

async function findExactDuplicate(tx: Tx, tenantId: string, sha256: string) {
  const { rows } = await tx.query(
    `SELECT dv.id, dv.document_id, dv.version, dv.processing_status FROM document_versions dv
     WHERE dv.tenant_id = $1 AND dv.sha256 = $2 ORDER BY dv.created_at LIMIT 1`,
    [tenantId, sha256]
  );
  return rows[0] as { id: string; document_id: string; version: number; processing_status: string } | undefined;
}

async function replayIdempotent(tx: Tx, tenantId: string, key: string | undefined): Promise<SubmissionResult | null> {
  if (!key) return null;
  const { rows } = await tx.query(
    `SELECT s.id, s.document_id, s.document_version_id, s.outcome, dv.version, dv.processing_status
     FROM submissions s JOIN document_versions dv ON dv.id = s.document_version_id
     WHERE s.tenant_id = $1 AND s.idempotency_key = $2`,
    [tenantId, key]
  );
  if (!rows[0]) return null;
  return {
    submissionId: rows[0].id,
    documentId: rows[0].document_id,
    versionId: rows[0].document_version_id,
    version: rows[0].version,
    outcome: rows[0].outcome,
    status: rows[0].processing_status,
  };
}

/**
 * Accept a new document. Returns after the file, the document, the
 * submission record and the processing job are committed; extraction runs
 * asynchronously.
 */
export async function submitDocument(
  ctx: Ctx,
  actor: Actor,
  input: {
    tenantId: string;
    documentTypeKey?: string;
    filename: string;
    bytes: Uint8Array;
    ingressKey?: string;
    title?: string;
    idempotencyKey?: string;
  }
): Promise<SubmissionResult> {
  assertPdf(input.bytes);
  const sha256 = sha256Hex(input.bytes);
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const replay = await replayIdempotent(tx, input.tenantId, input.idempotencyKey);
    if (replay) return replay;

    const ingress = await resolveIngress(tx, input.tenantId, input.ingressKey);
    const typeRow = input.documentTypeKey
      ? (await tx.query('SELECT id FROM document_types WHERE tenant_id = $1 AND key = $2', [input.tenantId, input.documentTypeKey])).rows[0]
      : ingress.default_document_type_id
        ? { id: ingress.default_document_type_id }
        : undefined;
    if (!typeRow) throw new DomainError('INVALID_INPUT', `Unknown document type "${input.documentTypeKey ?? '(none)'}".`);

    const duplicate = await findExactDuplicate(tx, input.tenantId, sha256);
    if (duplicate) {
      // The same bytes were already received (possibly via another ingress). Record the receipt; create nothing new.
      const { rows } = await tx.query(
        `INSERT INTO submissions (tenant_id, ingress_id, submitted_by, document_id, document_version_id, sha256, filename, outcome, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'duplicate_exact', $8) RETURNING id`,
        [input.tenantId, ingress.id, actor.principalId, duplicate.document_id, duplicate.id, sha256, input.filename, input.idempotencyKey ?? null]
      );
      await audit(tx, {
        tenantId: input.tenantId, actor, action: 'document.duplicate_received', subjectType: 'document', subjectId: duplicate.document_id,
        detail: { sha256, filename: input.filename, ingress: input.ingressKey ?? 'portal', versionId: duplicate.id },
      });
      return {
        submissionId: rows[0].id,
        documentId: duplicate.document_id,
        versionId: duplicate.id,
        version: duplicate.version,
        outcome: 'duplicate_exact',
        status: duplicate.processing_status as DocumentStatus,
        duplicateOf: { documentId: duplicate.document_id, versionId: duplicate.id, version: duplicate.version },
      };
    }

    const object = await storeObject(tx, ctx.store, input.tenantId, input.bytes, 'application/pdf');
    const doc = await tx.query(
      `INSERT INTO documents (tenant_id, document_type_id, title, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.tenantId, typeRow.id, input.title?.trim() || input.filename, actor.principalId]
    );
    const documentId = doc.rows[0].id as string;
    const versionId = await insertVersion(tx, input.tenantId, documentId, 1, object.id, sha256, input.filename, input.bytes.length);
    const sub = await tx.query(
      `INSERT INTO submissions (tenant_id, ingress_id, submitted_by, document_id, document_version_id, sha256, filename, outcome, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'new_document', $8) RETURNING id`,
      [input.tenantId, ingress.id, actor.principalId, documentId, versionId, sha256, input.filename, input.idempotencyKey ?? null]
    );
    await audit(tx, {
      tenantId: input.tenantId, actor, action: 'document.submitted', subjectType: 'document', subjectId: documentId,
      detail: { versionId, version: 1, sha256, filename: input.filename, ingress: input.ingressKey ?? 'portal' },
    });
    return { submissionId: sub.rows[0].id, documentId, versionId, version: 1, outcome: 'new_document', status: 'queued' };
  });
}

async function insertVersion(
  tx: Tx, tenantId: string, documentId: string, version: number, objectId: string, sha256: string, filename: string, size: number
): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO document_versions (tenant_id, document_id, version, object_id, sha256, filename, size_bytes, processing_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued') RETURNING id`,
    [tenantId, documentId, version, objectId, sha256, filename, size]
  );
  const versionId = rows[0].id as string;
  await tx.query('UPDATE documents SET current_version_id = $1, updated_at = now() WHERE id = $2', [versionId, documentId]);
  await enqueueJob(tx, tenantId, 'process_version', versionId);
  return versionId;
}

/**
 * Add a revised version. Policy for concurrent versions: **latest wins**.
 * Earlier versions that have not finished processing are marked superseded
 * (their records are kept; their in-flight results are discarded at commit).
 * Review carry-over always compares against the most recent *processed*
 * earlier version.
 */
export async function addVersion(
  ctx: Ctx,
  actor: Actor,
  input: { tenantId: string; documentId: string; filename: string; bytes: Uint8Array; ingressKey?: string; idempotencyKey?: string }
): Promise<SubmissionResult> {
  assertPdf(input.bytes);
  const sha256 = sha256Hex(input.bytes);
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const replay = await replayIdempotent(tx, input.tenantId, input.idempotencyKey);
    if (replay) return replay;
    const ingress = await resolveIngress(tx, input.tenantId, input.ingressKey);
    // Lock the document so concurrent uploads get distinct, ordered version numbers.
    const doc = await tx.query('SELECT id FROM documents WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [input.documentId, input.tenantId]);
    if (!doc.rows[0]) throw notFound('Document');

    const duplicate = await findExactDuplicate(tx, input.tenantId, sha256);
    if (duplicate) {
      const { rows } = await tx.query(
        `INSERT INTO submissions (tenant_id, ingress_id, submitted_by, document_id, document_version_id, sha256, filename, outcome, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'duplicate_exact', $8) RETURNING id`,
        [input.tenantId, ingress.id, actor.principalId, duplicate.document_id, duplicate.id, sha256, input.filename, input.idempotencyKey ?? null]
      );
      await audit(tx, {
        tenantId: input.tenantId, actor, action: 'document.duplicate_received', subjectType: 'document', subjectId: input.documentId,
        detail: { sha256, duplicateOfVersionId: duplicate.id, duplicateOfDocumentId: duplicate.document_id },
      });
      return {
        submissionId: rows[0].id, documentId: duplicate.document_id, versionId: duplicate.id, version: duplicate.version,
        outcome: 'duplicate_exact', status: duplicate.processing_status as DocumentStatus,
        duplicateOf: { documentId: duplicate.document_id, versionId: duplicate.id, version: duplicate.version },
      };
    }

    const next = (await tx.query('SELECT coalesce(max(version), 0) + 1 AS v FROM document_versions WHERE document_id = $1', [input.documentId])).rows[0].v as number;
    const superseded = await tx.query(
      `UPDATE document_versions SET processing_status = 'superseded', status_changed_at = now(),
         failure_reason = NULL, failure_action = NULL
       WHERE document_id = $1 AND processing_status IN ('received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable', 'failed_operator')
       RETURNING id, version`,
      [input.documentId]
    );
    if (superseded.rows.length) {
      await tx.query(
        `UPDATE jobs SET status = 'superseded', updated_at = now(), completed_at = now()
         WHERE kind = 'process_version' AND subject_id = ANY($1::uuid[]) AND status IN ('queued', 'retry_wait')`,
        [superseded.rows.map((r) => r.id)]
      );
    }
    const object = await storeObject(tx, ctx.store, input.tenantId, input.bytes, 'application/pdf');
    const versionId = await insertVersion(tx, input.tenantId, input.documentId, next, object.id, sha256, input.filename, input.bytes.length);
    const sub = await tx.query(
      `INSERT INTO submissions (tenant_id, ingress_id, submitted_by, document_id, document_version_id, sha256, filename, outcome, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'new_version', $8) RETURNING id`,
      [input.tenantId, ingress.id, actor.principalId, input.documentId, versionId, sha256, input.filename, input.idempotencyKey ?? null]
    );
    await audit(tx, {
      tenantId: input.tenantId, actor, action: 'document.version_added', subjectType: 'document', subjectId: input.documentId,
      detail: { versionId, version: next, sha256, filename: input.filename, superseded: superseded.rows.map((r) => r.version) },
    });
    return { submissionId: sub.rows[0].id, documentId: input.documentId, versionId, version: next, outcome: 'new_version', status: 'queued' };
  });
}

async function hasOutput(tx: Tx, versionId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM generated_documents WHERE document_version_id = $1 AND status = 'succeeded' LIMIT 1`,
    [versionId]
  );
  return rows.length > 0;
}

export async function documentSummary(tx: Tx, row: Record<string, any>) {
  const progress = row.processing_status === 'processed' ? await progressFor(tx, row.current_version_id) : null;
  const status = deriveStatus(row.processing_status, progress, await hasOutput(tx, row.current_version_id));
  return {
    id: row.id as string,
    title: row.title as string,
    documentType: { key: row.type_key as string, name: row.type_name as string },
    currentVersion: { id: row.current_version_id as string, number: row.version as number },
    submittedAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    status,
    statusLabel: STATUS_LABELS[status],
    failureReason: (row.failure_reason as string | null) ?? null,
    progress,
    nextAction: nextAction(status, progress, row.failure_action ?? null),
    relatedDocuments: Number(row.related_count ?? 0),
  };
}

const SUMMARY_SELECT = `
  SELECT d.id, d.title, d.created_at, d.updated_at, d.current_version_id,
         dt.key AS type_key, dt.name AS type_name,
         dv.version, dv.processing_status, dv.failure_reason, dv.failure_action,
         (SELECT count(*) FROM document_relations r WHERE r.document_id = d.id OR r.related_document_id = d.id) AS related_count
  FROM documents d
  JOIN document_types dt ON dt.id = d.document_type_id
  JOIN document_versions dv ON dv.id = d.current_version_id`;

export async function listDocuments(
  ctx: Ctx,
  input: { tenantId: string; search?: string; status?: string; documentType?: string; limit?: number; offset?: number }
) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const params: unknown[] = [input.tenantId];
    const where = ['d.tenant_id = $1'];
    if (input.search) {
      params.push(`%${input.search}%`);
      where.push(`(d.title ILIKE $${params.length} OR dv.filename ILIKE $${params.length} OR d.business_key ILIKE $${params.length})`);
    }
    if (input.documentType) {
      params.push(input.documentType);
      where.push(`dt.key = $${params.length}`);
    }
    params.push(Math.min(input.limit ?? 50, 200), input.offset ?? 0);
    const { rows } = await tx.query(
      `${SUMMARY_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const items = [];
    for (const row of rows) items.push(await documentSummary(tx, row));
    return input.status ? items.filter((i) => i.status === input.status) : items;
  });
}

/** Full detail for the current (or a specific) version: values, evidence, checks, decisions, history. */
export async function getDocument(ctx: Ctx, input: { tenantId: string; documentId: string; versionId?: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const head = (await tx.query(`${SUMMARY_SELECT} WHERE d.id = $1 AND d.tenant_id = $2`, [input.documentId, input.tenantId])).rows[0];
    if (!head) throw notFound('Document');
    const summary = await documentSummary(tx, head);

    const versions = (
      await tx.query(
        `SELECT dv.id, dv.version, dv.filename, dv.sha256, dv.size_bytes, dv.processing_status, dv.failure_reason, dv.failure_action,
                dv.created_at, dv.processed_at, dv.page_count, dv.baseline_version_id, tv.version AS template_version
         FROM document_versions dv LEFT JOIN template_versions tv ON tv.id = dv.template_version_id
         WHERE dv.document_id = $1 ORDER BY dv.version DESC`,
        [input.documentId]
      )
    ).rows;
    const versionId = input.versionId ?? head.current_version_id;
    const version = versions.find((v) => v.id === versionId);
    if (!version) throw notFound('Document version');

    const values = await valuesForVersion(tx, versionId);
    const generated = (
      await tx.query(
        `SELECT g.id, g.status, g.output_sha256, g.renderer_version, g.snapshot_hash, g.error, g.created_at, g.completed_at,
                tv.version AS template_version, dv.version AS document_version
         FROM generated_documents g JOIN template_versions tv ON tv.id = g.template_version_id
         JOIN document_versions dv ON dv.id = g.document_version_id
         WHERE dv.document_id = $1 ORDER BY g.created_at DESC`,
        [input.documentId]
      )
    ).rows;
    const related = (
      await tx.query(
        `SELECT r.kind, r.reason, CASE WHEN r.document_id = $1 THEN r.related_document_id ELSE r.document_id END AS other_id, d.title
         FROM document_relations r JOIN documents d ON d.id = CASE WHEN r.document_id = $1 THEN r.related_document_id ELSE r.document_id END
         WHERE r.document_id = $1 OR r.related_document_id = $1`,
        [input.documentId]
      )
    ).rows;
    const history = (
      await tx.query(
        `SELECT a.created_at, a.action, a.actor_kind, p.display_name AS actor, a.detail
         FROM audit_events a LEFT JOIN principals p ON p.id = a.actor_principal_id
         WHERE a.subject_id = $1 OR (a.detail->>'documentId') = $1::text ORDER BY a.id`,
        [input.documentId]
      )
    ).rows;

    return {
      ...summary,
      viewing: {
        versionId: version.id,
        number: version.version,
        isCurrent: version.id === head.current_version_id,
        processingStatus: version.processing_status,
        templateVersion: version.template_version,
        pageCount: version.page_count,
        filename: version.filename,
        sha256: version.sha256,
      },
      versions: versions.map((v) => ({
        id: v.id,
        number: v.version,
        filename: v.filename,
        sha256: v.sha256,
        sizeBytes: Number(v.size_bytes),
        processingStatus: v.processing_status,
        failureReason: v.failure_reason,
        failureAction: v.failure_action,
        templateVersion: v.template_version,
        receivedAt: v.created_at.toISOString(),
        processedAt: v.processed_at?.toISOString() ?? null,
      })),
      values,
      generated: generated.map((g) => ({
        id: g.id,
        status: g.status,
        sha256: g.output_sha256,
        rendererVersion: g.renderer_version,
        templateVersion: g.template_version,
        documentVersion: g.document_version,
        error: g.error,
        createdAt: g.created_at.toISOString(),
      })),
      related: related.map((r) => ({ documentId: r.other_id, title: r.title, kind: r.kind, reason: r.reason })),
      history: history.map((h) => ({
        at: h.created_at.toISOString(),
        action: h.action,
        actor: h.actor ?? (h.actor_kind === 'system' ? 'Lomi processing' : h.actor_kind),
        actorKind: h.actor_kind,
        detail: h.detail,
      })),
    };
  });
}

export async function valuesForVersion(tx: Tx, versionId: string) {
  const values = (
    await tx.query(
      `SELECT ev.*, e.page, e.quote, e.box,
              pv.normalized_value AS previous_value, pv.final_value AS previous_final_value, pv.review_state AS previous_review_state,
              pe.quote AS previous_quote, pe.page AS previous_page
       FROM extracted_values ev
       LEFT JOIN evidence e ON e.value_id = ev.id
       LEFT JOIN extracted_values pv ON pv.id = coalesce(ev.carried_from_value_id, ev.previous_value_id)
       LEFT JOIN evidence pe ON pe.value_id = pv.id
       WHERE ev.document_version_id = $1 ORDER BY ev.created_at, ev.semantic_key`,
      [versionId]
    )
  ).rows;
  const ids = values.map((v) => v.id);
  const checks = ids.length
    ? (await tx.query('SELECT * FROM validation_results WHERE value_id = ANY($1::uuid[]) ORDER BY created_at', [ids])).rows
    : [];
  const decisions = ids.length
    ? (
        await tx.query(
          `SELECT rd.*, p.display_name FROM review_decisions rd LEFT JOIN principals p ON p.id = rd.actor_principal_id
           WHERE rd.value_id = ANY($1::uuid[]) ORDER BY rd.created_at`,
          [ids]
        )
      ).rows
    : [];
  const proposals = ids.length
    ? (
        await tx.query(
          `SELECT rp.*, p.display_name FROM review_proposals rp JOIN principals p ON p.id = rp.proposed_by
           WHERE rp.value_id = ANY($1::uuid[]) AND rp.status = 'open'`,
          [ids]
        )
      ).rows
    : [];

  return values.map((v) => {
    const myChecks = checks.filter((c) => c.value_id === v.id);
    const failing = myChecks.filter((c) => c.outcome === 'fail');
    const state =
      v.review_state === 'pending' ? (v.disposition === 'gap' ? 'gap' : 'pending') : v.disposition === 'auto_approved' && v.review_state === 'approved' ? 'auto_approved' : v.review_state;
    return {
      id: v.id as string,
      semanticKey: v.semantic_key as string,
      label: v.label as string,
      fieldType: v.field_type as string,
      required: v.required as boolean,
      method: v.method as string,
      value: v.value as string | null,
      normalizedValue: v.normalized_value as string | null,
      finalValue: v.final_value as string | null,
      state: state as 'pending' | 'gap' | 'approved' | 'auto_approved' | 'corrected' | 'carried_over',
      needsAttention: v.review_state === 'pending',
      attentionReason:
        v.review_state !== 'pending'
          ? null
          : v.disposition === 'gap'
            ? v.gap_reason
            : failing.length
              ? failing.map((c) => c.explanation).join(' ')
              : v.change_reasons
                ? (v.change_reasons as string[]).join(' ')
                : 'Confirm the extracted value against the evidence.',
      gapReason: v.gap_reason as string | null,
      unverified: v.unverified,
      confidence: v.confidence === null ? null : Number(v.confidence),
      confidenceSource: v.confidence_source as string,
      model: v.model as string | null,
      evidence: v.quote ? { page: v.page as number, quote: v.quote as string, box: v.box } : null,
      previous:
        v.carried_from_value_id || v.previous_value_id
          ? {
              valueId: (v.carried_from_value_id ?? v.previous_value_id) as string,
              value: v.previous_value as string | null,
              finalValue: v.previous_final_value as string | null,
              reviewState: v.previous_review_state as string,
              evidence: v.previous_quote ? { page: v.previous_page as number, quote: v.previous_quote as string } : null,
              changeReasons: (v.change_reasons as string[] | null) ?? [],
              carriedOver: Boolean(v.carried_from_value_id),
            }
          : null,
      checks: myChecks.map((c) => ({
        ruleId: c.rule_id,
        method: c.method,
        outcome: c.outcome,
        explanation: c.explanation,
        ruleVersion: c.rule_version,
        model: c.model,
        confidence: c.confidence === null ? null : Number(c.confidence),
        confidenceSource: c.confidence_source,
      })),
      decisions: decisions
        .filter((d) => d.value_id === v.id)
        .map((d) => ({
          id: d.id,
          action: d.action,
          oldValue: d.old_value,
          newValue: d.new_value,
          note: d.note,
          actor: d.display_name ?? (d.actor_kind === 'system' ? 'Lomi processing' : d.actor_kind),
          actorKind: d.actor_kind,
          authority: d.authority,
          at: d.created_at.toISOString(),
        })),
      proposals: proposals
        .filter((p) => p.value_id === v.id)
        .map((p) => ({ id: p.id, proposedValue: p.proposed_value, rationale: p.rationale, proposedBy: p.display_name, at: p.created_at.toISOString() })),
    };
  });
}

export async function getProgress(ctx: Ctx, input: { tenantId: string; documentId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const head = (await tx.query(`${SUMMARY_SELECT} WHERE d.id = $1 AND d.tenant_id = $2`, [input.documentId, input.tenantId])).rows[0];
    if (!head) throw notFound('Document');
    const summary = await documentSummary(tx, head);
    return {
      documentId: summary.id,
      version: summary.currentVersion.number,
      status: summary.status,
      statusLabel: summary.statusLabel,
      nextAction: summary.nextAction,
      failureReason: summary.failureReason,
      progress: summary.progress ?? { total: 0, pending: 0, gaps: 0, approved: 0, autoApproved: 0, corrected: 0, carriedOver: 0, failedChecks: 0 },
    };
  });
}

export async function originalFile(ctx: Ctx, input: { tenantId: string; documentId: string; versionId?: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT dv.object_id, dv.filename FROM document_versions dv JOIN documents d ON d.id = dv.document_id
       WHERE d.id = $1 AND dv.id = coalesce($2::uuid, d.current_version_id)`,
      [input.documentId, input.versionId ?? null]
    );
    if (!rows[0]) throw notFound('Document version');
    const { loadObject } = await import('../storage/objectStore');
    return { filename: rows[0].filename as string, bytes: await loadObject(tx, ctx.store, rows[0].object_id) };
  });
}
