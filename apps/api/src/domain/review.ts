import { normalizeValue } from '@lomi/docops';
import type { FieldType } from '@lomi/core';
import { withTenant } from '../db/pool';
import { audit, DomainError, notFound, type Actor, type Ctx } from './common';
import { progressFor } from './documents';

/**
 * Approve or correct one value. Human decisions only: agents propose instead
 * (see `proposeCorrection`). Every decision is a new append-only row that
 * keeps the old value, the new value, the evidence shown, and the authority.
 */
export async function reviewValue(
  ctx: Ctx,
  actor: Actor,
  input: { tenantId: string; valueId: string; action: 'approve' | 'correct'; value?: string | null; note?: string; proposalId?: string; authority?: Record<string, unknown> }
) {
  if (actor.kind !== 'user') throw new DomainError('FORBIDDEN', 'Only a person can approve or correct a value. Agents may propose corrections.');
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const v = (
      await tx.query(
        `SELECT ev.*, d.current_version_id, d.id AS document_id, dv.processing_status, e.page, e.quote
         FROM extracted_values ev JOIN document_versions dv ON dv.id = ev.document_version_id JOIN documents d ON d.id = dv.document_id
         LEFT JOIN evidence e ON e.value_id = ev.id WHERE ev.id = $1 FOR UPDATE OF ev`,
        [input.valueId]
      )
    ).rows[0];
    if (!v) throw notFound('Value');
    if (v.current_version_id !== v.document_version_id) throw new DomainError('CONFLICT', 'This value belongs to an older version of the document; review the current version.');

    const oldValue = (v.final_value ?? v.normalized_value) as string | null;
    let newValue: string | null;
    if (input.action === 'approve') {
      if (v.disposition === 'gap' && v.review_state === 'pending' && v.required) {
        throw new DomainError('CONFLICT', 'A required value is missing; provide it with a correction instead.');
      }
      newValue = oldValue;
    } else {
      const raw = (input.value ?? '').trim();
      if (!raw) {
        if (v.required) throw new DomainError('INVALID_INPUT', 'This field is required; a correction needs a value.');
        newValue = null;
      } else {
        newValue = normalizeValue({ type: v.field_type as FieldType }, raw);
        if (newValue === null) throw new DomainError('INVALID_INPUT', `"${raw}" is not a valid ${v.field_type}.`);
      }
    }
    const authority = { basis: 'human_review', principalId: actor.principalId, ...(input.proposalId ? { acceptedProposalId: input.proposalId } : {}), ...(input.authority ?? {}) };
    const decision = await tx.query(
      `INSERT INTO review_decisions (tenant_id, value_id, document_version_id, action, old_value, new_value, note, actor_principal_id, actor_kind, authority, evidence_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9,$10) RETURNING id, created_at`,
      [
        input.tenantId, v.id, v.document_version_id, input.action, oldValue, newValue, input.note ?? null, actor.principalId,
        JSON.stringify(authority), v.quote ? JSON.stringify({ page: v.page, quote: v.quote }) : null,
      ]
    );
    await tx.query(`UPDATE extracted_values SET review_state = $2, final_value = $3, updated_at = now() WHERE id = $1`, [
      v.id, input.action === 'approve' ? 'approved' : 'corrected', newValue,
    ]);
    if (input.proposalId) {
      await tx.query(`UPDATE review_proposals SET status = 'accepted', resolved_decision_id = $2 WHERE id = $1 AND value_id = $3`, [input.proposalId, decision.rows[0].id, v.id]);
    }
    await tx.query('UPDATE documents SET updated_at = now() WHERE id = $1', [v.document_id]);
    await audit(tx, {
      tenantId: input.tenantId, actor, action: `value.${input.action === 'approve' ? 'approved' : 'corrected'}`, subjectType: 'document', subjectId: v.document_id,
      detail: { valueId: v.id, semanticKey: v.semantic_key, oldValue, newValue, note: input.note ?? null },
    });
    return {
      valueId: v.id as string,
      decisionId: decision.rows[0].id as string,
      state: input.action === 'approve' ? 'approved' : 'corrected',
      oldValue,
      newValue,
      progress: await progressFor(tx, v.document_version_id),
    };
  });
}

/** An agent's suggested correction. It changes nothing until a person accepts it. */
export async function proposeCorrection(ctx: Ctx, actor: Actor, input: { tenantId: string; valueId: string; value: string | null; rationale: string }) {
  if (actor.kind !== 'agent' && actor.kind !== 'user') throw new DomainError('FORBIDDEN', 'Unsupported actor.');
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const v = (await tx.query('SELECT ev.id, dv.document_id FROM extracted_values ev JOIN document_versions dv ON dv.id = ev.document_version_id WHERE ev.id = $1', [input.valueId])).rows[0];
    if (!v) throw notFound('Value');
    const { rows } = await tx.query(
      `INSERT INTO review_proposals (tenant_id, value_id, proposed_value, rationale, proposed_by, on_behalf_of) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.tenantId, input.valueId, input.value, input.rationale, actor.principalId, actor.onBehalfOf ?? null]
    );
    await audit(tx, {
      tenantId: input.tenantId, actor, action: 'value.correction_proposed', subjectType: 'document', subjectId: v.document_id,
      detail: { valueId: input.valueId, proposalId: rows[0].id, proposedValue: input.value, rationale: input.rationale },
    });
    return { proposalId: rows[0].id as string, status: 'open', requiresHumanApproval: true };
  });
}
