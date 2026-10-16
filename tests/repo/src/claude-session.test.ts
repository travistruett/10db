import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRepoFile } from './workspace';

const Settings = z.object({
  hooks: z.object({
    SessionStart: z.array(
      z.object({ hooks: z.array(z.object({ type: z.literal('command'), command: z.string() })) }),
    ),
  }),
});

const BASE_PATH = '/usr/bin:/bin';

/** HOME plus mise's data-dir variables, which decide where the shims live. */
function baseEnv(): NodeJS.ProcessEnv {
  const { HOME, MISE_DATA_DIR, XDG_DATA_HOME } = process.env;
  return { HOME, MISE_DATA_DIR, XDG_DATA_HOME };
}

function sessionStartCommands(): string[] {
  const settings = Settings.parse(JSON.parse(readRepoFile('.claude/settings.json')));
  return settings.hooks.SessionStart.flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

function miseDir(): string {
  const found = spawnSync('sh', ['-c', 'command -v mise'], { encoding: 'utf8' });
  expect(found.status, 'mise must be on PATH to run this test').toBe(0);
  return dirname(found.stdout.trim());
}

describe('Claude Code session start', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Claude Code sources CLAUDE_ENV_FILE before every Bash call, and agent shells never run
  // mise's prompt hook, so the shims must arrive through that file.
  it.each([
    { name: 'puts the mise shims on PATH when mise is installed', withMise: true },
    { name: 'leaves the env file empty when mise is missing', withMise: false },
  ])('$name', ({ withMise }) => {
    dir = mkdtempSync(join(tmpdir(), 'session-start-'));
    const envFile = join(dir, 'env.sh');
    writeFileSync(envFile, '');
    const path = withMise ? `${miseDir()}:${BASE_PATH}` : BASE_PATH;
    const commands = sessionStartCommands();
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const run = spawnSync('sh', ['-c', command], {
        encoding: 'utf8',
        env: { ...baseEnv(), PATH: path, CLAUDE_ENV_FILE: envFile },
      });
      expect(run.status, run.stderr).toBe(0);
    }

    if (!withMise) {
      expect(readFileSync(envFile, 'utf8')).toBe('');
      return;
    }
    const node = spawnSync('sh', ['-c', `. "${envFile}" && command -v node`], {
      encoding: 'utf8',
      env: { ...baseEnv(), PATH: BASE_PATH },
    });
    expect(node.stdout.trim()).toMatch(/\/shims\/node$/);
  });
});
