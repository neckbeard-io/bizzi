import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether Claude Code has a transcript for `sessionId` (`<config>/projects/<project>/<id>.jsonl`).
 * Claude Code writes it only once the first message is sent, so a session that was started but
 * never used has none and can't be resumed. `undefined` when it can't tell.
 */
export async function hasTranscript(sessionId: string, env: Record<string, string | undefined>): Promise<boolean | undefined> {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  let dirs: string[];
  try {
    dirs = (await readdir(projects, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? false : undefined;
  }
  const found = await Promise.all(
    dirs.map((d) =>
      access(join(projects, d, `${sessionId}.jsonl`)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.includes(true);
}
