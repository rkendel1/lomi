import { loadConfig } from './config';
import { createPool } from './db/pool';
import type { Ctx } from './domain/common';
import { startWorker } from './jobs/queue';
import { buildProviders } from './llm/providers';
import { FilesystemObjectStore } from './storage/objectStore';

/**
 * Worker entry point. This is the only process that loads model runtimes:
 * Laya's native binding is loaded here, in-process, on first use.
 */
const config = loadConfig();
const ctx: Ctx = {
  db: createPool(config.databaseUrl, config.dbAppRole),
  store: new FilesystemObjectStore(config.storageDir),
  config,
  providers: buildProviders({
    anthropicApiKey: config.anthropicApiKey,
    extractionModel: config.extractionModel,
    semanticModel: config.semanticModel,
    layaEnabled: config.layaEnabled,
    layaModelRoot: config.layaModelRoot,
    extractionDefault: config.extractionProvider,
    semanticDefault: config.semanticProvider,
  }),
};
const handles = startWorker(ctx, { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) });
console.log(
  `lomi-worker ${config.workerId} started; providers: extraction=[${Object.keys(ctx.providers.extraction).join(', ') || 'none'}] ` +
    `semantic=[${Object.keys(ctx.providers.semantic).join(', ') || 'none'}] defaults=${JSON.stringify(ctx.providers.defaults)}`
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: draining worker`);
    void handles.stop().then(() => ctx.db.end()).then(() => process.exit(0));
  });
}
