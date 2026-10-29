import { execFileSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `pnpm` a worktree install runs, as an absolute path the daemon found itself: the first on the
 * login env's `PATH` that lies outside every checkout. A mise shim picks its version from the
 * directory it runs in, which would let the repository's `mise.toml` choose the program, so a shim is
 * asked from a neutral directory, where only the builder's own config applies. Null when none is found.
 */
export function resolvePnpm(
  env: Readonly<Record<string, string>>,
  checkouts: readonly string[],
): string | null {
  const roots = checkouts.map((checkout) => realpathOrSelf(checkout));
  const outside = (path: string): boolean =>
    !roots.some((root) => under(realpathOrSelf(path), root));
  const candidates = (name: string): string[] =>
    (env['PATH'] ?? '')
      .split(delimiter)
      .filter((dir) => isAbsolute(dir) && outside(dir))
      .map((dir) => join(dir, name))
      .filter((path) => executable(path) && outside(path));
  for (const candidate of candidates('pnpm')) {
    if (!candidate.endsWith('/shims/pnpm')) return candidate;
    for (const mise of candidates('mise')) {
      try {
        const answer = execFileSync(mise, ['which', 'pnpm'], {
          cwd: tmpdir(),
          env,
          encoding: 'utf8',
          timeout: 15_000,
        }).trim();
        if (isAbsolute(answer) && executable(answer) && outside(answer)) return answer;
      } catch {
        // mise could not say; the next one, or the next pnpm, may.
      }
    }
  }
  return null;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
