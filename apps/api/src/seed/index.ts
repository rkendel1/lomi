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
  console.log('Seeded documents:', JSON.stringify(docs));
  await ctx.db.end();
}
main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
