// probe(): is OpenCode installed, which version, and is any model provider configured?
// Never throws. Avoids the user's background service: only `opencode --version`, config files,
// environment, and (as a last resort) `opencode auth list --standalone`, which runs a private
// throwaway server.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentProbe } from '@bizzi/protocol';
import { locateBinary } from './locate.ts';

export interface ProbeOptions {
  binary: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** URL + password of our own running server, if any (lets `auth list` reuse it). */
  server?: { url: string; password?: string };
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  notFound: boolean;
  path?: string;
}

function run(cmd: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), notFound: code === 'ENOENT' });
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err), notFound: false });
    }
  });
}

/** Strip // and /* *\/ comments and trailing commas from JSONC (string-aware). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Provider ids declared in the user's global OpenCode config (keys only; secrets are never read out). */
export async function configuredProviders(env: Record<string, string | undefined>): Promise<string[]> {
  const dirs = [env.OPENCODE_CONFIG_DIR, join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'opencode')];
  const ids = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of ['opencode.jsonc', 'opencode.json', 'config.json']) {
      try {
        const cfg = parseJsonc(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
        for (const key of ['providers', 'provider']) {
          const p = cfg[key];
          if (p && typeof p === 'object') for (const id of Object.keys(p)) ids.add(id);
        }
      } catch {
        // missing or unparsable
      }
    }
  }
  return [...ids];
}

const PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENCODE_API_KEY',
];

export async function probeOpenCode(opts: ProbeOptions): Promise<AgentProbe> {
  const env = { ...process.env, ...opts.env };
  const probe: AgentProbe = { agent: 'opencode', installed: false, auth: 'unknown' };
  const notes: string[] = [];
  const binary = locateBinary(opts.binary, env);
  try {
    const ver = await run(binary, ['--version'], env, Math.min(opts.timeoutMs, 10_000));
    if (ver.notFound) {
      probe.notes = [`${opts.binary} not found on PATH`];
      return probe;
    }
    const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec(ver.stdout + ver.stderr);
    if (!ver.ok && !m) {
      probe.notes = [`${opts.binary} --version failed: ${(ver.stderr || ver.stdout).trim().slice(0, 200)}`];
      return probe;
    }
    probe.installed = true;
    probe.path = binary;
    if (m?.[1]) probe.version = m[1];
    const major = probe.version ? Number(probe.version.split('.')[0]) : NaN;
    if (Number.isFinite(major) && major < 2) {
      notes.push(`OpenCode ${probe.version} is v1; this adapter targets the v2 server API (>= 2.0)`);
    }

    // 1. Providers declared in config, or provider API keys in the environment: cheap and local.
    const providers = await configuredProviders(env);
    const envKeys = PROVIDER_ENV.filter((k) => env[k]);
    if (providers.length || envKeys.length) {
      probe.auth = 'ok';
      if (providers.length) notes.push(`configured providers: ${providers.join(', ')}`);
      if (envKeys.length) notes.push(`provider keys in environment: ${envKeys.join(', ')}`);
      probe.notes = notes;
      return probe;
    }

    // 2. Stored credentials (opencode auth login), via our server or a private standalone one.
    const args = ['auth', 'list', '--format', 'json', ...(opts.server ? ['--server', opts.server.url] : ['--standalone'])];
    const authEnv = { ...env };
    if (opts.server?.password) authEnv.OPENCODE_PASSWORD = opts.server.password;
    const res = await run(binary, args, authEnv, opts.timeoutMs);
    if (res.ok) {
      const list = JSON.parse(res.stdout || '[]') as { id: string; name?: string; connections?: unknown[] }[];
      const connected = list.filter((i) => Array.isArray(i.connections) && i.connections.length > 0);
      // MCP OAuth logins show up here too (ids "mcp_…"); they don't make a model usable.
      const modelProviders = connected.filter((i) => !String(i.id).startsWith('mcp_'));
      if (modelProviders.length) {
        probe.auth = 'ok';
        probe.account = modelProviders.map((i) => i.name ?? i.id).join(', ');
      } else {
        notes.push('no provider credentials found; only free OpenCode Zen models are usable (run `opencode auth login`)');
      }
    } else {
      notes.push(`opencode auth list failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
    }
  } catch (err) {
    notes.push(`probe error: ${String(err)}`);
  }
  if (notes.length) probe.notes = notes;
  return probe;
}
