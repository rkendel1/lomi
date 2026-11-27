import { createHash, randomBytes } from 'node:crypto';
import { withSystem, withTenant, type Tx } from '../db/pool';
import { audit, DomainError, notFound, type Actor, type Ctx } from './common';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A tenant's short name: it is also the intake URL (/in/{slug}). Same rule as the database constraint. */
export const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Create a tenant with its tenant-URL ingress. Lomi-operator operation. */
export async function createTenant(ctx: Ctx, actor: Actor, raw: { slug: string; name: string; settings?: Record<string, unknown> }) {
  const input = { ...raw, slug: raw.slug.trim(), name: raw.name.trim() };
  if (!input.name) throw new DomainError('INVALID_INPUT', 'Enter the customer name.');
  if (!TENANT_SLUG.test(input.slug)) {
    throw new DomainError('INVALID_INPUT', `"${input.slug}" can't be a short name: use 2–63 lowercase letters, digits or hyphens, e.g. "acme-corp". It becomes the intake URL /in/<short name>.`);
  }
  return withSystem(ctx.db, async (tx) => {
    const exists = await tx.query('SELECT 1 FROM tenants WHERE slug = $1', [input.slug]);
    if (exists.rows.length) throw new DomainError('CONFLICT', `Tenant "${input.slug}" already exists.`);
    const { rows } = await tx.query('INSERT INTO tenants (slug, name, settings) VALUES ($1, $2, $3) RETURNING id', [
      input.slug, input.name, JSON.stringify(input.settings ?? {}),
    ]);
    const tenantId = rows[0].id as string;
    await tx.query(
      `INSERT INTO ingress_endpoints (tenant_id, key, kind, name) VALUES ($1, 'main', 'tenant_url', 'Tenant ingress URL')`,
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

/** The tenant's ingress: one URL that accepts API, single and bulk submissions. */
export async function ingressInfo(ctx: Ctx, tenantId: string) {
  return withTenant(ctx.db, tenantId, async (tx) => {
    const row = (
      await tx.query(
        `SELECT ie.enabled, dt.key AS default_type, t.slug FROM tenants t
         LEFT JOIN ingress_endpoints ie ON ie.tenant_id = t.id AND ie.key = 'main'
         LEFT JOIN document_types dt ON dt.id = ie.default_document_type_id WHERE t.id = $1`,
        [tenantId]
      )
    ).rows[0];
    if (!row) throw notFound('Tenant');
    const types = (
      await tx.query(
        `SELECT DISTINCT ON (dt.id) dt.key, dt.name, dt.description, tv.definition->'fields' AS fields
         FROM document_types dt JOIN template_versions tv ON tv.document_type_id = dt.id AND tv.status = 'published'
         WHERE dt.tenant_id = $1 ORDER BY dt.id, tv.version DESC`,
        [tenantId]
      )
    ).rows;
    return {
      tenant: row.slug as string,
      documentTypes: types
        .map((t) => ({
          key: t.key as string,
          name: t.name as string,
          description: (t.description as string | null) ?? null,
          fields: ((t.fields ?? []) as Array<{ displayLabel?: string; semanticKey: string; extraction?: unknown }>)
            .filter((f) => f.extraction)
            .map((f) => f.displayLabel || f.semanticKey),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      enabled: Boolean(row.enabled),
      defaultDocumentType: (row.default_type as string | null) ?? null,
      submissionPage: `/in/${row.slug}`,
      apiEndpoint: `/api/in/${row.slug}/documents`,
    };
  });
}

export async function configureIngress(ctx: Ctx, actor: Actor, input: { tenantId: string; defaultDocumentType?: string | null; enabled?: boolean }) {
  return withTenant(ctx.db, input.tenantId, async (tx) => {
    const typeId = input.defaultDocumentType
      ? (await tx.query('SELECT id FROM document_types WHERE tenant_id = $1 AND key = $2', [input.tenantId, input.defaultDocumentType])).rows[0]?.id
      : null;
    if (input.defaultDocumentType && !typeId) throw new DomainError('INVALID_INPUT', `Unknown document type "${input.defaultDocumentType}".`);
    await tx.query(
      `UPDATE ingress_endpoints SET default_document_type_id = CASE WHEN $2::boolean THEN $3::uuid ELSE default_document_type_id END,
              enabled = coalesce($4, enabled)
       WHERE tenant_id = $1 AND key = 'main'`,
      [input.tenantId, input.defaultDocumentType !== undefined, typeId, input.enabled ?? null]
    );
    await audit(tx, { tenantId: input.tenantId, actor, action: 'ingress.configured', subjectType: 'tenant', subjectId: input.tenantId, detail: input });
  }).then(() => ingressInfo(ctx, input.tenantId));
}

/** Roles a customer admin (or a Lomi operator) can give people. Agents are delegated separately. */
export const PERSON_ROLES = ['customer_admin', 'reviewer', 'viewer', 'submitter'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

/** People and agents with access to a tenant. */
export async function listMembers(ctx: Ctx, tenantId: string) {
  return withSystem(ctx.db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT m.principal_id, m.role, m.created_at, p.display_name, p.email, p.kind, dp.display_name AS delegated_by
       FROM memberships m JOIN principals p ON p.id = m.principal_id LEFT JOIN principals dp ON dp.id = m.delegated_by
       WHERE m.tenant_id = $1 ORDER BY p.kind DESC, p.display_name`,
      [tenantId]
    );
    return rows.map((r) => ({
      principalId: r.principal_id as string,
      name: r.display_name as string,
      email: (r.email as string | null) ?? null,
      kind: r.kind as string,
      role: r.role as string,
      delegatedBy: (r.delegated_by as string | null) ?? null,
      addedAt: (r.created_at as Date).toISOString(),
    }));
  });
}

async function adminCount(tx: Tx, tenantId: string): Promise<number> {
  return (await tx.query(`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'customer_admin'`, [tenantId])).rows[0].n;
}

function assertPersonRole(role: string): asserts role is PersonRole {
  if (!(PERSON_ROLES as readonly string[]).includes(role)) throw new DomainError('INVALID_INPUT', `Role must be one of: ${PERSON_ROLES.join(', ')}.`);
}

/**
 * Give a person access to the tenant. A new person gets a sign-in token, returned
 * once (only its hash is stored); someone who already has an identity keeps it.
 */
export async function addMember(ctx: Ctx, actor: Actor, input: { tenantId: string; name: string; email: string; role: string }) {
  assertPersonRole(input.role);
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name) throw new DomainError('INVALID_INPUT', "Enter the person's name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError('INVALID_INPUT', 'Enter a valid email address.');
  return withSystem(ctx.db, async (tx) => {
    const existing = (await tx.query('SELECT id, kind, is_lomi_operator FROM principals WHERE lower(email) = $1', [email])).rows[0];
    if (existing && (existing.kind !== 'user' || existing.is_lomi_operator)) throw new DomainError('CONFLICT', 'That email belongs to an identity that cannot be added here.');
    if (existing && (await tx.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND principal_id = $2', [input.tenantId, existing.id])).rows[0]) {
      throw new DomainError('CONFLICT', `${email} already has access; change their role instead.`);
    }
    const principalId = existing?.id ?? (await createPrincipal(tx, { kind: 'user', displayName: name, email }));
    await addMembership(tx, { tenantId: input.tenantId, principalId, role: input.role });
    const token = existing ? null : await issueToken(tx, principalId, `sign-in token issued by ${actor.displayName ?? 'an admin'}`);
    await audit(tx, { tenantId: input.tenantId, actor, action: 'member.added', subjectType: 'principal', subjectId: principalId, detail: { email, role: input.role, newIdentity: !existing } });
    return { principalId, name, email, role: input.role, signInToken: token };
  });
}

export async function changeMemberRole(ctx: Ctx, actor: Actor, input: { tenantId: string; principalId: string; role: string }) {
  assertPersonRole(input.role);
  return withSystem(ctx.db, async (tx) => {
    const m = (await tx.query('SELECT role FROM memberships WHERE tenant_id = $1 AND principal_id = $2 FOR UPDATE', [input.tenantId, input.principalId])).rows[0];
    if (!m) throw notFound('Member');
    if (m.role === 'agent') throw new DomainError('INVALID_INPUT', "An agent's access is delegated by a person; it has no role to change here.");
    if (m.role === 'customer_admin' && input.role !== 'customer_admin' && (await adminCount(tx, input.tenantId)) <= 1) {
      throw new DomainError('CONFLICT', 'This is the only admin. Make someone else an admin first.');
    }
    await tx.query('UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND principal_id = $2', [input.tenantId, input.principalId, input.role]);
    await audit(tx, { tenantId: input.tenantId, actor, action: 'member.role_changed', subjectType: 'principal', subjectId: input.principalId, detail: { from: m.role, to: input.role } });
    return { principalId: input.principalId, role: input.role };
  });
}

/** Remove access to this tenant. The identity and its history are kept. */
export async function removeMember(ctx: Ctx, actor: Actor, input: { tenantId: string; principalId: string }) {
  return withSystem(ctx.db, async (tx) => {
    const m = (await tx.query('SELECT role FROM memberships WHERE tenant_id = $1 AND principal_id = $2 FOR UPDATE', [input.tenantId, input.principalId])).rows[0];
    if (!m) throw notFound('Member');
    if (m.role === 'customer_admin' && (await adminCount(tx, input.tenantId)) <= 1) throw new DomainError('CONFLICT', 'This is the only admin. Make someone else an admin first.');
    // Agents acting for this person lose their delegation with them.
    const agents = await tx.query('DELETE FROM memberships WHERE tenant_id = $1 AND delegated_by = $2 RETURNING principal_id', [input.tenantId, input.principalId]);
    await tx.query('DELETE FROM memberships WHERE tenant_id = $1 AND principal_id = $2', [input.tenantId, input.principalId]);
    await audit(tx, {
      tenantId: input.tenantId, actor, action: 'member.removed', subjectType: 'principal', subjectId: input.principalId,
      detail: { role: m.role, delegatedAgentsRemoved: agents.rows.map((r) => r.principal_id) },
    });
    return { principalId: input.principalId, removed: true };
  });
}
