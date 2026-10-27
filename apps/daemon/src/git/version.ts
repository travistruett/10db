import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runGit } from './run';

/** No git on the login PATH can be told to read no attributes. */
export class GitVersionError extends Error {
  override readonly name = 'GitVersionError';
  readonly found: readonly string[];
  constructor(found: readonly string[]) {
    super(
      found.length === 0
        ? '10db found no git on your login PATH. Install git (brew install git) and open 10db again.'
        : `10db needs a git that honours GIT_ATTR_SOURCE (git 2.41 or newer), and none on your login PATH does: ${found.join(', ')}. Without it, 10db's own git could run filters a lane chose. Install a newer git (brew install git) and open 10db again.`,
    );
    this.found = found;
  }
}

/**
 * True when `bin` reads no attributes with `GIT_ATTR_SOURCE` at the empty tree: in a scratch
 * repository whose `.gitattributes` selects a filter, `check-attr` must say the filter is unspecified.
 * A git that ignores the variable, as git before 2.41 does, says otherwise.
 */
export async function readsNoAttributes(bin: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), '10db-git-probe-'));
  try {
    await runGit(dir, ['init', '-q'], { bin });
    writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
    const empty = (await runGit(dir, ['hash-object', '-t', 'tree', '--stdin'], { bin })).trim();
    const out = await runGit(dir, ['check-attr', 'filter', '--', 'f'], {
      bin,
      env: { GIT_ATTR_SOURCE: empty },
    });
    return out.trim() === 'f: filter: unspecified';
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The one git the daemon runs for every call: the first `git` on the login `path` that reads no
 * attributes when told to. Refuses with a `GitVersionError` naming every git it found when none does.
 */
export async function resolveGit(path: string): Promise<string> {
  const found = [
    ...new Set(
      path
        .split(':')
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, 'git'))
        .filter(executable),
    ),
  ];
  for (const bin of found) if (await readsNoAttributes(bin)) return bin;
  throw new GitVersionError(found);
}
