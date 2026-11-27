import type { Principal, Session } from '@appport/protocol';
import { withSystem, type Db } from '../db/pool';
import { hashToken } from '../domain/tenants';

/** Tenant-scoped permissions by membership role. */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  customer_admin: [
    'documents.read', 'documents.submit', 'documents.generate', 'documents.retry', 'reviews.decide', 'reviews.propose',
    'templates.read', 'provenance.read', 'operations.read', 'operations.retry', 'models.read', 'models.authorize', 'members.manage',
  ],
  reviewer: ['documents.read', 'documents.submit', 'documents.generate', 'documents.retry', 'reviews.decide', 'reviews.propose', 'templates.read', 'provenance.read'],
  viewer: ['documents.read', 'templates.read', 'provenance.read'],
  submitter: ['documents.submit', 'documents.read'],
  agent: [],
};

/**
 * The most an agent can ever hold, whatever it is delegated. Notably absent:
 * `reviews.decide` (agents propose; people decide) and anything Lomi-internal.
 */
export const AGENT_GRANTABLE = ['documents.read', 'documents.submit', 'templates.read', 'provenance.read', 'reviews.propose', 'operations.read'];

/** Lomi-internal permissions. Never granted through a tenant membership. */
export const LOMI_PERMISSIONS = ['lomi.tenants.manage', 'lomi.templates.write', 'lomi.templates.publish', 'lomi.ingress.manage', 'lomi.operations.read', 'lomi.operations.retry', 'lomi.models.configure'];

export interface MembershipClaim {
  tenantId: string;
  slug: string;
  role: string;
  /** Effective permissions in this tenant, computed at authentication. */
  permissions: string[];
  onBehalfOf: string | null;
}

export interface AuthenticatedIdentity {
  principal: Principal;
  session: Session;
  kind: 'user' | 'agent' | 'service';
  operator: boolean;
  memberships: MembershipClaim[];
}

export async function authenticateToken(db: Db, token: string | undefined, applicationId: string): Promise<AuthenticatedIdentity | null> {
  if (!token) return null;
  return withSystem(db, async (tx) => {
    const p = (
      await tx.query(
        `SELECT t.id AS token_id, p.id, p.kind, p.display_name, p.is_lomi_operator
         FROM api_tokens t JOIN principals p ON p.id = t.principal_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())`,
        [hashToken(token)]
      )
    ).rows[0];
    if (!p) return null;
    const rows = (
      await tx.query(
        `SELECT m.tenant_id, t.slug, m.role, m.scopes, m.delegated_by, dm.role AS delegator_role, dp.is_lomi_operator AS delegator_operator
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id AND t.status = 'active'
         LEFT JOIN memberships dm ON dm.tenant_id = m.tenant_id AND dm.principal_id = m.delegated_by
         LEFT JOIN principals dp ON dp.id = m.delegated_by
         WHERE m.principal_id = $1`,
        [p.id]
      )
    ).rows;
    const memberships: MembershipClaim[] = rows.map((m) => {
      let permissions = ROLE_PERMISSIONS[m.role] ?? [];
      if (m.role === 'agent') {
        const delegator = m.delegator_operator ? ['*'] : (ROLE_PERMISSIONS[m.delegator_role] ?? []);
        permissions = (m.scopes as string[]).filter((s) => AGENT_GRANTABLE.includes(s) && (delegator.includes('*') || delegator.includes(s)));
      }
      return { tenantId: m.tenant_id, slug: m.slug, role: m.role, permissions, onBehalfOf: m.delegated_by };
    });
    const kind = p.kind as AuthenticatedIdentity['kind'];
    const principal: Principal = {
      id: p.id,
      type: kind === 'agent' ? 'application' : kind === 'service' ? 'service' : 'user',
      displayName: p.display_name,
      attributes: { kind, operator: Boolean(p.is_lomi_operator) && kind === 'user' },
    };
    const session: Session = {
      id: `token:${p.token_id}`,
      principal,
      applicationId,
      createdAt: new Date().toISOString(),
      // Read by the authorizer; JSON only.
      attributes: { kind, operator: Boolean(p.is_lomi_operator) && kind === 'user', memberships } as unknown as Session['attributes'],
      // Session-wide permissions are only Lomi-internal ones; tenant permissions are resolved per request.
      permissions: p.is_lomi_operator && kind === 'user' ? LOMI_PERMISSIONS : [],
    };
    return { principal, session, kind, operator: Boolean(p.is_lomi_operator) && kind === 'user', memberships };
  });
}
