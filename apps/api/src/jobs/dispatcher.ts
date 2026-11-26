import type { Queue } from 'bullmq';
import { withSystem, type Db } from '../db/pool';

export interface JobMessage {
  jobId: string;
  tenantId: string;
}

/**
 * Publish due outbox events to Redis. Each event is locked (SKIP LOCKED, so
 * several dispatchers can run), sent, then marked published in the same
 * PostgreSQL transaction. PostgreSQL and Redis do not share a transaction: if
 * Redis accepts the job but the commit fails, the event is sent again later,
 * which is safe because workers claim jobs idempotently. If Redis is down, the
 * event stays unpublished and is retried on the next pass.
 */
export async function dispatchOutbox(db: Db, queue: Queue<JobMessage>, batchSize = 50): Promise<{ published: number; failed: number }> {
  return withSystem(db, async (tx) => {
    const { rows } = await tx.query(
      `SELECT o.id, o.tenant_id, o.topic, o.job_id FROM outbox o
       WHERE o.published_at IS NULL AND o.available_at <= now()
       ORDER BY o.available_at, o.created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // The outbox id is the BullMQ job id, so re-sending the same event while it is still in Redis is a no-op.
        await queue.add(row.topic, { jobId: row.job_id, tenantId: row.tenant_id }, { jobId: row.id, removeOnComplete: 1000, removeOnFail: 1000 });
        await tx.query('UPDATE outbox SET published_at = now(), publish_count = publish_count + 1, last_error = NULL WHERE id = $1', [row.id]);
        published++;
      } catch (error) {
        await tx.query('UPDATE outbox SET publish_count = publish_count + 1, last_error = $2 WHERE id = $1', [row.id, (error as Error).message]);
        failed++;
      }
    }
    return { published, failed };
  });
}
