// Install the pinned rust-ml-runtime CLI (used only to install and check local models).
// Checksums are pinned here, not fetched next to the archive, so a tampered release is rejected.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, arch } from 'node:os';

const VERSION = '0.3.0';
const PINNED = {
  x64: { arch: 'x86_64', sha256: '301646b757dca423fa39875465ab4e1e568f239d647d657893690b7b322bd063' },
  arm64: { arch: 'aarch64', sha256: '713e2554aa54e739751df405d547f6b3e60420a2e5cd528e3b430bd4541393ba' },
};
const target = PINNED[arch()];
if (!target) throw new Error(`No pinned ml-runtime build for ${arch()}`);
const archive = `ml-runtime-v${VERSION}-linux-${target.arch}.tar.gz`;
const url = `https://github.com/rkendel1/rust-ml-runtime/releases/download/v${VERSION}/${archive}`;

const response = await fetch(url);
if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actual = createHash('sha256').update(bytes).digest('hex');
if (actual !== target.sha256) throw new Error(`Checksum mismatch for ${archive}: ${actual}`);

const dir = mkdtempSync(join(tmpdir(), 'mlr-'));
writeFileSync(join(dir, archive), bytes);
execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir]);
const find = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? find(join(d, n)) : n === 'ml-runtime' ? [join(d, n)] : []));
const [binary] = find(dir);
if (!binary) throw new Error('ml-runtime binary not found in archive');
copyFileSync(binary, '/usr/local/bin/ml-runtime');
chmodSync('/usr/local/bin/ml-runtime', 0o755);
console.log(`Installed ml-runtime ${VERSION} (${target.arch}), sha256 verified`);
