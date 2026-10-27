import { describe, expect, it } from 'vitest';
import { isTrustedKey, parseConfigNames, parseScopedConfig } from './config-trust';
import { withDaemonGitConfig } from './daemon-config';

describe('isTrustedKey', () => {
  it.each([
    { name: 'core.repositoryformatversion', trusted: true },
    { name: 'core.hookspath', trusted: true },
    { name: 'user.email', trusted: true },
    { name: 'remote.origin.url', trusted: true },
    { name: 'remote.my.fork.url', trusted: true },
    { name: 'remote.origin.gh-resolved', trusted: true },
    { name: 'branch.feat/x.merge', trusted: true },
    { name: 'branch.feat/x.anything-an-editor-adds', trusted: true },
    { name: 'lfs.https://h/x.git/info/lfs.access', trusted: true },
    {
      name: 'lfs.https://h/x.git/info/lfs.locksverify',
      trusted: true,
    },
    { name: 'core.worktree', trusted: false },
    { name: 'core.sshcommand', trusted: false },
    { name: 'remote.origin.receivepack', trusted: false },
    { name: 'remote.origin.vcs', trusted: false },
    { name: 'url.https://evil/.insteadof', trusted: false },
    { name: 'filter.lfs.process', trusted: false },
    { name: 'lfs.url', trusted: false },
    { name: 'submodule.lib.update', trusted: false },
    { name: 'gc.recentobjectshook', trusted: false },
    { name: 'credential.helper', trusted: false },
    // A subsection that names a trusted section and key elsewhere is still judged by its own section.
    { name: 'url.core.hookspath', trusted: false },
    { name: 'core', trusted: false },
    { name: '.url', trusted: false },
    { name: 'remote.origin.', trusted: false },
  ])('$name: $trusted', ({ name, trusted }) => {
    expect(isTrustedKey(name)).toBe(trusted);
  });
});

describe('config list parsing', () => {
  it('reads scope, origin, name and value', () => {
    expect(
      parseScopedConfig(
        'local\0file:.git/config\0core.bare\nfalse\0global\0file:/h/.gitconfig\0user.name\nA B\0local\0file:.git/config\0core.flag\0',
      ),
    ).toEqual([
      { scope: 'local', origin: 'file:.git/config', name: 'core.bare', value: 'false' },
      { scope: 'global', origin: 'file:/h/.gitconfig', name: 'user.name', value: 'A B' },
      { scope: 'local', origin: 'file:.git/config', name: 'core.flag', value: null },
    ]);
  });

  it('reads names', () => {
    expect(parseConfigNames('core.bare\0filter.x.clean\0')).toEqual([
      'core.bare',
      'filter.x.clean',
    ]);
  });
});

describe('withDaemonGitConfig', () => {
  it.each([
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
  ])('appends to $name', ({ env, expected }) => {
    expect(withDaemonGitConfig(env)).toEqual(expected);
  });
});
