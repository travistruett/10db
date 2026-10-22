import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isolatedGitEnv, tempDir } from './fixtures';

/**
 * A repository that leaked git hook variables could point at, standing in for the contributor's
 * real checkout. `snapshot` hashes every file under it, `.git` included, so any write shows up.
 */
export interface DecoyRepo {
  readonly path: string;
  /** The variables git exports to a hook, aimed at this repository. */
  readonly hookVariables: Readonly<Record<string, string>>;
  snapshot(): Record<string, string>;
  cleanup(): void;
}

export function createDecoyRepo(): DecoyRepo {
  const dir = tempDir('decoy');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir.path, env: isolatedGitEnv(), stdio: 'pipe' });
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.name', 'decoy owner');
  git('config', 'user.email', 'owner@decoy.invalid');
  writeFileSync(join(dir.path, 'decoy.txt'), 'the real repository\n');
  git('add', 'decoy.txt');
  git('commit', '-q', '-m', 'Decoy commit');
  const gitDir = join(dir.path, '.git');
  return {
    path: dir.path,
    hookVariables: {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: dir.path,
      GIT_INDEX_FILE: join(gitDir, 'index'),
      GIT_COMMON_DIR: gitDir,
    },
    snapshot: () => {
      const files: Record<string, string> = {};
      for (const entry of readdirSync(dir.path, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        files[relative(dir.path, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      }
      return files;
    },
    cleanup: () => {
      dir.cleanup();
    },
  };
}
