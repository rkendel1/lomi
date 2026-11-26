import { withSystem, withTenant } from '../db/pool';
import { requeueJob } from '../jobs/lifecycle';
import { audit, DomainError, notFound, type Actor, type Ctx } from './common';

/**
 * Operational metrics, all derived from persisted records (nothing estimated).
 * With `tenantId` the figures are scoped to that tenant under RLS; without it
 * (Lomi operators only) they span every tenant.
 */
export async function operationalStats(ctx: Ctx, input: { tenantId?: string }) {
  const run = <T>(fn: (tx: any) => Promise<T>) => (input.tenantId ? withTenant(ctx.db, input.tenantId, fn) : withSystem(ctx.db, fn));
  return run(async (tx) => {
    const t = input.tenantId ? 'AND dv.tenant_id = $1' : '';
    const p = input.tenantId ? [input.tenantId] : [];
    const counts = (
      await tx.query(
        `SELECT count(*)::int AS received,
                count(*) FILTER (WHERE dv.processing_status = 'processed')::int AS processed,
                count(*) FILTER (WHERE dv.processing_status IN ('failed_operator'))::int AS failed_needs_operator,
                count(*) FILTER (WHERE dv.processing_status IN ('failed_retryable'))::int AS failed_retrying,
                count(*) FILTER (WHERE dv.processing_status IN ('received','queued','parsing','extracting','validating'))::int AS in_progress,
                count(*) FILTER (WHERE dv.processing_status = 'processed' AND EXISTS (
                  SELECT 1 FROM extracted_values ev WHERE ev.document_version_id = dv.id AND ev.review_state = 'pending'))::int AS awaiting_review,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM dv.processed_at - dv.created_at))
                  FILTER (WHERE dv.processed_at IS NOT NULL) AS median_processing_seconds
         FROM document_versions dv WHERE true ${t}`,
        p
      )
    ).rows[0];
    const reviewTime = (
      await tx.query(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM last_decision - dv.processed_at)) AS median_review_seconds
         FROM document_versions dv
         JOIN LATERAL (SELECT max(rd.created_at) AS last_decision FROM review_decisions rd
                       WHERE rd.document_version_id = dv.id AND rd.actor_kind = 'user') r ON r.last_decision IS NOT NULL
         WHERE NOT EXISTS (SELECT 1 FROM extracted_values ev WHERE ev.document_version_id = dv.id AND ev.review_state = 'pending') ${t}`,
        p
      )
    ).rows[0];
    const failureReasons = (
      await tx.query(
        `SELECT dv.failure_reason AS reason, count(*)::int AS count FROM document_versions dv
         WHERE dv.processing_status IN ('failed_operator', 'failed_retryable') ${t} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
        p
      )
    ).rows;
    // Correction rate per field and per template version: human corrections / human decisions.
    const corrections = (
      await tx.query(
        `SELECT ev.semantic_key, dt.key AS document_type, tv.version AS template_version,
                count(*) FILTER (WHERE rd.action = 'correct')::int AS corrected,
                count(*)::int AS reviewed
         FROM review_decisions rd JOIN extracted_values ev ON ev.id = rd.value_id
         JOIN document_versions dv ON dv.id = ev.document_version_id
         JOIN template_versions tv ON tv.id = dv.template_version_id JOIN document_types dt ON dt.id = tv.document_type_id
         WHERE rd.actor_kind = 'user' ${t}
         GROUP BY 1, 2, 3 ORDER BY corrected DESC, reviewed DESC LIMIT 20`,
        p
      )
    ).rows;
    // Semantic-check outcomes against human decisions: the data needed to calibrate thresholds later.
    const semanticVsHuman = (
      await tx.query(
        `SELECT vr.model, vr.outcome,
                count(*) FILTER (WHERE ev.review_state = 'approved')::int AS human_approved,
                count(*) FILTER (WHERE ev.review_state = 'corrected')::int AS human_corrected
         FROM validation_results vr JOIN extracted_values ev ON ev.id = vr.value_id JOIN document_versions dv ON dv.id = ev.document_version_id
         WHERE vr.method = 'semantic' ${t} GROUP BY 1, 2 ORDER BY 1, 2`,
        p
      )
    ).rows;
    const byTenant = input.tenantId
      ? []
      : (
          await tx.query(
            `SELECT t.slug, t.name,
                    count(dv.id)::int AS documents,
                    count(dv.id) FILTER (WHERE dv.processing_status = 'failed_operator')::int AS needs_operator,
                    count(DISTINCT dv.id) FILTER (WHERE EXISTS (SELECT 1 FROM extracted_values ev WHERE ev.document_version_id = dv.id AND ev.review_state = 'pending'))::int AS awaiting_review
             FROM tenants t LEFT JOIN document_versions dv ON dv.tenant_id = t.id GROUP BY t.id ORDER BY needs_operator DESC, awaiting_review DESC`
          )
        ).rows;
    return {
      documents: {
        received: counts.received,
        processed: counts.processed,
        inProgress: counts.in_progress,
        awaitingReview: counts.awaiting_review,
        failedNeedsOperator: counts.failed_needs_operator,
        failedRetrying: counts.failed_retrying,
      },
      medianProcessingSeconds: counts.median_processing_seconds === null ? null : Number(counts.median_processing_seconds),
      medianReviewSeconds: reviewTime?.median_review_seconds == null ? null : Number(reviewTime.median_review_seconds),
      failureReasons,
      corrections: corrections.map((c: any) => ({ ...c, correctionRate: c.reviewed ? c.corrected / c.reviewed : 0 })),
      semanticVsHuman,
      byTenant,
    };
  });
}

/** Failed processing and generation jobs, with reasons and available actions. */
export async function listFailures(ctx: Ctx, input: { tenantId?: string }) {
  const run = <T>(fn: (tx: any) => Promise<T>) => (input.tenantId ? withTenant(ctx.db, input.tenantId, fn) : withSystem(ctx.db, fn));
  return run(async (tx) => {
    const { rows } = await tx.query(
      `SELECT j.id AS job_id, j.kind, j.status, j.attempts, j.max_attempts, j.last_error, j.updated_at, j.available_at, t.slug AS tenant,
              d.id AS document_id, d.title, dv.version, dv.failure_reason, dv.failure_action
       FROM jobs j JOIN tenants t ON t.id = j.tenant_id
       LEFT JOIN document_versions dv ON dv.id = j.subject_id
       LEFT JOIN generated_documents g ON g.id = j.subject_id
       LEFT JOIN documents d ON d.id = coalesce(dv.document_id, (SELECT document_id FROM document_versions WHERE id = g.document_version_id))
       WHERE j.status IN ('failed', 'retry_wait') ${input.tenantId ? 'AND j.tenant_id = $1' : ''}
       ORDER BY j.updated_at DESC LIMIT 100`,
      input.tenantId ? [input.tenantId] : []
    );
    return rows.map((r: any) => ({
      jobId: r.job_id,
      kind: r.kind,
      status: r.status,
      tenant: r.tenant,
      documentId: r.document_id,
      title: r.title,
      version: r.version,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      reason: r.failure_reason ?? r.last_error,
      action: r.status === 'retry_wait' ? `Retrying automatically at ${r.available_at.toISOString()}` : (r.failure_action ?? 'Retry once the cause is resolved'),
      retryable: r.status === 'failed',
      updatedAt: r.updated_at.toISOString(),
    }));
  });
}

export async function retryJob(ctx: Ctx, actor: Actor, input: { tenantId: string; jobId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const job = (await tx.query('SELECT id, kind, subject_id, status FROM jobs WHERE id = $1', [input.jobId])).rows[0];
    if (!job) throw notFound('Job');
    if (job.status !== 'failed') throw new DomainError('CONFLICT', `Only failed jobs can be retried (this one is ${job.status}).`);
    if (job.kind === 'process_version') {
      const v = (await tx.query('SELECT processing_status, document_id FROM document_versions WHERE id = $1', [job.subject_id])).rows[0];
      if (v.processing_status === 'superseded') throw new DomainError('CONFLICT', 'This version was replaced by a newer one; retry is not needed.');
      await tx.query(`UPDATE document_versions SET processing_status = 'queued', failure_reason = NULL, failure_action = NULL, status_changed_at = now() WHERE id = $1`, [job.subject_id]);
      await audit(tx, { tenantId: input.tenantId, actor, action: 'processing.retried', subjectType: 'document', subjectId: v.document_id, detail: { jobId: job.id, versionId: job.subject_id } });
    } else {
      await tx.query(`UPDATE generated_documents SET status = 'pending', error = NULL WHERE id = $1`, [job.subject_id]);
      await audit(tx, { tenantId: input.tenantId, actor, action: 'output.retried', subjectType: 'generated_document', subjectId: job.subject_id, detail: { jobId: job.id } });
    }
    await requeueJob(tx, job.id);
    return { jobId: job.id as string, status: 'queued' };
  });
}

/** Provider readiness as last reported by workers. The API never loads model runtimes itself. */
export async function providerReadiness(ctx: Ctx) {
  return withSystem(ctx.db, async (tx) =>
    (await tx.query(`SELECT worker_id, role, provider, ready, detail, model, checked_at FROM provider_readiness ORDER BY role, provider, worker_id`)).rows.map((r) => ({
      workerId: r.worker_id, role: r.role, provider: r.provider, ready: r.ready, detail: r.detail, model: r.model, checkedAt: r.checked_at.toISOString(),
      stale: Date.now() - r.checked_at.getTime() > 5 * 60_000,
    }))
  );
}

/** The provenance record for a document: who, how, with what, and every decision. */
export async function provenance(ctx: Ctx, input: { tenantId: string; documentId: string; includeRawModelIo: boolean }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const doc = (await tx.query('SELECT id, title FROM documents WHERE id = $1', [input.documentId])).rows[0];
    if (!doc) throw notFound('Document');
    const submissions = (
      await tx.query(
        `SELECT s.received_at, s.outcome, s.filename, s.sha256, ie.key AS ingress, p.display_name AS submitted_by, dv.version
         FROM submissions s LEFT JOIN ingress_endpoints ie ON ie.id = s.ingress_id LEFT JOIN principals p ON p.id = s.submitted_by
         JOIN document_versions dv ON dv.id = s.document_version_id WHERE s.document_id = $1 ORDER BY s.received_at`,
        [input.documentId]
      )
    ).rows;
    const versions = (
      await tx.query(
        `SELECT dv.id, dv.version, dv.sha256, dv.parser, dv.processing_status, dv.model_selection, tv.version AS template_version,
                tv.definition_hash, bv.version AS baseline_version
         FROM document_versions dv LEFT JOIN template_versions tv ON tv.id = dv.template_version_id
         LEFT JOIN document_versions bv ON bv.id = dv.baseline_version_id WHERE dv.document_id = $1 ORDER BY dv.version`,
        [input.documentId]
      )
    ).rows;
    const ids = versions.map((v) => v.id);
    const modelCalls = (
      await tx.query(
        `SELECT mc.document_version_id, mc.purpose, mc.provider, mc.model, mc.prompt_version, mc.created_at
                ${input.includeRawModelIo ? ', mc.prompt, mc.raw_response' : ''}
         FROM model_calls mc WHERE mc.document_version_id = ANY($1::uuid[]) ORDER BY mc.created_at`,
        [ids]
      )
    ).rows;
    const decisions = (
      await tx.query(
        `SELECT rd.created_at, rd.action, rd.old_value, rd.new_value, rd.note, rd.actor_kind, rd.authority, p.display_name AS actor, ev.semantic_key, dv.version
         FROM review_decisions rd JOIN extracted_values ev ON ev.id = rd.value_id JOIN document_versions dv ON dv.id = rd.document_version_id
         LEFT JOIN principals p ON p.id = rd.actor_principal_id WHERE rd.document_version_id = ANY($1::uuid[]) ORDER BY rd.created_at`,
        [ids]
      )
    ).rows;
    const generated = (
      await tx.query(
        `SELECT g.id, g.status, g.snapshot_hash, g.renderer_version, g.output_sha256, g.created_at, tv.version AS template_version, bp.sha256 AS base_pdf_sha256, dv.version
         FROM generated_documents g JOIN template_versions tv ON tv.id = g.template_version_id JOIN base_pdfs bp ON bp.id = g.base_pdf_id
         JOIN document_versions dv ON dv.id = g.document_version_id WHERE g.document_version_id = ANY($1::uuid[]) ORDER BY g.created_at`,
        [ids]
      )
    ).rows;
    const iso = (r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
    return {
      documentId: doc.id as string,
      title: doc.title as string,
      submissions: submissions.map(iso),
      versions: versions.map(({ id: _id, ...v }) => iso(v)),
      modelCalls: modelCalls.map(iso),
      decisions: decisions.map(iso),
      generated: generated.map(iso),
      rawModelIoIncluded: input.includeRawModelIo,
    };
  });
}
