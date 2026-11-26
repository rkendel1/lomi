import { createHash, randomBytes } from 'node:crypto';
import { withSystem, withTenant, type Tx } from '../db/pool';
import { audit, DomainError, notFound, type Actor, type Ctx } from './common';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Create a tenant with its default portal and API ingress endpoints. Lomi-operator operation. */
export async function createTenant(ctx: Ctx, actor: Actor, input: { slug: string; name: string; settings?: Record<string, unknown> }) {
  return withSystem(ctx.db, async (tx) => {
    const exists = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug]);
    if (exists.rows.length) throw new DomainError('CONFLICT', `Tenant "${input.slug}" already exists.`);
    const { rows } = await tx.query('INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING id', [
      input.slug, input.name, JSON.stringify(input.settings ?? {}),
    ]);
    const tenantId = rows[0].id as string;
    await tx.query(
      `INSERT INTO ingress_endpoints (tenant_id, key, kind, name) VALUES ($1, 'portal', 'portal', 'Customer portal upload'), ($1, 'api', 'api', 'API upload')`,
      [tenantId]
    );
    await audit(tx, { tenantId, actor, action: 'tenant.created', subjectType: 'tenant', subjectId: tenantId, detail: { slug: input.slug } });
    return { id: tenantId, slug: input.slug, name: input.name };
  });
}

export async function listTenants(ctx: Ctx, input: { tenantIds: string[] | 'all' }) {
  return withSystem(ctx.db, async (tx) => {
    const { rows } =
      input.tenantIds === 'all'
        ? await tx.query('SELECT id, slug, name, status, settings, created_at FROM tenants ORDER BY name')
        : await tx.query('SELECT id, slug, name, status, settings, created_at FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY name', [input.tenantIds]);
    return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, status: r.status, models: r.settings?.models ?? {}, createdAt: r.created_at.toISOString() }));
  });
}

export async function resolveTenant(ctx: Ctx, ref: string): Promise<string> {
  return withSystem(ctx.db, async (tx) => {
    const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
    const { rows } = await tx.query(isUuid ? 'SELECT id FROM tenants WHERE id = $1' : 'SELECT id FROM tenants WHERE slug = $1', [ref]);
    if (!rows[0]) throw notFound('Tenant');
    return rows[0].id;
  });
}

/**
 * Update a tenant's model settings. External processing authorization is
 * recorded with who authorized it and when, and audited.
 */
export async function updateModelSettings(
  ctx: Ctx,
  actor: Actor,
  input: { tenantId: string; extraction?: string; semantic?: string; semanticFallback?: string; externalProcessingAllowed?: boolean }
) {
  return withSystem(ctx.db, async (tx) => {
    const current = (await tx.query('SELECT settings FROM tenants WHERE id = $1 FOR UPDATE', [input.tenantId])).rows[0];
    if (!current) throw notFound('Tenant');
    const models = { ...(current.settings?.models ?? {}) };
    for (const key of ['extraction', 'semantic', 'semanticFallback'] as const) if (input[key] !== undefined) models[key] = input[key];
    if (input.externalProcessingAllowed !== undefined) {
      models.externalProcessing = input.externalProcessingAllowed
        ? { allowed: true, authorizedBy: actor.principalId, authorizedAt: new Date().toISOString() }
        : { allowed: false };
    }
    await tx.query('UPDATE tenants SET settings = jsonb_set(settings, $2, $3::jsonb) WHERE id = $1', [input.tenantId, '{models}', JSON.stringify(models)]);
    await audit(tx, { tenantId: input.tenantId, actor, action: 'tenant.model_settings_changed', subjectType: 'tenant', subjectId: input.tenantId, detail: { models } });
    return models;
  });
}

export async function createPrincipal(
  tx: Tx,
  input: { kind: 'user' | 'agent' | 'service'; displayName: string; email?: string; isOperator?: boolean }
): Promise<string> {
  const { rows } = await tx.query('INSERT INTO principals (kind, display_name, email, is_lomi_operator) VALUES ($1, $2, $3, $4) RETURNING id', [
    input.kind, input.displayName, input.email ?? null, Boolean(input.isOperator),
  ]);
  return rows[0].id;
}

export async function addMembership(
  tx: Tx,
  input: { tenantId: string; principalId: string; role: string; delegatedBy?: string; scopes?: string[] }
): Promise<void> {
  await tx.query(
    `INSERT INTO memberships (tenant_id, principal_id, role, delegated_by, scopes) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, principal_id) DO UPDATE SET role = EXCLUDED.role, delegated_by = EXCLUDED.delegated_by, scopes = EXCLUDED.scopes`,
    [input.tenantId, input.principalId, input.role, input.delegatedBy ?? null, input.scopes ?? []]
  );
}

/** Issue an API token. Only its hash is stored; the token is returned once. */
export async function issueToken(tx: Tx, principalId: string, label: string, token = `lomi_${randomBytes(24).toString('hex')}`): Promise<string> {
  await tx.query('INSERT INTO api_tokens (principal_id, token_hash, label) VALUES ($1, $2, $3)', [principalId, hashToken(token), label]);
  return token;
}

export async function ingressList(ctx: Ctx, tenantId: string) {
  return withTenant(ctx.db, tenantId, async (tx) =>
    (await tx.query('SELECT key, kind, name, enabled FROM ingress_endpoints WHERE tenant_id = $1 ORDER BY key', [tenantId])).rows
  );
}

export async function configureIngress(ctx: Ctx, actor: Actor, input: { tenantId: string; key: string; kind: string; name: string; documentType?: string; enabled?: boolean }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const typeId = input.documentType
      ? (await tx.query('SELECT id FROM document_types WHERE tenant_id = $1 AND key = $2', [input.tenantId, input.documentType])).rows[0]?.id
      : null;
    if (input.documentType && !typeId) throw new DomainError('INVALID_INPUT', `Unknown document type "${input.documentType}".`);
    await tx.query(
      `INSERT INTO ingress_endpoints (tenant_id, key, kind, name, default_document_type_id, enabled) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, key) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name,
         default_document_type_id = EXCLUDED.default_document_type_id, enabled = EXCLUDED.enabled`,
      [input.tenantId, input.key, input.kind, input.name, typeId, input.enabled ?? true]
    );
    await audit(tx, { tenantId: input.tenantId, actor, action: 'ingress.configured', subjectType: 'tenant', subjectId: input.tenantId, detail: input });
    return { key: input.key, enabled: input.enabled ?? true };
  });
}
