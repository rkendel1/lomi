import { createApiServer } from './app';
import { loadConfig } from './config';
import { createPool, migrate } from './db/pool';
import type { Ctx } from './domain/common';
import { createDocOpsRoutes } from './http/docops';
import { dispatchOutbox } from './jobs/dispatcher';
import { createQueue } from './jobs/queue';
import { buildProviders } from './llm/providers';
import { FilesystemObjectStore } from './storage/objectStore';

/**
 * API entry point. It never loads model runtimes: Laya is registered as a
 * provider but is only initialised in the worker, where semantic checks run.
 */
const config = loadConfig();
const port = Number(process.env.PORT ?? 4000);

async function main() {
  if (process.env.LOMI_MIGRATE_ON_START !== '0') {
    const applied = await migrate(config.databaseUrl);
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }
  const ctx: Ctx = {
    db: createPool(config.databaseUrl, config.dbAppRole),
    store: new FilesystemObjectStore(config.storageDir),
    config,
    // The API registers no model providers: it never runs extraction or validation.
    providers: buildProviders({ extractionModel: config.extractionModel, semanticModel: config.semanticModel }),
  };
  // Start processing the moment a submission commits, instead of waiting for the worker's dispatcher poll.
  const queue = createQueue(ctx);
  ctx.dispatchNow = () => void dispatchOutbox(ctx.db, queue).catch((e) => console.warn('[dispatch-now] deferred to worker:', e.message));
  const server = createApiServer(createDocOpsRoutes(ctx));
  server.listen(port, '0.0.0.0', () => console.log(`lomi-api listening on http://0.0.0.0:${port}`));
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => void ctx.db.end().then(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('lomi-api failed to start:', error.message);
  process.exit(1);
});
