import { afterEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { getDocument, getProgress, submitDocument } from '../../domain/documents';
import { reviewValue } from '../../domain/review';
import { dispatchOutbox, type JobMessage } from '../../jobs/dispatcher';
import { claimJob } from '../../jobs/lifecycle';
import { startWorker, type WorkerHandles } from '../../jobs/queue';
import { reconcile } from '../../jobs/reconciler';
import { runJob } from '../../jobs/runner';
import type { Ctx } from '../../domain/common';
import { INVOICE_V1, invoicePdf } from '../../seed/fixtures';
import { drain, OPERATOR, q, seedTemplate, setup } from './harness';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
let handles: WorkerHandles | null = null;
afterEach(async () => {
  await handles?.stop();
  handles = null;
});

async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function redisCtx(): Promise<Ctx> {
  const ctx = await setup();
  ctx.config = { ...ctx.config, redisUrl: REDIS_URL, queuePrefix: `lomi-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  return ctx;
}

async function submit(ctx: Ctx, tenantId: string) {
  return submitDocument(ctx, OPERATOR, { tenantId, documentTypeKey: 'invoice', filename: 'inv.pdf', bytes: await invoicePdf(INVOICE_V1) });
}

const processed = (ctx: Ctx, tenantId: string, documentId: string) => async () =>
  (await getProgress(ctx, { tenantId, documentId })).status === 'awaiting_review';

describe('durability (PostgreSQL + real Redis/BullMQ)', () => {
  it('processes through outbox → Redis → worker end to end', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    handles = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000 });
    const sub = await submit(ctx, tenantId);
    await until(processed(ctx, tenantId, sub.documentId));
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM extracted_values')).toEqual([{ n: 9 }]);
  });

  it('recovers outstanding work after Redis loses its data (FLUSHDB) and keeps review decisions', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    // A reviewed document exists before the outage.
    const reviewed = await submit(ctx, tenantId);
    await drain(ctx);
    const firstValue = (await getDocument(ctx, { tenantId, documentId: reviewed.documentId })).values[0];
    await reviewValue(ctx, OPERATOR, { tenantId, valueId: firstValue.id, action: 'approve' });

    // A second document is published to Redis, but no worker is running.
    const other = await submitDocument(ctx, OPERATOR, {
      tenantId, documentTypeKey: 'invoice', filename: 'inv2.pdf', bytes: await invoicePdf({ ...INVOICE_V1, number: 'INV-2026-0148' }),
    });
    const { createQueue } = await import('../../jobs/queue');
    const queue = createQueue(ctx);
    expect(await dispatchOutbox(ctx.db, queue)).toEqual({ published: 1, failed: 0 });
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });

    const redis = new Redis(REDIS_URL);
    await redis.flushdb();
    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
    await queue.close();

    handles = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000, staleSeconds: 0 });
    // Nothing arrives by itself: the message is gone. Recovery comes from PostgreSQL.
    await new Promise((r) => setTimeout(r, 500));
    expect((await getProgress(ctx, { tenantId, documentId: other.documentId })).status).toBe('queued');
    expect(await reconcile(ctx.db, { staleSeconds: 0 })).toMatchObject({ republished: 1 });
    await until(processed(ctx, tenantId, other.documentId));

    expect((await getDocument(ctx, { tenantId, documentId: reviewed.documentId })).values[0]).toMatchObject({ state: 'approved' });
    expect(await q(ctx, `SELECT count(*)::int AS n FROM review_decisions WHERE action = 'approve'`)).toEqual([{ n: 1 }]);
    await redis.quit();
  });

  it('recovers a job whose worker crashed after claiming it, without duplicating results', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submit(ctx, tenantId);
    const [job] = await q(ctx, 'SELECT id FROM jobs');
    // Simulated crash: a worker claims the job (short lease), marks it parsing, then dies.
    expect(await claimJob(ctx.db, tenantId, job.id, 'crashed-worker', 1)).not.toBeNull();
    await q(ctx, `UPDATE document_versions SET processing_status = 'parsing'`);
    await q(ctx, `UPDATE outbox SET published_at = now()`);
    // While the lease is live, nobody else can take the job.
    expect(await runJob(ctx, { jobId: job.id, tenantId })).toBe('skipped');
    await new Promise((r) => setTimeout(r, 1200));

    expect(await reconcile(ctx.db)).toMatchObject({ expiredLeases: 1 });
    handles = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000 });
    await until(processed(ctx, tenantId, sub.documentId));
    expect(await q(ctx, 'SELECT attempt, worker_id, outcome FROM job_attempts ORDER BY attempt')).toEqual([
      { attempt: 1, worker_id: 'crashed-worker', outcome: 'abandoned' },
      { attempt: 2, worker_id: 'test-worker', outcome: 'succeeded' },
    ]);
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM extracted_values')).toEqual([{ n: 9 }]);
  });

  it('handles duplicate delivery idempotently', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submit(ctx, tenantId);
    const [job] = await q(ctx, 'SELECT id FROM jobs');
    const message = { jobId: job.id, tenantId };
    // Three concurrent deliveries of the same job.
    const outcomes = await Promise.all([runJob(ctx, message), runJob(ctx, message), runJob(ctx, message)]);
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
    // A late redelivery after completion is a no-op.
    expect(await runJob(ctx, message)).toBe('skipped');
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM extracted_values')).toEqual([{ n: 9 }]);
    expect(await q(ctx, 'SELECT count(*)::int AS n FROM job_attempts')).toEqual([{ n: 1 }]);
    expect((await getProgress(ctx, { tenantId, documentId: sub.documentId })).status).toBe('awaiting_review');
  });

  it('accepts uploads while Redis is unavailable and publishes once it returns', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submit(ctx, tenantId); // submit never touches Redis
    const down = { add: async () => { throw new Error('connect ECONNREFUSED'); } } as unknown as Queue<JobMessage>;
    expect(await dispatchOutbox(ctx.db, down)).toEqual({ published: 0, failed: 1 });
    expect(await q(ctx, 'SELECT published_at, last_error FROM outbox')).toEqual([{ published_at: null, last_error: 'connect ECONNREFUSED' }]);
    handles = startWorker(ctx, { dispatchMs: 100, reconcileMs: 60_000 });
    await until(processed(ctx, tenantId, sub.documentId));
  });

  it('never leaves a job running forever: exhausted leases fail visibly for an operator', async () => {
    const ctx = await redisCtx();
    const { tenantId } = await seedTemplate(ctx, 'acme');
    const sub = await submit(ctx, tenantId);
    const [job] = await q(ctx, 'SELECT id FROM jobs');
    await q(ctx, 'UPDATE jobs SET max_attempts = 1');
    await claimJob(ctx.db, tenantId, job.id, 'crashed-worker', 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await reconcile(ctx.db)).toMatchObject({ exhausted: 1 });
    const progress = await getProgress(ctx, { tenantId, documentId: sub.documentId });
    expect(progress).toMatchObject({ status: 'failed_operator', failureReason: 'Processing stopped responding repeatedly.' });
    expect(await q(ctx, 'SELECT status FROM jobs')).toEqual([{ status: 'failed' }]);
  });
});
