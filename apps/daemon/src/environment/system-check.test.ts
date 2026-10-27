import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import {
  claudeCodeWarning,
  findClaude,
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
  it('reports the git and gh the daemon resolved, and claude and docker from install prefixes and their own install dirs, never the login PATH', async () => {
    // Every tool is also on the login PATH, where a lane could have put it: none of those is run.
    for (const name of ['claude', 'git', 'gh', 'docker']) tool('bin', name, 'exit 0');
    const claude = tool('home/.local/bin', 'claude', 'exit 0');
    const docker = tool('home/.docker/bin', 'docker', 'exit 0');
    const resolved = { git: '/resolved/bin/git', gh: '/resolved/bin/gh' };
    const login: LoginEnv = {
      vars: { PATH: join(dir.path, 'bin') },
      source: 'inherited',
      warning: 'The login shell timed out',
    };
    const prefixed = (name: string) =>
      ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
        .map((prefix) => join(prefix, name))
        .find((p) => existsSync(p));
    const report = await systemCheck(login, resolved, {
      home: join(dir.path, 'home'),
      probe: (path, env) => Promise.resolve(`version of ${path} ${env['PATH'] ?? ''}`),
    });
    const version = (path: string) => `version of ${path} ${join(dir.path, 'bin')}`;
    const claudePath = prefixed('claude') ?? claude;
    const dockerPath = prefixed('docker') ?? docker;
    expect(report).toEqual({
      loginEnv: { source: 'inherited', warning: 'The login shell timed out' },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        { name: 'claude', path: claudePath, version: version(claudePath), required: true },
        { name: 'git', path: resolved.git, version: version(resolved.git), required: true },
        { name: 'docker', path: dockerPath, version: version(dockerPath), required: false },
        { name: 'gh', path: resolved.gh, version: version(resolved.gh), required: false },
      ],
      // The services layer fills this per request; the environment check reports no benchmark warning.
      benchmarkSync: null,
    });
  });

  it('reports gh missing when the daemon resolved none', async () => {
    const login: LoginEnv = { vars: {}, source: 'login_shell', warning: null };
    const report = await systemCheck(
      login,
      { git: '/resolved/bin/git', gh: null },
      { home: join(dir.path, 'home'), probe: () => Promise.resolve('1.0.0') },
    );
    expect(report.tools.find((t) => t.name === 'gh')).toEqual({
      name: 'gh',
      path: null,
      version: null,
      required: false,
    });
  });
});

describe('findClaude', () => {
  it.each([
    { name: "Claude Code's native install", at: '.local/bin' },
    { name: 'the older local install', at: '.claude/local' },
  ])('finds claude in $name when no install prefix has it', ({ at }) => {
    const path = tool(join('home', at), 'claude', 'exit 0');
    const prefixed = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      .map((prefix) => join(prefix, 'claude'))
      .find((p) => existsSync(p));
    expect(findClaude(join(dir.path, 'home'))).toBe(prefixed ?? path);
  });
});

describe('systemCheck version warning', () => {
  it('warns when the installed claude has a newer major version', async () => {
    tool('home/.local/bin', 'claude', 'exit 0');
    const login: LoginEnv = { vars: {}, source: 'login_shell', warning: null };
    const report = await systemCheck(
      login,
      { git: '/usr/bin/git', gh: null },
      {
        home: join(dir.path, 'home'),
        probe: (path) => Promise.resolve(path.endsWith('claude') ? '3.0.0 (Claude Code)' : null),
      },
    );
    expect(report.claudeCode.warning).toContain('3.0.0');
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
      benchmarkSync: null,
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
