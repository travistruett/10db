import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './fixtures';

/** The git a wrapper hands on to. */
export function realGit(): string {
  return execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
}

/**
 * A `git` on a directory to put first on PATH: it runs `script` (shell, with the real git in `$GIT`
 * and the call's arguments in `"$@"`), which ends by running the real git itself. It stands in for a
 * lane acting between two of the daemon's git calls.
 */
export function gitWrapper(script: string) {
  const dir = tempDir('git-wrapper');
  const path = join(dir.path, 'git');
  writeFileSync(path, `#!/bin/sh\nGIT='${realGit()}'\n${script}\n`);
  chmodSync(path, 0o755);
  return {
    /** PATH with the wrapper first. */
    path: `${dir.path}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
    cleanup: () => {
      dir.cleanup();
    },
  };
}
