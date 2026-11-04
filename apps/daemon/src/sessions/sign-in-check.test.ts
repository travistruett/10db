import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { claudeAuthStatus } from './sign-in-check';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A stand-in `claude`: a script run with the arguments and environment the check gives it. */
function fakeClaude(body: string): string {
  const dir = tempDir('auth-status');
  dirs.push(dir);
  const file = join(dir.path, 'claude');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe('claudeAuthStatus', () => {
  it.each([
    ['signed in', '{"loggedIn": true, "authMethod": "claude.ai"}', 'signed_in'],
    ['signed out', '{"loggedIn": false, "authMethod": "none"}', 'signed_out'],
  ])('reads %s from `claude auth status --json`', async (_name, json, expected) => {
    const claude = fakeClaude(`printf '%s' '${json}'`);
    await expect(claudeAuthStatus(claude, {}, 5_000)).resolves.toBe(expected);
  });

  it('reads signed out from a claude that says so and exits 1', async () => {
    const claude = fakeClaude(`printf '{"loggedIn": false}'; exit 1`);
    await expect(claudeAuthStatus(claude, {}, 5_000)).resolves.toBe('signed_out');
  });

  it('asks with the account env, so it reads the account config dir', async () => {
    const claude = fakeClaude(
      `[ "$1 $2 $3" = "auth status --json" ] && [ "$CLAUDE_CONFIG_DIR" = /accounts/b ] && printf '{"loggedIn": true}' || printf '{"loggedIn": false}'`,
    );
    await expect(
      claudeAuthStatus(claude, { CLAUDE_CONFIG_DIR: '/accounts/b' }, 5_000),
    ).resolves.toBe('signed_in');
  });

  it.each([
    ['fails', 'exit 3'],
    ['prints something else', "printf 'not json'"],
    ['prints no loggedIn', "printf '{}'"],
    ['is too slow', 'sleep 5'],
    ['fails and prints something else', "printf 'not json'; exit 1"],
    ['fails and prints no loggedIn', "printf '{}'; exit 1"],
    ['is too slow after printing an answer', `printf '{"loggedIn": false}'; sleep 5`],
    ['is killed after printing an answer', `printf '{"loggedIn": false}'; kill -9 $$`],
  ])('is unknown when claude %s', async (_name, body) => {
    const claude = fakeClaude(body);
    await expect(claudeAuthStatus(claude, {}, 300)).resolves.toBe('unknown');
  });

  it('is unknown when claude is not there', async () => {
    await expect(claudeAuthStatus('/nonexistent/claude', {}, 300)).resolves.toBe('unknown');
  });
});
