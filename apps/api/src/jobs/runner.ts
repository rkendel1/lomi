import type { Ctx } from '../domain/common';
import { processVersion } from '../domain/processing';
import { generateOutput } from '../domain/generation';
import { claimJob } from './lifecycle';

/**
 * Execute one delivered job message. Safe to call any number of times for the
 * same job: only the delivery that wins the claim does work.
 */
export async function runJob(ctx: Ctx, message: { jobId: string; tenantId: string }): Promise<string> {
  const job = await claimJob(ctx.db, message.tenantId, message.jobId, ctx.config.workerId, ctx.config.leaseSeconds);
  if (!job) return 'skipped';
  if (job.kind === 'process_version') return processVersion(ctx, job);
  return generateOutput(ctx, job);
}
