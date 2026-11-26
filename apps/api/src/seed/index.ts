import { loadConfig } from '../config';
import { createPool, migrate } from '../db/pool';
import type { Ctx } from '../domain/common';
import { buildProviders } from '../llm/providers';
import { FilesystemObjectStore } from '../storage/objectStore';
import { seedConfiguration, seedDocuments } from './seed';

/** `node dist/seed.js` — idempotent demo data. Documents are processed by the running worker. */
const config = loadConfig();
async function main() {
  await migrate(config.databaseUrl);
  const ctx: Ctx = {
    db: createPool(config.databaseUrl, config.dbAppRole),
    store: new FilesystemObjectStore(config.storageDir),
    config,
    providers: buildProviders({ extractionModel: config.extractionModel, semanticModel: config.semanticModel }),
  };
  const tenants = await seedConfiguration(ctx);
  console.log('Seeded configuration for tenants:', Object.keys(tenants).join(', '));
  const docs = await seedDocuments(ctx, tenants, { waitMs: Number(process.env.SEED_WAIT_MS ?? 180_000) });
  if (docs.skipped) {
    console.log('Documents already present; fixtures not re-seeded.');
  } else {
    console.log('Seeded version 1 of each fixture. Extraction results:');
    for (const d of docs.documents as Array<{ tenant: string; title: string; status: string; failure: string | null; values: Array<{ field: string; value: string | null; gap: string | null }> }>) {
      console.log(`  [${d.tenant}] ${d.title} — ${d.status}${d.failure ? ` (${d.failure})` : ''}`);
      for (const v of d.values) console.log(`      ${v.field.padEnd(40)} ${v.value ?? `GAP: ${v.gap}`}`);
    }
    const failed = (docs.documents as Array<{ status: string }>).filter((d) => d.status.startsWith('failed'));
    if (failed.length) {
      console.error(`${failed.length} fixture document(s) failed processing.`);
      process.exitCode = 1;
    }
  }
  await ctx.db.end();
}
main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
