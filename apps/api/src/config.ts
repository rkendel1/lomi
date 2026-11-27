/** Environment configuration. Every value has a safe local-development default. */
export interface Config {
  databaseUrl: string;
  /** Role queries run as. Must not be a superuser, or row-level security is bypassed. Empty disables SET ROLE. */
  dbAppRole: string;
  redisUrl: string;
  queuePrefix: string;
  storageDir: string;
  anthropicApiKey: string | undefined;
  extractionModel: string;
  semanticModel: string;
  /** Run Laya in-process via rust-ml-runtime's native Node binding. */
  layaEnabled: boolean;
  /** Installed-model root for rust-ml-runtime (ML_RUNTIME_MODEL_DIR). */
  layaModelRoot: string | undefined;
  extractionProvider: string | undefined;
  semanticProvider: string | undefined;
  devLogin: boolean;
  /** Operators may load the demo workload (demo customers and ~120 documents). Never in production. */
  demoEnabled: boolean;
  workerId: string;
  leaseSeconds: number;
  /** Development only: identity used for REST calls that send no token (so curl examples work). */
  devDefaultToken: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://lomi:lomi@localhost:5432/lomi',
    dbAppRole: env.DB_APP_ROLE ?? 'lomi_app',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    queuePrefix: env.QUEUE_PREFIX ?? 'lomi',
    storageDir: env.LOMI_STORAGE_DIR ?? './.lomi-storage',
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    extractionModel: env.LOMI_EXTRACTION_MODEL ?? 'claude-opus-5-5',
    semanticModel: env.LOMI_SEMANTIC_MODEL ?? 'claude-haiku-5-5',
    layaEnabled: env.LOMI_LAYA === '1',
    layaModelRoot: env.ML_RUNTIME_MODEL_DIR || undefined,
    extractionProvider: env.LOMI_EXTRACTION_PROVIDER || undefined,
    semanticProvider: env.LOMI_SEMANTIC_PROVIDER || undefined,
    devLogin: env.LOMI_DEV_LOGIN === '1',
    demoEnabled: env.LOMI_DEMO === '1' || (env.LOMI_DEMO !== '0' && env.LOMI_DEV_LOGIN === '1'),
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    leaseSeconds: Number(env.JOB_LEASE_SECONDS ?? 60),
    devDefaultToken: env.LOMI_DEV_DEFAULT_TOKEN || undefined,
  };
}
