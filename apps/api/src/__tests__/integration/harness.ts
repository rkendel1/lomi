import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from '../../config';
import { createPool, migrate } from '../../db/pool';
import type { Actor, Ctx } from '../../domain/common';
import { createDocumentType, publishTemplate, saveDraft, uploadBasePdf } from '../../domain/templates';
import { createTenant } from '../../domain/tenants';
import { withSystem } from '../../db/pool';
import { runJob } from '../../jobs/runner';
import { buildProviders } from '../../llm/providers';
import type { LayaNative } from '../../llm/laya';
import { FilesystemObjectStore } from '../../storage/objectStore';
import { INVOICE_TEMPLATE, outputFormPdf } from '../../seed/fixtures';
import type { TemplateDefinition } from '@lomi/docops';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

export const OPERATOR: Actor = { principalId: null, kind: 'user', displayName: 'test operator' };

/** A fake of rust-ml-runtime's native binding: answers every decision "favourably" with high confidence. */
export function fakeLaya(options: { ready?: boolean; onDecide?: (req: any) => void } = {}): LayaNative {
  return {
    selfTest: () => ({
      available: options.ready ?? true,
      model: { identifier: 'fake-laya', revision: 'test', backend: 'fake', decision_types: ['noul', 'choice', 'score'] },
      checks: [{ check: 'local inference', ok: options.ready ?? true, message: options.ready === false ? 'model not found: laya' : 'ok' }],
    }),
    create: async () => ({
      decideAsync: async (req: any) => {
        options.onDecide?.(req);
        const d = req.decisions[0];
        const value = d.kind.type === 'noul' ? true : d.kind.type === 'choice' ? d.kind.options[1].label : 3;
        return { model: { identifier: 'fake-laya', revision: 'test' }, backend: 'fake', decisions: [{ name: d.name, kind: d.kind.type, value: { type: d.kind.type, value }, probabilities: {}, confidence: 0.9 }] };
      },
    }),
  };
}

let migrated = false;

/** Fresh database state and a context whose queries run as lomi_app (RLS enforced). */
export async function setup(overrides: { laya?: LayaNative; semanticDefault?: string } = {}): Promise<Ctx> {
  if (!migrated) {
    await migrate(TEST_DATABASE_URL);
    migrated = true;
  }
  const owner = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await owner.connect();
  const tables = (await owner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`)).rows.map((r) => r.tablename);
  await owner.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  await owner.end();
  const config = { ...loadConfig({ DATABASE_URL: TEST_DATABASE_URL }), storageDir: mkdtempSync(join(tmpdir(), 'lomi-store-')), workerId: 'test-worker', leaseSeconds: 30 };
  return {
    db: createPool(TEST_DATABASE_URL, 'lomi_app'),
    store: new FilesystemObjectStore(config.storageDir),
    config,
    providers: buildProviders({ extractionModel: 'x', semanticModel: 'x', layaEnabled: true, layaNative: overrides.laya ?? fakeLaya(), semanticDefault: overrides.semanticDefault ?? 'laya' }),
  };
}

export async function seedTemplate(ctx: Ctx, tenantSlug: string, docType = 'invoice', definition: TemplateDefinition = INVOICE_TEMPLATE) {
  const tenant = await createTenant(ctx, OPERATOR, { slug: tenantSlug, name: tenantSlug });
  await createDocumentType(ctx, OPERATOR, { tenantId: tenant.id, key: docType, name: docType });
  const base = await uploadBasePdf(ctx, OPERATOR, {
    tenantId: tenant.id, documentType: docType, filename: `${docType}-form.pdf`,
    bytes: await outputFormPdf(`${docType} approval record`, definition.fields.map((f) => f.displayLabel)),
  });
  const draft = await saveDraft(ctx, OPERATOR, { tenantId: tenant.id, documentType: docType, definition, basePdfId: base.id });
  await publishTemplate(ctx, OPERATOR, { tenantId: tenant.id, templateVersionId: draft.id });
  return { tenantId: tenant.id, templateVersionId: draft.id, basePdfId: base.id };
}

/** Run due outbox events directly (no Redis), repeatedly, until nothing is due. */
export async function drain(ctx: Ctx, maxRounds = 20): Promise<string[]> {
  const outcomes: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const due = await withSystem(ctx.db, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE outbox SET published_at = now(), publish_count = publish_count + 1
         WHERE published_at IS NULL AND available_at <= now() RETURNING job_id, tenant_id`
      );
      return rows;
    });
    if (!due.length) break;
    for (const row of due) outcomes.push(await runJob(ctx, { jobId: row.job_id, tenantId: row.tenant_id }));
  }
  return outcomes;
}

export async function q<T = any>(ctx: Ctx, sql: string, params: unknown[] = []): Promise<T[]> {
  return withSystem(ctx.db, async (tx) => (await tx.query(sql, params)).rows as T[]);
}
