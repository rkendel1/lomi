import { stableHash, type TemplateDefinition } from '@lomi/docops';
import { extractPdfText } from '@lomi/pdf/text';
import { withTenant } from '../db/pool';
import { loadObject, sha256Hex, storeObject } from '../storage/objectStore';
import { audit, DomainError, notFound, type Actor, type Ctx } from './common';

/** Structural checks on a template definition before it can be saved. */
export function validateDefinition(definition: TemplateDefinition): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const f of definition.fields ?? []) {
    if (!f.semanticKey || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/.test(f.semanticKey)) problems.push(`"${f.semanticKey}" is not a valid semantic key (e.g. invoice.total_amount).`);
    if (keys.has(f.semanticKey)) problems.push(`Semantic key "${f.semanticKey}" is used twice.`);
    keys.add(f.semanticKey);
    if (f.extraction?.method === 'pattern') {
      try {
        new RegExp(f.extraction.pattern ?? '');
      } catch {
        problems.push(`${f.semanticKey}: extraction pattern is not a valid regular expression.`);
      }
      if (!f.extraction.pattern) problems.push(`${f.semanticKey}: pattern extraction needs a pattern.`);
    }
    for (const rule of f.validationRules ?? []) {
      if (rule.kind === 'semantic' && rule.decision?.type === 'choice' && !rule.decision.accept.every((a) => rule.decision?.type === 'choice' && rule.decision.options.includes(a))) {
        problems.push(`${f.semanticKey}: accepted choices must be among the options.`);
      }
    }
  }
  for (const rule of definition.crossFieldRules ?? []) {
    const refs = rule.kind === 'sum' ? [...rule.terms, rule.equals] : [rule.earlier, rule.later];
    for (const r of refs) if (!keys.has(r)) problems.push(`Cross-field rule "${rule.id}" refers to unknown field "${r}".`);
  }
  for (const k of definition.identityKeys ?? []) if (!keys.has(k)) problems.push(`Identity key "${k}" is not a field.`);
  return problems;
}

export async function createDocumentType(ctx: Ctx, actor: Actor, input: { tenantId: string; key: string; name: string; description?: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const { rows } = await tx.query(
      'INSERT INTO document_types (tenant_id, key, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING id',
      [input.tenantId, input.key, input.name, input.description ?? null]
    );
    if (!rows[0]) throw new DomainError('CONFLICT', `Document type "${input.key}" already exists.`);
    await audit(tx, { tenantId: input.tenantId, actor, action: 'document_type.created', subjectType: 'document_type', subjectId: rows[0].id, detail: { key: input.key } });
    return { id: rows[0].id as string, key: input.key, name: input.name };
  });
}

/** Store an immutable, versioned base PDF. Uploading identical bytes again returns the existing version. */
export async function uploadBasePdf(ctx: Ctx, actor: Actor, input: { tenantId: string; documentType: string; filename: string; bytes: Uint8Array }) {
  if (Buffer.from(input.bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new DomainError('INVALID_INPUT', 'The base file is not a PDF.');
  const parsed = await extractPdfText(input.bytes).catch(() => {
    throw new DomainError('INVALID_INPUT', 'The base PDF could not be parsed.');
  });
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const type = (await tx.query('SELECT id FROM document_types WHERE tenant_id = $1 AND key = $2', [input.tenantId, input.documentType])).rows[0];
    if (!type) throw notFound('Document type');
    const sha = sha256Hex(input.bytes);
    const existing = (await tx.query('SELECT id, version FROM base_pdfs WHERE document_type_id = $1 AND sha256 = $2', [type.id, sha])).rows[0];
    if (existing) return { id: existing.id as string, version: existing.version as number, sha256: sha, existing: true };
    const object = await storeObject(tx, ctx.store, input.tenantId, input.bytes, 'application/pdf');
    const next = (await tx.query('SELECT coalesce(max(version), 0) + 1 AS v FROM base_pdfs WHERE document_type_id = $1', [type.id])).rows[0].v;
    const { rows } = await tx.query(
      `INSERT INTO base_pdfs (tenant_id, document_type_id, version, object_id, sha256, filename, page_count, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.tenantId, type.id, next, object.id, sha, input.filename, parsed.pageCount, actor.principalId]
    );
    await audit(tx, { tenantId: input.tenantId, actor, action: 'base_pdf.uploaded', subjectType: 'document_type', subjectId: type.id, detail: { version: next, sha256: sha } });
    return { id: rows[0].id as string, version: next as number, sha256: sha, existing: false };
  });
}

/** Save a draft: updates the open draft if there is one, otherwise starts a new version. Published versions are never edited. */
export async function saveDraft(ctx: Ctx, actor: Actor, input: { tenantId: string; documentType: string; definition: TemplateDefinition; basePdfId?: string; notes?: string }) {
  const problems = validateDefinition(input.definition);
  if (problems.length) throw new DomainError('INVALID_INPUT', 'The template definition has problems.', { problems });
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const type = (await tx.query('SELECT id FROM document_types WHERE tenant_id = $1 AND key = $2 FOR UPDATE', [input.tenantId, input.documentType])).rows[0];
    if (!type) throw notFound('Document type');
    const hash = stableHash(input.definition);
    const draft = (await tx.query(`SELECT id, version FROM template_versions WHERE document_type_id = $1 AND status = 'draft'`, [type.id])).rows[0];
    let id: string;
    let version: number;
    if (draft) {
      await tx.query('UPDATE template_versions SET definition = $2, definition_hash = $3, base_pdf_id = coalesce($4, base_pdf_id), notes = $5 WHERE id = $1', [
        draft.id, JSON.stringify(input.definition), hash, input.basePdfId ?? null, input.notes ?? null,
      ]);
      id = draft.id;
      version = draft.version;
    } else {
      const prev = (await tx.query('SELECT coalesce(max(version), 0) AS v, (array_agg(base_pdf_id ORDER BY version DESC))[1] AS base FROM template_versions WHERE document_type_id = $1', [type.id])).rows[0];
      version = prev.v + 1;
      const { rows } = await tx.query(
        `INSERT INTO template_versions (tenant_id, document_type_id, version, definition, definition_hash, base_pdf_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.tenantId, type.id, version, JSON.stringify(input.definition), hash, input.basePdfId ?? prev.base ?? null, input.notes ?? null, actor.principalId]
      );
      id = rows[0].id;
    }
    await audit(tx, { tenantId: input.tenantId, actor, action: 'template.draft_saved', subjectType: 'template_version', subjectId: id, detail: { documentType: input.documentType, version, definitionHash: hash } });
    return { id, version, status: 'draft', definitionHash: hash };
  });
}

export async function publishTemplate(ctx: Ctx, actor: Actor, input: { tenantId: string; templateVersionId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const tv = (await tx.query('SELECT id, version, status, base_pdf_id, document_type_id, definition FROM template_versions WHERE id = $1 FOR UPDATE', [input.templateVersionId])).rows[0];
    if (!tv) throw notFound('Template version');
    if (tv.status !== 'draft') throw new DomainError('CONFLICT', `Version ${tv.version} is already ${tv.status}.`);
    const problems = validateDefinition(tv.definition);
    if (problems.length) throw new DomainError('INVALID_INPUT', 'The template definition has problems.', { problems });
    await tx.query(`UPDATE template_versions SET status = 'published', published_at = now(), published_by = $2 WHERE id = $1`, [tv.id, actor.principalId]);
    await audit(tx, { tenantId: input.tenantId, actor, action: 'template.published', subjectType: 'template_version', subjectId: tv.id, detail: { version: tv.version } });
    return { id: tv.id as string, version: tv.version as number, status: 'published' };
  });
}

export async function listTemplates(ctx: Ctx, input: { tenantId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const types = (await tx.query('SELECT id, key, name, description FROM document_types WHERE tenant_id = $1 ORDER BY name', [input.tenantId])).rows;
    const versions = (
      await tx.query(
        `SELECT tv.id, tv.document_type_id, tv.version, tv.status, tv.definition_hash, tv.published_at, tv.created_at, bp.version AS base_version, bp.sha256 AS base_sha,
                jsonb_array_length(tv.definition->'fields') AS field_count
         FROM template_versions tv LEFT JOIN base_pdfs bp ON bp.id = tv.base_pdf_id WHERE tv.tenant_id = $1 ORDER BY tv.version DESC`,
        [input.tenantId]
      )
    ).rows;
    return types.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      versions: versions
        .filter((v) => v.document_type_id === t.id)
        .map((v) => ({ id: v.id, version: v.version, status: v.status, fieldCount: v.field_count, basePdfVersion: v.base_version, basePdfSha256: v.base_sha, definitionHash: v.definition_hash, publishedAt: v.published_at?.toISOString() ?? null })),
    }));
  });
}

export async function getTemplate(ctx: Ctx, input: { tenantId: string; templateVersionId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const tv = (
      await tx.query(
        `SELECT tv.*, dt.key AS type_key, bp.filename AS base_filename, bp.sha256 AS base_sha, bp.version AS base_version
         FROM template_versions tv JOIN document_types dt ON dt.id = tv.document_type_id LEFT JOIN base_pdfs bp ON bp.id = tv.base_pdf_id WHERE tv.id = $1`,
        [input.templateVersionId]
      )
    ).rows[0];
    if (!tv) throw notFound('Template version');
    return {
      id: tv.id as string, documentType: tv.type_key as string, version: tv.version as number, status: tv.status as string,
      definition: tv.definition as TemplateDefinition, definitionHash: tv.definition_hash as string,
      basePdf: tv.base_pdf_id ? { id: tv.base_pdf_id as string, filename: tv.base_filename, sha256: tv.base_sha, version: tv.base_version } : null,
    };
  });
}

export async function basePdfFile(ctx: Ctx, input: { tenantId: string; basePdfId: string }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const b = (await tx.query('SELECT object_id, filename FROM base_pdfs WHERE id = $1', [input.basePdfId])).rows[0];
    if (!b) throw notFound('Base PDF');
    return { filename: b.filename as string, bytes: await loadObject(tx, ctx.store, b.object_id) };
  });
}
