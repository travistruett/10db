import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { firstExecutable, installCandidates } from '../git';
import {
  ACCOUNT_NAMES_VERIFIED_ON,
  claudeCodeWarning,
  CODEX_VERIFIED_ON,
  codexWarning,
  markGhRequired,
  probeVersion,
  systemCheck,
  withAgentStatus,
  type AgentStatus,
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
  it('reports the git and gh the daemon resolved, and docker from install prefixes and its own install dir, never the login PATH, and leaves claude and codex to the pinned copies', async () => {
    // Every tool is also on the login PATH, where a lane could have put it: none of those is run.
    for (const name of ['claude', 'codex', 'git', 'gh', 'docker']) tool('bin', name, 'exit 0');
    tool('home/.local/bin', 'claude', 'exit 0');
    const docker = tool('home/.docker/bin', 'docker', 'exit 0');
    const resolved = { git: '/resolved/bin/git', gh: '/resolved/bin/gh' };
    const login: LoginEnv = {
      vars: { PATH: join(dir.path, 'bin') },
      source: 'inherited',
      warning: 'The login shell timed out',
    };
    // This machine's own installs win, judged as the daemon judges them: a link to an install
    // nobody can run, such as one a sandbox can't read, doesn't count.
    const prefixed = (name: string) => firstExecutable(installCandidates(name));
    const report = await systemCheck(login, resolved, {
      home: join(dir.path, 'home'),
      probe: (path, env) => Promise.resolve(`version of ${path} ${env['PATH'] ?? ''}`),
    });
    const version = (path: string) => `version of ${path} ${join(dir.path, 'bin')}`;
    const dockerPath = prefixed('docker') ?? docker;
    expect(report).toEqual({
      loginEnv: { source: 'inherited', warning: 'The login shell timed out' },
      claudeCode: { verifiedOn: ACCOUNT_NAMES_VERIFIED_ON, warning: null },
      codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
      tools: [
        { name: 'claude', path: null, version: null, required: true, signedIn: null },
        { name: 'codex', path: null, version: null, required: false, signedIn: null },
        {
          name: 'git',
          path: resolved.git,
          version: version(resolved.git),
          required: true,
          signedIn: null,
        },
        {
          name: 'docker',
          path: dockerPath,
          version: version(dockerPath),
          required: false,
          signedIn: null,
        },
        {
          name: 'gh',
          path: resolved.gh,
          version: version(resolved.gh),
          required: false,
          signedIn: null,
        },
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
      signedIn: null,
    });
  });

  describe('the gh login', () => {
    const login: LoginEnv = { vars: {}, source: 'login_shell', warning: null };
    const run = (ghLogin: () => Promise<string | null>, gh: string | null = '/resolved/bin/gh') =>
      systemCheck(
        login,
        { git: '/resolved/bin/git', gh },
        { home: join(dir.path, 'home'), probe: () => Promise.resolve('1.0.0'), ghLogin },
      );
    const signedIn = (report: Awaited<ReturnType<typeof run>>) =>
      report.tools.map((t) => [t.name, t.signedIn]);

    it('reports the gh login on the gh row only', async () => {
      expect(signedIn(await run(() => Promise.resolve('octocat')))).toEqual([
        ['claude', null],
        ['codex', null],
        ['git', null],
        ['docker', null],
        ['gh', 'octocat'],
      ]);
    });

    it('leaves signedIn null when gh is signed out', async () => {
      expect(
        (await run(() => Promise.resolve(null))).tools.find((t) => t.name === 'gh')?.signedIn,
      ).toBeNull();
    });

    it('leaves signedIn null when the probe throws, keeping the gh row', async () => {
      const report = await run(() => Promise.reject(new Error('no network')));
      expect(report.tools.find((t) => t.name === 'gh')).toEqual({
        name: 'gh',
        path: '/resolved/bin/gh',
        version: '1.0.0',
        required: false,
        signedIn: null,
      });
    });

    it('does not probe when no gh is installed', async () => {
      let probed = 0;
      await run(() => {
        probed += 1;
        return Promise.resolve('octocat');
      }, null);
      expect(probed).toBe(0);
    });
  });
});

describe('withAgentStatus', () => {
  const base = async () => {
    // The builder's own installs, in the places the daemon used to look: neither is run or reported.
    tool('home/.local/bin', 'claude', 'echo "9.9.9 (Claude Code)"');
    tool('opt/homebrew/bin', 'codex', 'echo "codex-cli 0.1.0"');
    const login: LoginEnv = { vars: {}, source: 'login_shell', warning: null };
    return systemCheck(
      login,
      { git: '/usr/bin/git', gh: null },
      {
        home: join(dir.path, 'home'),
        probe: () => Promise.resolve('1.0.0'),
      },
    );
  };
  const status = (over: Partial<AgentStatus>): AgentStatus => ({
    tool: 'claude',
    label: 'Claude Code',
    pinned: '2.1.302',
    state: 'ready',
    path: '/data/tools/claude-2.1.302-darwin-arm64/claude',
    version: '2.1.302 (Claude Code)',
    problem: null,
    newerRelease: null,
    ...over,
  });

  it('names the pinned copy and the version it runs for each agent, whatever else is installed', async () => {
    const checked = withAgentStatus(await base(), [
      status({}),
      status({
        tool: 'codex',
        label: 'Codex',
        pinned: CODEX_VERIFIED_ON,
        path: '/data/tools/codex/bin/codex',
        version: `codex-cli ${CODEX_VERIFIED_ON}`,
      }),
    ]);
    const row = (name: string) => checked.tools.find((t) => t.name === name);
    expect(row('claude')).toMatchObject({
      path: '/data/tools/claude-2.1.302-darwin-arm64/claude',
      version: '2.1.302 (Claude Code)',
    });
    expect(row('codex')).toMatchObject({
      path: '/data/tools/codex/bin/codex',
      version: `codex-cli ${CODEX_VERIFIED_ON}`,
    });
    expect(checked.claudeCode.warning).toBeNull();
    expect(checked.codex.warning).toBeNull();
  });

  it('has no path for an agent whose copy is not ready, and says why', async () => {
    const checked = withAgentStatus(await base(), [
      status({
        state: 'refused',
        path: null,
        version: null,
        problem: 'Claude Code 2.1.302 was refused: checksum mismatch',
      }),
      status({ tool: 'codex', label: 'Codex', state: 'fetching', path: null, version: null }),
    ]);
    expect(checked.tools.filter((t) => t.name === 'claude' || t.name === 'codex')).toEqual([
      expect.objectContaining({ name: 'claude', path: null, version: null }),
      expect.objectContaining({ name: 'codex', path: null, version: null }),
    ]);
    expect(checked.agents).toEqual([
      expect.objectContaining({
        tool: 'claude',
        state: 'refused',
        problem: 'Claude Code 2.1.302 was refused: checksum mismatch',
      }),
      expect.objectContaining({ tool: 'codex', state: 'fetching', problem: null }),
    ]);
  });

  it('carries the newer upstream release beside the pinned one, and drops it once the pin has caught up', async () => {
    const newer = withAgentStatus(await base(), [status({ newerRelease: '2.1.319' })]);
    expect(newer.agents).toEqual([
      expect.objectContaining({ pinned: '2.1.302', newerRelease: '2.1.319' }),
    ]);
    const caughtUp = withAgentStatus(newer, [
      status({ pinned: '2.1.319', version: '2.1.319 (Claude Code)', newerRelease: null }),
    ]);
    expect(caughtUp.agents).toEqual([
      expect.objectContaining({ pinned: '2.1.319', newerRelease: null }),
    ]);
  });

  it('warns when a path given in place of the pinned copy is a newer major version', async () => {
    const checked = withAgentStatus(await base(), [status({ version: '3.0.0 (Claude Code)' })]);
    expect(checked.claudeCode.warning).toContain('3.0.0');
  });
});

describe('markGhRequired', () => {
  it('requires gh only while some project delivers pull requests', () => {
    const check = {
      loginEnv: { source: 'login_shell' as const, warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
      tools: [
        {
          name: 'git' as const,
          path: '/usr/bin/git',
          version: '2',
          required: true,
          signedIn: null,
        },
        { name: 'gh' as const, path: null, version: null, required: false, signedIn: null },
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
    if (warning) expect(warning).toContain(ACCOUNT_NAMES_VERIFIED_ON);
  });
});

describe('codexWarning', () => {
  it.each<[string, string | null, boolean]>([
    ['the verified version', `codex-cli ${CODEX_VERIFIED_ON}`, false],
    ['a newer version', 'codex-cli 999.0.0', true],
    ['an older version', 'codex-cli 0.0.1', true],
    ['output with no version', 'not a version', false],
    ['no version at all', null, false],
  ])('%s: warns %s', (_name, version, warns) => {
    const warning = codexWarning(version);
    expect(warning !== null).toBe(warns);
    if (warning) expect(warning).toContain(CODEX_VERIFIED_ON);
  });
});
