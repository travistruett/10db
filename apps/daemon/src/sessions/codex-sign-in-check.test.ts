import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { codexLoginStatus } from './codex-sign-in-check';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A stand-in `codex`: a script run with the arguments and environment the check gives it. */
function fakeCodex(body: string): string {
  const dir = tempDir('login-status');
  dirs.push(dir);
  const file = join(dir.path, 'codex');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('codexLoginStatus', () => {
  it.each<[string, string, string]>([
    ['exits 0', "echo 'Logged in using ChatGPT'", 'signed_in'],
    [
      'says it is not logged in on stdout and exits 1',
      "echo 'Not logged in'; exit 1",
      'signed_out',
    ],
    [
      'says it is not logged in on stderr and exits 1',
      "echo 'Not logged in' >&2; exit 1",
      'signed_out',
    ],
    ['exits 1 with something else', "echo 'boom' >&2; exit 1", 'unknown'],
    ['says it is not logged in but exits 2', "echo 'Not logged in'; exit 2", 'unknown'],
    ['exits 3', 'exit 3', 'unknown'],
  ])('reads a codex that %s', async (_name, body, expected) => {
    await expect(codexLoginStatus(fakeCodex(body), {}, 5_000)).resolves.toBe(expected);
  });

  it('asks with the account env, so it reads the account home', async () => {
    const codex = fakeCodex(
      `[ "$1 $2" = "login status" ] && [ "$CODEX_HOME" = /accounts/b ] && exit 0; echo 'Not logged in'; exit 1`,
    );
    await expect(codexLoginStatus(codex, { CODEX_HOME: '/accounts/b' }, 5_000)).resolves.toBe(
      'signed_in',
    );
    await expect(codexLoginStatus(codex, {}, 5_000)).resolves.toBe('signed_out');
  });

  it('is unknown for a codex that is too slow or cannot start', async () => {
    await expect(codexLoginStatus(fakeCodex('sleep 5'), {}, 200)).resolves.toBe('unknown');
    await expect(codexLoginStatus('/nowhere/codex', {}, 5_000)).resolves.toBe('unknown');
  });
});
