// Downloads a release asset to a temp file with progress, and checks it against the sha256 digest
// GitHub publishes for the asset before anything installs it.

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Fetch, GitHubAsset } from './github.ts';
import { HttpError, USER_AGENT } from './github.ts';

export interface DownloadOptions {
  fetch: Fetch;
  asset: GitHubAsset;
  dir: string;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

export async function downloadAsset(o: DownloadOptions): Promise<string> {
  mkdirSync(o.dir, { recursive: true });
  const file = join(o.dir, o.asset.name);
  rmSync(file, { force: true });
  const res = await o.fetch(o.asset.browser_download_url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': USER_AGENT },
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok || !res.body) throw new HttpError(res.status);
  const total = Number(res.headers.get('content-length')) || o.asset.size;
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
      o.onProgress?.(received, total);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(file, { force: true });
    throw err;
  }
  const expected = o.asset.digest?.startsWith('sha256:') ? o.asset.digest.slice(7).toLowerCase() : null;
  const actual = hash.digest('hex');
  if (expected && expected !== actual) {
    rmSync(file, { force: true });
    throw new Error(`The download of ${o.asset.name} is corrupt (sha256 ${actual}, expected ${expected}).`);
  }
  if (o.asset.size && received !== o.asset.size) {
    rmSync(file, { force: true });
    throw new Error(`The download of ${o.asset.name} is incomplete (${received} of ${o.asset.size} bytes).`);
  }
  return file;
}
