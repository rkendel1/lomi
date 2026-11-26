import { generateLayout, generateMapping, generateTables, generateTransforms } from '@lomi/core';
import { stableHash, type TemplateDefinition } from '@lomi/docops';
import { renderPdf, RENDERER_VERSION } from '@lomi/pdf';
import { withTenant, type Tx } from '../db/pool';
import { completeJob, failJob, holdsLease, requeueJob, type ClaimedJob } from '../jobs/lifecycle';
import { loadObject, sha256Hex, storeObject } from '../storage/objectStore';
import { audit, DomainError, enqueueJob, notFound, SYSTEM, type Actor, type Ctx } from './common';
import { progressFor } from './documents';

export interface GenerationSnapshot {
  documentId: string;
  documentVersionId: string;
  documentVersion: number;
  templateVersionId: string;
  templateVersion: number;
  basePdfSha256: string;
  /** Approved values by semantic key (final value after review/correction/carry-over). */
  values: Record<string, string | null>;
}

/**
 * Render with coordtool's schema-driven renderer from the template's own field
 * definitions. Deterministic: the same snapshot, template and base PDF always
 * produce the same bytes.
 */
export async function renderFromSnapshot(definition: TemplateDefinition, basePdf: Uint8Array, snapshot: GenerationSnapshot): Promise<Uint8Array> {
  const fields = definition.fields.filter((f) => f.sourceFieldId && f.type !== 'signature' && f.type !== 'initials');
  return renderPdf({
    pdfTemplate: basePdf,
    layout: generateLayout(fields),
    mapping: generateMapping(fields),
    transforms: generateTransforms(fields),
    tables: generateTables(fields),
    data: snapshot.values,
    pageOffsets: definition.rendering?.pageOffsets,
    overflowStrategy: definition.rendering?.overflowStrategy,
    deterministic: true,
  });
}

async function buildSnapshot(tx: Tx, documentId: string): Promise<{ snapshot: GenerationSnapshot; basePdfId: string }> {
  const row = (
    await tx.query(
      `SELECT dv.id, dv.version, dv.processing_status, dv.template_version_id, tv.version AS template_version, tv.base_pdf_id, bp.sha256
       FROM documents d JOIN document_versions dv ON dv.id = d.current_version_id
       LEFT JOIN template_versions tv ON tv.id = dv.template_version_id
       LEFT JOIN base_pdfs bp ON bp.id = tv.base_pdf_id
       WHERE d.id = $1`,
      [documentId]
    )
  ).rows[0];
  if (!row) throw notFound('Document');
  if (row.processing_status !== 'processed') throw new DomainError('CONFLICT', 'The document has not finished processing.');
  const progress = await progressFor(tx, row.id);
  const open = progress.pending + progress.gaps;
  if (open > 0) throw new DomainError('CONFLICT', `${open} field${open === 1 ? '' : 's'} still need review before an output can be generated.`, { progress });
  if (!row.base_pdf_id) throw new DomainError('CONFLICT', 'The template used for this document has no base PDF to render onto.');
  const values = (await tx.query('SELECT semantic_key, final_value FROM extracted_values WHERE document_version_id = $1 ORDER BY semantic_key', [row.id])).rows;
  return {
    basePdfId: row.base_pdf_id,
    snapshot: {
      documentId,
      documentVersionId: row.id,
      documentVersion: row.version,
      templateVersionId: row.template_version_id,
      templateVersion: row.template_version,
      basePdfSha256: row.sha256,
      values: Object.fromEntries(values.map((v) => [v.semantic_key, v.final_value])),
    },
  };
}

/**
 * Request an output document for the current, fully reviewed version.
 * Idempotent per snapshot: asking again for unchanged approved data returns
 * the existing output (or the in-flight request); a failed one is retried.
 */
export async function requestGeneration(ctx: Ctx, actor: Actor, input: { tenantId: string; documentId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const { snapshot, basePdfId } = await buildSnapshot(tx, input.documentId);
    const snapshotHash = stableHash(snapshot);
    const config = { deterministic: true, pageOffsets: null };
    const inserted = await tx.query(
      `INSERT INTO generated_documents (tenant_id, document_version_id, template_version_id, base_pdf_id, snapshot, snapshot_hash, renderer_version, config, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (document_version_id, snapshot_hash, renderer_version) DO NOTHING RETURNING id`,
      [input.tenantId, snapshot.documentVersionId, snapshot.templateVersionId, basePdfId, JSON.stringify(snapshot), snapshotHash, RENDERER_VERSION, JSON.stringify(config), actor.principalId]
    );
    let id: string;
    if (inserted.rows[0]) {
      id = inserted.rows[0].id;
      const jobId = await enqueueJob(tx, input.tenantId, 'generate_output', id);
      await tx.query('UPDATE generated_documents SET job_id = $2 WHERE id = $1', [id, jobId]);
    } else {
      const existing = (
        await tx.query('SELECT id, status, job_id FROM generated_documents WHERE document_version_id = $1 AND snapshot_hash = $2 AND renderer_version = $3', [
          snapshot.documentVersionId, snapshotHash, RENDERER_VERSION,
        ])
      ).rows[0];
      id = existing.id;
      if (existing.status === 'failed') {
        await tx.query(`UPDATE generated_documents SET status = 'pending', error = NULL WHERE id = $1`, [id]);
        await requeueJob(tx, existing.job_id);
      }
    }
    await audit(tx, {
      tenantId: input.tenantId, actor, action: 'output.requested', subjectType: 'document', subjectId: input.documentId,
      detail: { generatedDocumentId: id, snapshotHash, rendererVersion: RENDERER_VERSION, templateVersion: snapshot.templateVersion },
    });
    const row = (await tx.query('SELECT status, output_sha256 FROM generated_documents WHERE id = $1', [id])).rows[0];
    return { generatedDocumentId: id, status: row.status as string, sha256: row.output_sha256 as string | null, snapshotHash };
  });
}

/** The `generate_output` job. Writes only the generated-document record; approved data is never touched. */
export async function generateOutput(ctx: Ctx, job: ClaimedJob): Promise<'succeeded' | 'failed'> {
  try {
    const inputs = await withTenant(ctx.db, job.tenantId, async (tx) => {
      const g = (
        await tx.query(
          `SELECT g.*, tv.definition, bp.object_id AS base_object_id, d.document_id
           FROM generated_documents g JOIN template_versions tv ON tv.id = g.template_version_id
           JOIN base_pdfs bp ON bp.id = g.base_pdf_id JOIN document_versions d ON d.id = g.document_version_id
           WHERE g.id = $1`,
          [job.subjectId]
        )
      ).rows[0];
      if (!g) throw new Error('Generated document record missing');
      return { g, basePdf: g.status === 'succeeded' ? null : await loadObject(tx, ctx.store, g.base_object_id) };
    });
    if (!inputs.basePdf) {
      await withTenant(ctx.db, job.tenantId, (tx) => completeJob(tx, job, 'succeeded'));
      return 'succeeded';
    }
    const bytes = await renderFromSnapshot(inputs.g.definition, inputs.basePdf, inputs.g.snapshot);
    return await withTenant(ctx.db, job.tenantId, async (tx) => {
      if (!(await holdsLease(tx, job))) return 'failed';
      const object = await storeObject(tx, ctx.store, job.tenantId, bytes, 'application/pdf');
      await tx.query(
        `UPDATE generated_documents SET status = 'succeeded', output_object_id = $2, output_sha256 = $3, completed_at = now(), error = NULL WHERE id = $1`,
        [job.subjectId, object.id, object.sha256]
      );
      await completeJob(tx, job, 'succeeded');
      await audit(tx, {
        tenantId: job.tenantId, actor: SYSTEM, action: 'output.generated', subjectType: 'document', subjectId: inputs.g.document_id,
        detail: { generatedDocumentId: job.subjectId, sha256: object.sha256, rendererVersion: inputs.g.renderer_version },
      });
      return 'succeeded';
    });
  } catch (error) {
    const message = (error as Error).message;
    await withTenant(ctx.db, job.tenantId, async (tx) => {
      if (!(await holdsLease(tx, job))) return;
      const outcome = await failJob(tx, job, 'transient', message);
      if (!outcome.willRetry) await tx.query(`UPDATE generated_documents SET status = 'failed', error = $2 WHERE id = $1`, [job.subjectId, message]);
    });
    return 'failed';
  }
}

/** Re-render a generated document from its recorded inputs and compare bytes. */
export async function verifyGenerated(ctx: Ctx, input: { tenantId: string; generatedDocumentId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const g = (
      await tx.query(
        `SELECT g.snapshot, g.output_sha256, g.renderer_version, g.status, tv.definition, bp.object_id AS base_object_id, bp.sha256 AS base_sha
         FROM generated_documents g JOIN template_versions tv ON tv.id = g.template_version_id JOIN base_pdfs bp ON bp.id = g.base_pdf_id
         WHERE g.id = $1`,
        [input.generatedDocumentId]
      )
    ).rows[0];
    if (!g) throw notFound('Generated document');
    if (g.status !== 'succeeded') throw new DomainError('CONFLICT', 'The output has not been generated yet.');
    if (g.renderer_version !== RENDERER_VERSION) {
      return { reproducible: false, reason: `Generated by ${g.renderer_version}; this deployment runs ${RENDERER_VERSION}.` };
    }
    const bytes = await renderFromSnapshot(g.definition, await loadObject(tx, ctx.store, g.base_object_id), g.snapshot);
    const sha = sha256Hex(bytes);
    return { reproducible: sha === g.output_sha256, storedSha256: g.output_sha256 as string, regeneratedSha256: sha, basePdfSha256: g.base_sha as string };
  });
}

export async function generatedFile(ctx: Ctx, input: { tenantId: string; generatedDocumentId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const g = (await tx.query(`SELECT output_object_id FROM generated_documents WHERE id = $1 AND status = 'succeeded'`, [input.generatedDocumentId])).rows[0];
    if (!g) throw notFound('Generated document');
    return { filename: `output-${input.generatedDocumentId}.pdf`, bytes: await loadObject(tx, ctx.store, g.output_object_id) };
  });
}
