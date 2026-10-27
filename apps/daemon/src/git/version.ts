import {
  accessSync,
  constants,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './run';

/**
 * Where the daemon looks for git, in order: Homebrew on Apple silicon, Homebrew on Intel, then the
 * system's. Never the login PATH, which can name a directory a lane writes, such as a checkout's
 * `node_modules/.bin`.
 */
export const GIT_PREFIXES: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const GIT_CANDIDATES = GIT_PREFIXES.map((dir) => join(dir, 'git'));

const LOOKED_IN = '/opt/homebrew/bin, /usr/local/bin and /usr/bin';

/** No git in the fixed install prefixes can be told to read no attributes. */
export class GitVersionError extends Error {
  override readonly name = 'GitVersionError';
  readonly found: readonly string[];
  constructor(found: readonly string[]) {
    super(
      found.length === 0
        ? `10db found no git in ${LOOKED_IN}. Install git 2.41 or newer with Homebrew (brew install git) or the Xcode Command Line Tools (xcode-select --install), and open 10db again. 10db never runs a git from your PATH, where a lane could put one.`
        : `10db needs a git that honours GIT_ATTR_SOURCE (git 2.41 or newer), and none of those it found does: ${found.join(', ')}. Without it, 10db's own git could run filters a lane chose. Install a newer git with Homebrew (brew install git) and open 10db again. 10db looks only in ${LOOKED_IN}, never your PATH, where a lane could put a git.`,
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
 * The one git the daemon runs for every call: the real path of the first of `candidates` that reads
 * no attributes when told to. Refuses with a `GitVersionError` naming every git it found when none does.
 */
export async function resolveGit(candidates: readonly string[] = GIT_CANDIDATES): Promise<string> {
  const found = candidates.filter(executable);
  for (const bin of found) {
    // The file probed is the file run: a link in a prefix can't later point elsewhere.
    const real = realpathSync(bin);
    if (await readsNoAttributes(real)) return real;
  }
  throw new GitVersionError(found);
}
