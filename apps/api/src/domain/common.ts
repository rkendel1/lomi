import type { Config } from '../config';
import type { Db, Tx } from '../db/pool';
import type { ProviderRegistry } from '../llm/providers';
import type { ObjectStore } from '../storage/objectStore';

export interface Ctx {
  db: Db;
  store: ObjectStore;
  config: Config;
  providers: ProviderRegistry;
}

/** Who is acting. Agents carry the human they act for. */
export interface Actor {
  principalId: string | null;
  kind: 'user' | 'agent' | 'service' | 'system';
  displayName?: string;
  onBehalfOf?: string | null;
  capability?: string;
  requestId?: string;
}

export const SYSTEM: Actor = { principalId: null, kind: 'system', displayName: 'Lomi processing' };

export type DomainErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`);

export async function audit(
  tx: Tx,
  event: {
    tenantId: string | null;
    actor: Actor;
    action: string;
    subjectType: string;
    subjectId?: string | null;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor_principal_id, actor_kind, on_behalf_of, capability, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.tenantId,
      event.actor.principalId,
      event.actor.kind,
      event.actor.onBehalfOf ?? null,
      event.actor.capability ?? null,
      event.action,
      event.subjectType,
      event.subjectId ?? null,
      JSON.stringify({ ...(event.detail ?? {}), ...(event.actor.requestId ? { requestId: event.actor.requestId } : {}) }),
    ]
  );
}

export type JobKind = 'process_version' | 'generate_output';

/**
 * Create a durable job and its outbox event inside the caller's transaction.
 * If the transaction commits, the work exists in PostgreSQL whether or not
 * Redis is reachable; the dispatcher publishes it later.
 */
export async function enqueueJob(tx: Tx, tenantId: string, kind: JobKind, subjectId: string): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO jobs (tenant_id, kind, subject_id) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, kind, subjectId]
  );
  const jobId = rows[0].id as string;
  await tx.query(`INSERT INTO outbox (tenant_id, topic, job_id) VALUES ($1, $2, $3)`, [tenantId, kind, jobId]);
  return jobId;
}
