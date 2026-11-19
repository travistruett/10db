import { describe, expect, it } from 'vitest';
import { isTrustedKey, parseConfigNames, parseScopedConfig } from './config-trust';
import { withDaemonGitConfig } from './daemon-config';

describe('isTrustedKey', () => {
  it('trusts the keys the allowlist names, any key of a branch section included', () => {
    for (const name of [
      'core.repositoryformatversion',
      'core.hookspath',
      'user.email',
      'remote.origin.url',
      'remote.my.fork.url',
      'remote.origin.gh-resolved',
      'branch.feat/x.merge',
      'branch.feat/x.anything-an-editor-adds',
      'lfs.https://h/x.git/info/lfs.access',
      'lfs.https://h/x.git/info/lfs.locksverify',
    ])
      expect.soft(isTrustedKey(name), name).toBe(true);
  });

  it('refuses every key the allowlist does not name, and a name that is no key', () => {
    for (const name of [
      'core.worktree',
      'core.sshcommand',
      'remote.origin.receivepack',
      'remote.origin.vcs',
      'url.https://evil/.insteadof',
      'filter.lfs.process',
      'lfs.url',
      'submodule.lib.update',
      'gc.recentobjectshook',
      'credential.helper',
      // A subsection that names a trusted section and key elsewhere is still judged by its own section.
      'url.core.hookspath',
      'core',
      '.url',
      'remote.origin.',
    ])
      expect.soft(isTrustedKey(name), name).toBe(false);
  });
});

describe('config list parsing', () => {
  it('reads scope, origin, name and value, and names', () => {
    expect(
      parseScopedConfig(
        'local\0file:.git/config\0core.bare\nfalse\0global\0file:/h/.gitconfig\0user.name\nA B\0local\0file:.git/config\0core.flag\0',
      ),
    ).toEqual([
      { scope: 'local', origin: 'file:.git/config', name: 'core.bare', value: 'false' },
      { scope: 'global', origin: 'file:/h/.gitconfig', name: 'user.name', value: 'A B' },
      { scope: 'local', origin: 'file:.git/config', name: 'core.flag', value: null },
    ]);
    expect(parseConfigNames('core.bare\0filter.x.clean\0')).toEqual([
      'core.bare',
      'filter.x.clean',
    ]);
  });
});

describe('withDaemonGitConfig', () => {
  it("appends fsmonitor off and hooks off after the login environment's own entries", () => {
    const ROWS = [
      {
        name: 'no config in the environment',
        env: { PATH: '/bin' },
        expected: {
          PATH: '/bin',
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.fsmonitor',
          GIT_CONFIG_VALUE_0: 'false',
          GIT_CONFIG_KEY_1: 'core.hooksPath',
          GIT_CONFIG_VALUE_1: '/dev/null',
        },
      },
      {
        name: "the login environment's own entries, kept first",
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'me' },
        expected: {
          GIT_CONFIG_COUNT: '3',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'me',
          GIT_CONFIG_KEY_1: 'core.fsmonitor',
          GIT_CONFIG_VALUE_1: 'false',
          GIT_CONFIG_KEY_2: 'core.hooksPath',
          GIT_CONFIG_VALUE_2: '/dev/null',
        },
      },
      {
        name: 'a count git would reject',
        env: { GIT_CONFIG_COUNT: 'x' },
        expected: {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.fsmonitor',
          GIT_CONFIG_VALUE_0: 'false',
          GIT_CONFIG_KEY_1: 'core.hooksPath',
          GIT_CONFIG_VALUE_1: '/dev/null',
        },
      },
    ];
    for (const { name, env, expected } of ROWS)
      expect.soft(withDaemonGitConfig(env), name).toEqual(expected);
  });
});
