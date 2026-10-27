import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executable,
  installCandidates,
  INSTALL_PREFIXES_TEXT as LOOKED_IN,
} from './install-prefixes';
import { runGit } from './run';

const GIT_CANDIDATES = installCandidates('git');

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

/**
 * The one git the daemon runs for every call: the first of `candidates` that reads no attributes when
 * told to, by the path it was found at. Homebrew's prefix entry is a link into a versioned directory
 * that an upgrade's cleanup deletes; the link itself lives on, and only the builder can repoint it.
 * Refuses with a `GitVersionError` naming every git it found when none does.
 */
export async function resolveGit(candidates: readonly string[] = GIT_CANDIDATES): Promise<string> {
  const found = candidates.filter(executable);
  for (const bin of found) {
    if (await readsNoAttributes(bin)) return bin;
  }
  throw new GitVersionError(found);
}
