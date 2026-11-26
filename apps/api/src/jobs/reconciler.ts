import { withSystem, type Db } from '../db/pool';

export interface ReconcileResult {
  expiredLeases: number;
  republished: number;
  exhausted: number;
}

/**
 * Recover outstanding work from PostgreSQL alone, so nothing depends on Redis
 * still holding a message:
 *
 * - A running job whose lease expired (worker crashed or hung) gets a new
 *   outbox event; the next claim marks the old attempt abandoned. If it has
 *   used all its attempts it is failed for an operator instead.
 * - A queued or retry-waiting job that is due, but whose last outbox event was
 *   published more than `staleSeconds` ago without the job being claimed, is
 *   republished. This covers Redis restarts, FLUSHALL and lost deliveries.
 *   Duplicates are harmless: claiming is idempotent.
 */
export async function reconcile(db: Db, options: { staleSeconds?: number } = {}): Promise<ReconcileResult> {
  const stale = options.staleSeconds ?? 60;
  return withSystem(db, async (tx) => {
    const exhausted = await tx.query(
      `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now(),
              last_error = 'Worker stopped responding on the final attempt'
       WHERE status = 'running' AND lease_expires_at < now() AND attempts >= max_attempts
       RETURNING id, kind, subject_id`
    );
    for (const job of exhausted.rows) {
      await tx.query(`UPDATE job_attempts SET outcome = 'abandoned', finished_at = now(), error = 'Lease expired' WHERE job_id = $1 AND finished_at IS NULL`, [job.id]);
      if (job.kind === 'process_version') {
        await tx.query(
          `UPDATE document_versions SET processing_status = 'failed_operator', status_changed_at = now(),
             failure_reason = 'Processing stopped responding repeatedly.', failure_action = 'Retry from the operations console.'
           WHERE id = $1 AND processing_status NOT IN ('processed', 'superseded')`,
          [job.subject_id]
        );
      }
    }

    const expired = await tx.query(
      `INSERT INTO outbox (tenant_id, topic, job_id)
       SELECT j.tenant_id, j.kind, j.id FROM jobs j
       WHERE j.status = 'running' AND j.lease_expires_at < now() AND j.attempts < j.max_attempts
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id AND o.published_at IS NULL)
       RETURNING job_id`
    );

    const republished = await tx.query(
      `INSERT INTO outbox (tenant_id, topic, job_id)
       SELECT j.tenant_id, j.kind, j.id FROM jobs j
       WHERE j.status IN ('queued', 'retry_wait') AND j.available_at <= now()
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id AND o.published_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.job_id = j.id AND o.published_at > now() - make_interval(secs => $1))
       RETURNING job_id`,
      [stale]
    );
    return { expiredLeases: expired.rowCount ?? 0, republished: republished.rowCount ?? 0, exhausted: exhausted.rowCount ?? 0 };
  });
}
