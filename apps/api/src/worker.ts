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
// Load local models now so the first submission is processed without a cold start.
for (const [name, provider] of Object.entries(ctx.providers.semantic)) {
  const warm = (provider as { warm?: () => Promise<{ ready: boolean; detail: string }> }).warm;
  if (warm) {
    const t0 = Date.now();
    void warm.call(provider).then(
      (r) => console.log(`[warm] ${name}: ${r.ready ? `ready in ${Date.now() - t0} ms` : `not ready (${r.detail})`}`),
      (e) => console.warn(`[warm] ${name}: ${(e as Error).message}`)
    );
  }
}
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
