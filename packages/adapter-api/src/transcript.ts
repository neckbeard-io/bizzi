// API chat history per conversation, so a session can resume (also after a node restart) and fork.
// Stored as `<dataDir>/api-chat/<ref>.json` (0600), or in memory when there is no data dir.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from './chat.ts';

export interface Transcript {
  version: 1;
  /** `provider/model` last used. */
  model?: string;
  effort?: string;
  messages: ChatMessage[];
}

export const TRANSCRIPT_DIR = 'api-chat';
const REF_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

export function isTranscriptRef(ref: string): boolean {
  return REF_RE.test(ref);
}

export class TranscriptStore {
  readonly dir: string | undefined;
  readonly #memory = new Map<string, string>();

  constructor(dataDir?: string) {
    this.dir = dataDir ? join(dataDir, TRANSCRIPT_DIR) : undefined;
  }

  get persistent(): boolean {
    return this.dir !== undefined;
  }

  load(ref: string): Transcript | undefined {
    if (!isTranscriptRef(ref)) return undefined;
    let raw: string | undefined;
    if (this.dir) {
      const p = join(this.dir, `${ref}.json`);
      raw = existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    } else {
      raw = this.#memory.get(ref);
    }
    if (raw === undefined) return undefined;
    const t = JSON.parse(raw) as Transcript;
    return t && t.version === 1 && Array.isArray(t.messages) ? t : undefined;
  }

  save(ref: string, t: Transcript): void {
    if (!isTranscriptRef(ref)) throw new Error(`invalid transcript ref ${ref}`);
    const raw = JSON.stringify(t);
    if (!this.dir) {
      this.#memory.set(ref, raw);
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = join(this.dir, `${ref}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, raw, { mode: 0o600 });
    renameSync(tmp, p);
  }

  delete(ref: string): void {
    if (!isTranscriptRef(ref)) return;
    if (this.dir) rmSync(join(this.dir, `${ref}.json`), { force: true });
    else this.#memory.delete(ref);
  }
}
