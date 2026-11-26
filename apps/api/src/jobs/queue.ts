import { Queue, Worker } from 'bullmq';
import type { Ctx } from '../domain/common';
import { withSystem } from '../db/pool';
import { dispatchOutbox, type JobMessage } from './dispatcher';
import { reconcile } from './reconciler';
import { runJob } from './runner';

export const QUEUE_NAME = 'document-jobs';

function connection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export function createQueue(ctx: Ctx): Queue<JobMessage> {
  return new Queue<JobMessage>(QUEUE_NAME, { connection: connection(ctx.config.redisUrl), prefix: ctx.config.queuePrefix });
}

export interface WorkerHandles {
  queue: Queue<JobMessage>;
  worker: Worker<JobMessage>;
  stop(): Promise<void>;
  /** One dispatch + reconcile pass (also run on timers). */
  tick(): Promise<void>;
}

/**
 * The worker process: consumes BullMQ messages, dispatches the outbox, and
 * reconciles outstanding work from PostgreSQL on a timer. Redis only carries
 * wake-up messages; every state transition is in PostgreSQL.
 */
export function startWorker(
  ctx: Ctx,
  options: { concurrency?: number; dispatchMs?: number; reconcileMs?: number; staleSeconds?: number; readinessMs?: number } = {}
): WorkerHandles {
  const queue = createQueue(ctx);
  const worker = new Worker<JobMessage>(QUEUE_NAME, async (job) => runJob(ctx, job.data), {
    connection: connection(ctx.config.redisUrl),
    prefix: ctx.config.queuePrefix,
    concurrency: options.concurrency ?? 4,
  });
  worker.on('error', (error) => console.error('[worker] queue error:', error.message));

  let stopped = false;
  const tick = async () => {
    await dispatchOutbox(ctx.db, queue).catch((e) => console.error('[dispatcher]', e.message));
  };
  const recover = async () => {
    const r = await reconcile(ctx.db, { staleSeconds: options.staleSeconds }).catch((e) => {
      console.error('[reconciler]', e.message);
      return null;
    });
    if (r && (r.expiredLeases || r.republished || r.exhausted)) console.log('[reconciler]', JSON.stringify(r));
  };
  const reportReadiness = async () => {
    for (const [role, providers] of [['extraction', ctx.providers.extraction], ['semantic', ctx.providers.semantic]] as const) {
      for (const [name, provider] of Object.entries(providers)) {
        const r: { ready: boolean; detail: string; model?: string } = await (provider.readiness() as Promise<{ ready: boolean; detail: string; model?: string }>).catch((e: unknown) => ({ ready: false, detail: (e as Error).message }));
        await withSystem(ctx.db, (tx) =>
          tx.query(
            `INSERT INTO provider_readiness (worker_id, role, provider, ready, detail, model, checked_at) VALUES ($1,$2,$3,$4,$5,$6,now())
             ON CONFLICT (worker_id, role, provider) DO UPDATE SET ready = EXCLUDED.ready, detail = EXCLUDED.detail, model = EXCLUDED.model, checked_at = now()`,
            [ctx.config.workerId, role, name, r.ready, r.detail, r.model ?? null]
          )
        ).catch(() => undefined);
      }
    }
  };
  const timers = [
    setInterval(() => !stopped && void tick(), options.dispatchMs ?? 500),
    setInterval(() => !stopped && void recover(), options.reconcileMs ?? 15_000),
    setInterval(() => !stopped && void reportReadiness(), options.readinessMs ?? 60_000),
  ];
  void reportReadiness();
  return {
    queue,
    worker,
    tick: async () => {
      await recover();
      await tick();
    },
    async stop() {
      stopped = true;
      timers.forEach(clearInterval);
      await worker.close();
      await queue.close();
    },
  };
}
