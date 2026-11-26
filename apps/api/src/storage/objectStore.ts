import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Tx } from '../db/pool';

/**
 * Blob storage. Keys are content-addressed and tenant-prefixed, so the same
 * bytes stored twice resolve to one immutable object. PostgreSQL holds the
 * metadata (`stored_objects`); this interface only moves bytes.
 */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export class FilesystemObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (key.includes('..')) throw new Error('Invalid object key');
    return join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    const exists = await stat(path).then(() => true, () => false);
    if (exists) return; // content-addressed: identical bytes already stored
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path); // atomic publish; readers never see partial files
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface StoredObject {
  id: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
}

/** Write bytes and record them. The blob is written before the row, so a committed row always has bytes behind it. */
export async function storeObject(
  tx: Tx,
  store: ObjectStore,
  tenantId: string,
  bytes: Uint8Array,
  contentType: string
): Promise<StoredObject> {
  const sha256 = sha256Hex(bytes);
  const storageKey = `tenants/${tenantId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
  await store.put(storageKey, bytes);
  const inserted = await tx.query(
    `INSERT INTO stored_objects (tenant_id, sha256, size_bytes, content_type, storage_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, sha256) DO NOTHING
     RETURNING id`,
    [tenantId, sha256, bytes.length, contentType, storageKey]
  );
  const rows = inserted.rows.length
    ? inserted.rows
    : (await tx.query('SELECT id FROM stored_objects WHERE tenant_id = $1 AND sha256 = $2', [tenantId, sha256])).rows;
  return { id: rows[0].id, sha256, sizeBytes: bytes.length, storageKey };
}

export async function loadObject(tx: Tx, store: ObjectStore, objectId: string): Promise<Uint8Array> {
  const { rows } = await tx.query('SELECT storage_key, sha256 FROM stored_objects WHERE id = $1', [objectId]);
  if (!rows[0]) throw new Error(`Object ${objectId} not found`);
  const bytes = await store.get(rows[0].storage_key);
  if (sha256Hex(bytes) !== rows[0].sha256) throw new Error(`Object ${objectId} failed its integrity check`);
  return bytes;
}
