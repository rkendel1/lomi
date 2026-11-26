/**
 * @lomi/docops
 *
 * Document-operations domain logic: extraction orchestration, evidence
 * verification, deterministic/semantic validation, review disposition and
 * revision carry-over. Pure functions over plain data — no database, queue or
 * HTTP — so the API, worker and tests share one implementation.
 */

export * from './types';
export * from './text';
export * from './values';
export * from './extraction';
export * from './validation';
export * from './carryover';
export * from './process';
