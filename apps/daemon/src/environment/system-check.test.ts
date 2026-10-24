import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  claudeCodeWarning,
  findOnPath,
  markGhRequired,
  probeVersion,
  systemCheck,
  type LoginEnv,
} from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => {
  dir = tempDir('system-check');
});
afterEach(() => {
  dir.cleanup();
});

function tool(subdir: string, name: string, script: string, mode = 0o755): string {
  mkdirSync(join(dir.path, subdir), { recursive: true });
  const path = join(dir.path, subdir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, mode);
  return path;
}

describe('findOnPath', () => {
  it('returns the first executable match and skips non-executable files and empty entries', () => {
    tool('a', 'git', 'exit 0', 0o644);
    const second = tool('b', 'git', 'exit 0');
    expect(findOnPath('git', `::${join(dir.path, 'a')}:${join(dir.path, 'b')}`)).toBe(second);
  });

  it('returns null when nothing matches or PATH is unset', () => {
    expect(findOnPath('claude', join(dir.path, 'nowhere'))).toBeNull();
    expect(findOnPath('claude', undefined)).toBeNull();
  });
});

describe('probeVersion', () => {
  it('returns the first non-empty line of --version', async () => {
    const path = tool('bin', 'claude', 'echo; echo "2.1.299 (Claude Code)"; echo extra');
    expect(await probeVersion(path, {})).toBe('2.1.299 (Claude Code)');
  });

  it('runs the tool with the environment it is given, so a launcher found only on that PATH works', async () => {
    tool('login-bin', 'helper', 'echo "9.9.9 (helper)"');
    const path = tool('bin', 'claude', 'exec helper --version');
    const env = { PATH: join(dir.path, 'login-bin') };
    expect(await probeVersion(path, env)).toBe('9.9.9 (helper)');
    expect(await probeVersion(path, { PATH: join(dir.path, 'nowhere') })).toBeNull();
  });

  it('returns null when the tool fails', async () => {
    expect(await probeVersion(tool('bin', 'docker', 'exit 1'), {})).toBeNull();
  });
});

describe('systemCheck', () => {
  it('reports each tool from the login PATH, with the login-env status', async () => {
    const claude = tool('bin', 'claude', 'exit 0');
    const git = tool('bin', 'git', 'exit 0');
    const login: LoginEnv = {
      vars: { PATH: join(dir.path, 'bin') },
      source: 'inherited',
      warning: 'The login shell timed out',
    };
    const report = await systemCheck(login, (path, env) =>
      Promise.resolve(`version of ${path} ${env['PATH'] ?? ''}`),
    );
    expect(report).toEqual({
      loginEnv: { source: 'inherited', warning: 'The login shell timed out' },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        {
          name: 'claude',
          path: claude,
          version: `version of ${claude} ${join(dir.path, 'bin')}`,
          required: true,
        },
        {
          name: 'git',
          path: git,
          version: `version of ${git} ${join(dir.path, 'bin')}`,
          required: true,
        },
        { name: 'docker', path: null, version: null, required: false },
        { name: 'gh', path: null, version: null, required: false },
      ],
    });
  });
});

describe('markGhRequired', () => {
  it('requires gh only while some project delivers pull requests', () => {
    const check = {
      loginEnv: { source: 'login_shell' as const, warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        { name: 'git' as const, path: '/usr/bin/git', version: '2', required: true },
        { name: 'gh' as const, path: null, version: null, required: false },
      ],
    };
    expect(markGhRequired(check, true).tools.map((t) => [t.name, t.required])).toEqual([
      ['git', true],
      ['gh', true],
    ]);
    expect(markGhRequired(check, false).tools.map((t) => [t.name, t.required])).toEqual([
      ['git', true],
      ['gh', false],
    ]);
  });
});

describe('claudeCodeWarning', () => {
  it.each<[string | null, boolean]>([
    ['2.1.302 (Claude Code)', false],
    ['2.9.0 (Claude Code)', false],
    ['1.0.0 (Claude Code)', false],
    ['3.0.0 (Claude Code)', true],
    ['not a version', false],
    [null, false],
  ])('%s warns: %s', (version, warns) => {
    const warning = claudeCodeWarning(version);
    expect(warning !== null).toBe(warns);
    if (warning) expect(warning).toContain('2.1.302');
  });
});
