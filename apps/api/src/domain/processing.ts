import {
  decideCarryOver,
  evidenceFingerprint,
  extractableFields,
  interpretationHash,
  processDocument,
  ProviderNotReadyError,
  type ParsedDocument,
  type PriorFieldState,
  type ProcessedField,
  type TemplateDefinition,
} from '@lomi/docops';
import { extractPdfText } from '@lomi/pdf/text';
import { withTenant, type Tx } from '../db/pool';
import { layoutMatch, type LayoutFingerprint } from '@lomi/docops';
import type { ClassificationResult, TypeCandidate } from '../llm/layaClassification';

/** A fixed-layout form is identified when this share of its printed anchors is in place… */
const MIN_LAYOUT_SCORE = 0.8;
/** …out of at least this many (fewer is too little evidence). */
const MIN_LAYOUT_ANCHORS = 4;
import { selectProviders } from '../llm/providers';
import { completeJob, failJob, holdsLease, type ClaimedJob } from '../jobs/lifecycle';
import { loadObject } from '../storage/objectStore';
import { audit, SYSTEM, type Ctx } from './common';

/** A failure that no automatic retry can fix; it needs an operator or the customer. */
export class PermanentProcessingError extends Error {
  constructor(
    message: string,
    readonly action: string
  ) {
    super(message);
  }
}

async function setStage(ctx: Ctx, tenantId: string, versionId: string, stage: string): Promise<void> {
  await withTenant(ctx.db, tenantId, (tx) =>
    tx.query(
      `UPDATE document_versions SET processing_status = $2, status_changed_at = now()
       WHERE id = $1 AND processing_status NOT IN ('superseded', 'processed')`,
      [versionId, stage]
    )
  );
}

interface VersionContext {
  version: { id: string; document_id: string; version: number; object_id: string; processing_status: string; document_type_id: string | null };
  /** Null while the document's type is still to be identified. */
  template: { id: string; version: number; definition: TemplateDefinition } | null;
  baseline: { id: string; version: number } | null;
  tenantSettings: Record<string, unknown>;
  bytes: Uint8Array;
}

async function documentIdFor(ctx: Ctx, tenantId: string, versionId: string): Promise<string | null> {
  return withTenant(ctx.db, tenantId, async (tx) => (await tx.query('SELECT document_id FROM document_versions WHERE id = $1', [versionId])).rows[0]?.document_id ?? null);
}

async function loadContext(ctx: Ctx, job: ClaimedJob): Promise<VersionContext | null> {
  return withTenant(ctx.db, job.tenantId, async (tx) => {
    const version = (
      await tx.query(
        `SELECT dv.id, dv.document_id, dv.version, dv.object_id, dv.processing_status, d.document_type_id
         FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1`,
        [job.subjectId]
      )
    ).rows[0];
    if (!version || version.processing_status === 'superseded' || version.processing_status === 'processed') return null;
    const template = version.document_type_id ? await publishedTemplate(tx, version.document_type_id) : null;
    const baseline =
      (
        await tx.query(
          `SELECT id, version FROM document_versions WHERE document_id = $1 AND version < $2 AND processing_status = 'processed'
           ORDER BY version DESC LIMIT 1`,
          [version.document_id, version.version]
        )
      ).rows[0] ?? null;
    const tenant = (await tx.query('SELECT settings FROM tenants WHERE id = $1', [job.tenantId])).rows[0];
    const bytes = await loadObject(tx, ctx.store, version.object_id);
    return { version, template, baseline, tenantSettings: tenant?.settings ?? {}, bytes };
  });
}

async function publishedTemplate(tx: Tx, documentTypeId: string): Promise<NonNullable<VersionContext['template']>> {
  const template = (
    await tx.query(
      `SELECT tv.id, tv.version, tv.definition FROM template_versions tv
       WHERE tv.document_type_id = $1 AND tv.status = 'published' ORDER BY tv.version DESC LIMIT 1`,
      [documentTypeId]
    )
  ).rows[0];
  if (!template) {
    throw new PermanentProcessingError(
      'No published template exists for this document type.',
      'Publish a template for this document type in Schema Studio, then retry.'
    );
  }
  return template;
}

/** The customer's published types, as the classifier sees them. */
async function typeCandidates(tx: Tx): Promise<Array<TypeCandidate & { id: string; layout?: LayoutFingerprint }>> {
  const { rows } = await tx.query(
    `SELECT DISTINCT ON (dt.id) dt.id, dt.key, dt.name, dt.description, tv.definition->'fields' AS fields, tv.definition->'layout' AS layout
     FROM document_types dt JOIN template_versions tv ON tv.document_type_id = dt.id AND tv.status = 'published'
     ORDER BY dt.id, tv.version DESC`
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    layout: r.layout ?? undefined,
    fields: ((r.fields ?? []) as Array<{ displayLabel?: string; semanticKey: string; extraction?: unknown }>)
      .filter((f) => f.extraction)
      .map((f) => f.displayLabel || f.semanticKey),
  }));
}

/**
 * Identify the type of a document submitted without one. Laya scores each of
 * the customer's published types; the choice is deterministic (`decideType`).
 * Unclear, or no classifier available: the document waits for a person
 * (`needs_type`) instead of being processed as a guess.
 */
async function identifyType(
  ctx: Ctx,
  job: ClaimedJob,
  context: VersionContext,
  parsed: ParsedDocument
): Promise<{ kind: 'identified'; typeId: string } | { kind: 'needs_type'; reason: string }> {
  const candidates = await withTenant(ctx.db, job.tenantId, (tx) => typeCandidates(tx));
  const record = async (classification: Record<string, unknown>, typeId: string | null, call?: ClassificationResult, source = 'detected') =>
    withTenant(ctx.db, job.tenantId, async (tx) => {
      if (call) {
        await tx.query(
          `INSERT INTO model_calls (tenant_id, document_version_id, job_id, purpose, provider, model, prompt_version, prompt, raw_response)
           VALUES ($1,$2,$3,'classification',$4,$5,$6,$7,$8)`,
          [job.tenantId, context.version.id, job.id, 'laya', call.model, call.promptVersion, call.prompt, call.rawResponse]
        );
      }
      await tx.query(
        `UPDATE documents SET document_type_id = $2, type_source = CASE WHEN $2::uuid IS NULL THEN 'pending' ELSE $4 END,
           classification = $3, updated_at = now() WHERE id = $1 AND document_type_id IS NULL`,
        [context.version.document_id, typeId, JSON.stringify(classification), source]
      );
      await audit(tx, {
        tenantId: job.tenantId, actor: SYSTEM, action: typeId ? 'document.type_detected' : 'document.type_unclear',
        subjectType: 'document', subjectId: context.version.document_id, detail: { versionId: context.version.id, ...classification },
      });
    });

  if (candidates.length === 0) {
    const reason = 'This customer has no published document types yet.';
    await record({ at: new Date().toISOString(), reason }, null);
    return { kind: 'needs_type', reason };
  }
  if (candidates.length === 1) {
    // Nothing to decide; no model call.
    await record({ at: new Date().toISOString(), reason: 'Only one document type is published.', typeKey: candidates[0].key }, candidates[0].id, undefined, 'only_type');
    return { kind: 'identified', typeId: candidates[0].id };
  }
  // A fixed-layout form is recognized by its printed text at known positions: deterministic, no model.
  const layouts = candidates
    .filter((c) => (c.layout?.anchors.length ?? 0) >= MIN_LAYOUT_ANCHORS)
    .map((c) => ({ c, ...layoutMatch(parsed, c.layout) }))
    .sort((a, b) => b.score - a.score);
  const [bestLayout, nextLayout] = layouts;
  if (bestLayout && bestLayout.score >= MIN_LAYOUT_SCORE && (!nextLayout || nextLayout.score < MIN_LAYOUT_SCORE)) {
    await record(
      {
        at: new Date().toISOString(), method: 'layout', typeKey: bestLayout.c.key,
        reason: `Printed layout matches ${bestLayout.c.key}: ${bestLayout.matched} of ${bestLayout.total} anchors in place.`,
        layoutScores: layouts.map((l) => ({ key: l.c.key, score: Number(l.score.toFixed(3)) })),
      },
      bestLayout.c.id, undefined, 'layout'
    );
    return { kind: 'identified', typeId: bestLayout.c.id };
  }

  // Kept when nothing is decided, so a person mapping the document sees the nearest fixed-layout forms first.
  const layoutScores = layouts.map((l) => ({ key: l.c.key, score: Number(l.score.toFixed(3)) }));
  const classifier = ctx.providers.classifier;
  const readiness = classifier ? await classifier.readiness() : { ready: false, detail: 'Laya is not enabled on this worker' };
  if (!classifier || !readiness.ready) {
    const reason = `Automatic identification is unavailable (${readiness.detail}).`;
    await record({ at: new Date().toISOString(), reason, layoutScores }, null);
    return { kind: 'needs_type', reason };
  }
  const result = await classifier.classify(parsed, candidates);
  const chosen = candidates.find((c) => c.key === result.typeKey) ?? null;
  await record(
    { at: new Date().toISOString(), provider: classifier.name, model: result.model, typeKey: result.typeKey, scores: result.scores, reason: result.reason, layoutScores },
    chosen?.id ?? null,
    result
  );
  return chosen ? { kind: 'identified', typeId: chosen.id } : { kind: 'needs_type', reason: result.reason };
}

async function priorStates(tx: Tx, baselineId: string): Promise<Map<string, PriorFieldState>> {
  const { rows } = await tx.query(
    `SELECT ev.id, ev.semantic_key, ev.evidence_fingerprint, ev.interpretation_hash, ev.normalized_value, ev.review_state,
            ev.disposition, ev.final_value, e.quote
     FROM extracted_values ev LEFT JOIN evidence e ON e.value_id = ev.id WHERE ev.document_version_id = $1`,
    [baselineId]
  );
  return new Map(
    rows.map((r) => {
      let decision: PriorFieldState['decision'] = null;
      if (r.review_state !== 'pending') {
        const kind = r.disposition === 'auto_approved' && r.review_state === 'approved' ? 'auto_approved' : r.final_value !== r.normalized_value ? 'corrected' : 'approved';
        decision = { kind, finalValue: r.final_value };
      }
      return [
        r.semantic_key,
        { valueId: r.id, fingerprint: r.evidence_fingerprint, interpretationHash: r.interpretation_hash, normalizedValue: r.normalized_value, quote: r.quote, decision },
      ];
    })
  );
}

async function latestDecisionId(tx: Tx, valueId: string): Promise<string | null> {
  const { rows } = await tx.query('SELECT id FROM review_decisions WHERE value_id = $1 ORDER BY created_at DESC LIMIT 1', [valueId]);
  return rows[0]?.id ?? null;
}

async function persistField(tx: Tx, job: ClaimedJob, versionId: string, pf: ProcessedField, prior: PriorFieldState | undefined) {
  const { field, extraction, validations, disposition } = pf;
  const carry = decideCarryOver(field, extraction, prior);
  let reviewState: 'pending' | 'approved' | 'corrected' | 'carried_over' = 'pending';
  let finalValue: string | null = null;
  if (carry.kind === 'carry_over') {
    reviewState = 'carried_over';
    finalValue = carry.finalValue;
  } else if (disposition === 'auto_approved') {
    reviewState = 'approved';
    finalValue = extraction.normalizedValue;
  }
  const threshold = field.reviewPolicy?.mode === 'threshold' ? (field.reviewPolicy.confidenceThreshold ?? 1) : null;
  const { rows } = await tx.query(
    `INSERT INTO extracted_values (tenant_id, document_version_id, semantic_key, label, field_type, required, method, value, normalized_value,
        gap_reason, unverified, confidence, confidence_source, confidence_threshold, model, prompt_version, interpretation_hash,
        evidence_fingerprint, disposition, review_state, final_value, carried_from_value_id, previous_value_id, change_reasons, job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
    [
      job.tenantId, versionId, field.semanticKey, field.displayLabel || field.semanticKey, field.type, Boolean(field.required), extraction.method,
      extraction.value, extraction.normalizedValue, extraction.gapReason, extraction.unverified ? JSON.stringify(extraction.unverified) : null,
      extraction.confidence, extraction.confidenceSource, threshold, extraction.model ?? null, extraction.promptVersion ?? null,
      interpretationHash(field), evidenceFingerprint(field, extraction), disposition, reviewState, finalValue,
      carry.kind === 'carry_over' ? carry.fromValueId : null,
      carry.kind === 'reopen' ? carry.fromValueId : null,
      carry.kind === 'reopen' ? JSON.stringify(carry.reasons) : null,
      job.id,
    ]
  );
  const valueId = rows[0].id as string;
  if (extraction.evidence) {
    const e = extraction.evidence;
    await tx.query(
      `INSERT INTO evidence (tenant_id, value_id, document_version_id, page, quote, start_offset, end_offset, box) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.tenantId, valueId, versionId, e.page, e.quote, e.start, e.end, e.box ? JSON.stringify(e.box) : null]
    );
  }
  for (const v of validations) {
    await tx.query(
      `INSERT INTO validation_results (tenant_id, value_id, document_version_id, rule_id, method, rule_version, outcome, explanation, model,
         prompt_version, confidence, confidence_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [job.tenantId, valueId, versionId, v.ruleId, v.method, v.ruleVersion, v.outcome, v.explanation, v.model ?? null, v.promptVersion ?? null, v.confidence ?? null, v.confidenceSource ?? null]
    );
  }
  const evidenceSnapshot = extraction.evidence ? JSON.stringify({ page: extraction.evidence.page, quote: extraction.evidence.quote }) : null;
  if (carry.kind === 'carry_over') {
    await tx.query(
      `INSERT INTO review_decisions (tenant_id, value_id, document_version_id, action, old_value, new_value, actor_kind, authority, evidence_snapshot, carried_from_decision_id)
       VALUES ($1,$2,$3,'carry_over',NULL,$4,'system',$5,$6,$7)`,
      [
        job.tenantId, valueId, versionId, finalValue,
        JSON.stringify({ policy: 'evidence_unchanged', fromValueId: carry.fromValueId, previousDecision: carry.decisionKind }),
        evidenceSnapshot, await latestDecisionId(tx, carry.fromValueId),
      ]
    );
  } else if (reviewState === 'approved') {
    await tx.query(
      `INSERT INTO review_decisions (tenant_id, value_id, document_version_id, action, old_value, new_value, actor_kind, authority, evidence_snapshot)
       VALUES ($1,$2,$3,'auto_approve',NULL,$4,'system',$5,$6)`,
      [
        job.tenantId, valueId, versionId, finalValue,
        JSON.stringify({ policy: 'review_threshold', threshold, confidence: extraction.confidence, confidenceSource: extraction.confidenceSource }),
        evidenceSnapshot,
      ]
    );
  }
}

async function detectSameTransaction(tx: Tx, tenantId: string, documentId: string, documentTypeId: string, template: TemplateDefinition, fields: ProcessedField[]) {
  const keys = template.identityKeys ?? [];
  if (!keys.length) return;
  const parts = keys.map((k) => fields.find((f) => f.field.semanticKey === k)?.extraction.normalizedValue);
  if (parts.some((p) => !p)) return;
  const businessKey = parts.map((p) => p!.toLowerCase()).join('|');
  await tx.query('UPDATE documents SET business_key = $2, updated_at = now() WHERE id = $1', [documentId, businessKey]);
  const others = await tx.query(
    `SELECT id FROM documents WHERE tenant_id = $1 AND document_type_id = $2 AND business_key = $3 AND id <> $4`,
    [tenantId, documentTypeId, businessKey, documentId]
  );
  for (const other of others.rows) {
    // Flag, never merge: a person decides whether two files describe one transaction.
    await tx.query(
      `INSERT INTO document_relations (tenant_id, document_id, related_document_id, kind, reason)
       VALUES ($1, $2, $3, 'possible_same_transaction', $4) ON CONFLICT DO NOTHING`,
      [tenantId, documentId, other.id, `Both documents carry the same ${keys.join(' + ')}.`]
    );
  }
}

/** The `process_version` job: parse → extract → verify → validate → carry over → persist. */
export async function processVersion(ctx: Ctx, job: ClaimedJob): Promise<'succeeded' | 'superseded' | 'failed'> {
  let versionId = job.subjectId;
  try {
    const context = await loadContext(ctx, job);
    if (!context) {
      await withTenant(ctx.db, job.tenantId, (tx) => completeJob(tx, job, 'superseded'));
      return 'superseded';
    }
    versionId = context.version.id;

    await setStage(ctx, job.tenantId, versionId, 'parsing');
    let parsed: ParsedDocument;
    try {
      parsed = await extractPdfText(context.bytes);
    } catch (error) {
      throw new PermanentProcessingError(`The file could not be read as a PDF (${(error as Error).message}).`, 'Ask the customer to send a valid PDF as a new version.');
    }
    await withTenant(ctx.db, job.tenantId, (tx) =>
      tx.query('UPDATE document_versions SET parsed_text = $2, parser = $3, page_count = $4 WHERE id = $1', [versionId, JSON.stringify(parsed.pages), parsed.parser, parsed.pageCount])
    );

    if (!context.template) {
      const identified = await identifyType(ctx, job, context, parsed);
      if (identified.kind === 'needs_type') {
        // Not a failure: the job did its work, and a person now chooses the type (documents.type.set re-queues it).
        return await withTenant(ctx.db, job.tenantId, async (tx) => {
          if (!(await holdsLease(tx, job))) return 'failed';
          await tx.query(
            `UPDATE document_versions SET processing_status = 'needs_type', status_changed_at = now(), failure_reason = $2,
               failure_action = 'Choose which kind of document this is; it is then processed automatically.'
             WHERE id = $1 AND processing_status <> 'superseded'`,
            [versionId, identified.reason]
          );
          await completeJob(tx, job, 'succeeded');
          return 'succeeded';
        });
      }
      context.version.document_type_id = identified.typeId;
      context.template = await withTenant(ctx.db, job.tenantId, (tx) => publishedTemplate(tx, identified.typeId));
    }
    const template = context.template;
    const definition = template.definition;
    const needs = {
      extraction: extractableFields(definition).some((f) => f.extraction?.method === 'llm'),
      semantic: definition.fields.some((f) => (f.validationRules ?? []).some((r) => r.kind === 'semantic')),
    };
    const selection = await selectProviders(ctx.providers, context.tenantSettings, needs);

    const processed = await processDocument(parsed, definition, {
      extractionProvider: selection.extraction,
      semanticValidator: selection.semantic,
      onStage: (stage) => setStage(ctx, job.tenantId, versionId, stage),
    });

    return await withTenant(ctx.db, job.tenantId, async (tx) => {
      if (!(await holdsLease(tx, job))) return 'failed'; // lease lost: another worker owns this job now; write nothing
      const current = (await tx.query('SELECT processing_status FROM document_versions WHERE id = $1 FOR UPDATE', [versionId])).rows[0];
      if (current.processing_status === 'superseded') {
        await completeJob(tx, job, 'superseded');
        return 'superseded';
      }
      const prior = context.baseline ? await priorStates(tx, context.baseline.id) : new Map<string, PriorFieldState>();
      for (const pf of processed.fields) await persistField(tx, job, versionId, pf, prior.get(pf.field.semanticKey));
      for (const call of processed.modelCalls) {
        await tx.query(
          `INSERT INTO model_calls (tenant_id, document_version_id, job_id, purpose, provider, model, prompt_version, prompt, raw_response)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [job.tenantId, versionId, job.id, call.purpose, call.provider, call.model, call.promptVersion, call.prompt, call.rawResponse]
        );
      }
      await detectSameTransaction(tx, job.tenantId, context.version.document_id, context.version.document_type_id!, definition, processed.fields);
      await tx.query(
        `UPDATE document_versions SET processing_status = 'processed', status_changed_at = now(), processed_at = now(),
           template_version_id = $2, baseline_version_id = $3, model_selection = $4, failure_reason = NULL, failure_action = NULL
         WHERE id = $1`,
        [versionId, template.id, context.baseline?.id ?? null, JSON.stringify({ notes: selection.notes, fallback: selection.fallbackUsed })]
      );
      await completeJob(tx, job, 'succeeded');
      await audit(tx, {
        tenantId: job.tenantId,
        actor: SYSTEM,
        action: 'document.processed',
        subjectType: 'document',
        subjectId: context.version.document_id,
        detail: {
          versionId,
          version: context.version.version,
          templateVersion: template.version,
          baselineVersion: context.baseline?.version ?? null,
          fields: processed.fields.length,
          gaps: processed.fields.filter((f) => f.disposition === 'gap').length,
          modelSelection: selection.notes,
          ...(selection.fallbackUsed ? { fallback: selection.fallbackUsed } : {}),
        },
      });
      return 'succeeded';
    });
  } catch (error) {
    const permanent = error instanceof PermanentProcessingError || error instanceof ProviderNotReadyError;
    const message = error instanceof Error ? error.message : String(error);
    const action = error instanceof PermanentProcessingError || error instanceof ProviderNotReadyError ? error.action : 'Lomi will retry automatically.';
    const documentId = await documentIdFor(ctx, job.tenantId, versionId);
    await withTenant(ctx.db, job.tenantId, async (tx) => {
      if (!(await holdsLease(tx, job))) return;
      const outcome = await failJob(tx, job, permanent ? 'permanent' : 'transient', message);
      const status = outcome.willRetry ? 'failed_retryable' : 'failed_operator';
      await tx.query(
        `UPDATE document_versions SET processing_status = $2, failure_reason = $3, failure_action = $4, status_changed_at = now()
         WHERE id = $1 AND processing_status <> 'superseded'`,
        [versionId, status, message, outcome.willRetry ? `Retrying automatically in ${outcome.retryInSeconds}s.` : permanent ? action : 'Retry from the operations console once the cause is resolved.']
      );
      await audit(tx, {
        tenantId: job.tenantId, actor: SYSTEM, action: 'document.processing_failed', subjectType: 'document', subjectId: documentId,
        detail: { versionId, jobId: job.id, attempt: job.attempt, permanent, willRetry: outcome.willRetry, reason: message },
      });
    });
    return 'failed';
  }
}
