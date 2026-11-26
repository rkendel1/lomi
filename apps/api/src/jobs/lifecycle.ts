import type { Db, Tx } from '../db/pool';
import { withTenant } from '../db/pool';

export interface ClaimedJob {
  id: string;
  tenantId: string;
  kind: 'process_version' | 'generate_output';
  subjectId: string;
  attempt: number;
  maxAttempts: number;
  workerId: string;
}

/**
 * Claim a job with a lease. Exactly one worker can hold a job; a duplicate
 * delivery (BullMQ redelivery, a republished outbox event, a second worker)
 * finds nothing to claim and is acknowledged without doing any work. An
 * expired lease (crashed worker) can be re-claimed.
 */
export async function claimJob(db: Db, tenantId: string, jobId: string, workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
       WHERE id = $1 AND tenant_id = $4
         AND ((status IN ('queued', 'retry_wait') AND available_at <= now())
              OR (status = 'running' AND lease_expires_at < now()))
       RETURNING id, tenant_id, kind, subject_id, attempts, max_attempts`,
      [jobId, workerId, leaseSeconds, tenantId]
    );
    const job = rows[0];
    if (!job) return null;
    // A previous attempt that never finished was abandoned (worker crash or lost lease).
    await tx.query(
      `UPDATE job_attempts SET outcome = 'abandoned', finished_at = now(), error = 'Lease expired before completion'
       WHERE job_id = $1 AND finished_at IS NULL`,
      [jobId]
    );
    await tx.query(`INSERT INTO job_attempts (tenant_id, job_id, attempt, worker_id) VALUES ($1, $2, $3, $4)`, [
      tenantId,
      jobId,
      job.attempts,
      workerId,
    ]);
    return {
      id: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      subjectId: job.subject_id,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      workerId,
    };
  });
}

/** Still the lease holder? Used inside the final commit so a worker that lost its lease writes nothing. */
export async function holdsLease(tx: Tx, job: ClaimedJob): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'running' AND lease_owner = $2 FOR UPDATE`, [
    job.id,
    job.workerId,
  ]);
  return rows.length > 0;
}

export async function completeJob(tx: Tx, job: ClaimedJob, outcome: 'succeeded' | 'superseded'): Promise<void> {
  await tx.query(
    `UPDATE jobs SET status = $2, lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now(), last_error = NULL
     WHERE id = $1`,
    [job.id, outcome]
  );
  await tx.query(`UPDATE job_attempts SET outcome = $3, finished_at = now() WHERE job_id = $1 AND attempt = $2`, [job.id, job.attempt, outcome]);
}

export type FailureKind = 'transient' | 'permanent';

export function backoffSeconds(attempt: number): number {
  return Math.min(300, 5 * 2 ** (attempt - 1));
}

/**
 * Record a failed attempt. Transient failures are rescheduled through a new
 * outbox event (so they survive Redis loss) until attempts run out; permanent
 * failures (configuration, unreadable input) stop immediately for an operator.
 */
export async function failJob(
  tx: Tx,
  job: ClaimedJob,
  kind: FailureKind,
  message: string
): Promise<{ willRetry: boolean; retryInSeconds: number | null }> {
  await tx.query(`UPDATE job_attempts SET outcome = 'failed', finished_at = now(), error = $3 WHERE job_id = $1 AND attempt = $2`, [
    job.id,
    job.attempt,
    message,
  ]);
  const willRetry = kind === 'transient' && job.attempt < job.maxAttempts;
  if (willRetry) {
    const delay = backoffSeconds(job.attempt);
    await tx.query(
      `UPDATE jobs SET status = 'retry_wait', lease_owner = NULL, lease_expires_at = NULL, last_error = $2,
              available_at = now() + make_interval(secs => $3), updated_at = now()
       WHERE id = $1`,
      [job.id, message, delay]
    );
    await tx.query(
      `INSERT INTO outbox (tenant_id, topic, job_id, available_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [job.tenantId, job.kind, job.id, delay]
    );
    return { willRetry, retryInSeconds: delay };
  }
  await tx.query(
    `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error = $2, completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [job.id, message]
  );
  return { willRetry: false, retryInSeconds: null };
}

/** Operator retry of a failed job: grants fresh attempts and republishes through the outbox. */
export async function requeueJob(tx: Tx, jobId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE jobs SET status = 'queued', max_attempts = attempts + 3, available_at = now(), last_error = NULL, completed_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING tenant_id, kind`,
    [jobId]
  );
  if (!rows[0]) return false;
  await tx.query(`INSERT INTO outbox (tenant_id, topic, job_id) VALUES ($1, $2, $3)`, [rows[0].tenant_id, rows[0].kind, jobId]);
  return true;
}
