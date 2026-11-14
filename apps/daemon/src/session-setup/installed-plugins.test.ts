import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { InstalledPluginsError, readInstalledPlugins } from './installed-plugins';

let root: TempDir;
let home: string;

beforeEach(() => {
  root = tempDir('installed-plugins');
  home = realpathSync(root.path);
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
});

afterEach(() => {
  root.cleanup();
});

function entry(scope: string, name: string, version: string): Record<string, string> {
  return {
    scope,
    installPath: join(home, `.claude/plugins/cache/m/${name}/${version}`),
    version,
    installedAt: '2026-11-01T00:00:00.000Z',
    gitCommitSha: 'abc',
  };
}

function writeList(plugins: Record<string, unknown[]>, version: unknown = 2): void {
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({ version, plugins }),
  );
}

function writeSettings(settings: unknown): void {
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(settings));
}

describe('readInstalledPlugins', () => {
  it('reads a user-scope plugin with its install path and version', () => {
    writeList({ 'p@m': [entry('user', 'p', '1.2.0')] });
    expect(readInstalledPlugins(home)).toEqual([
      {
        id: 'p@m',
        name: 'p',
        version: '1.2.0',
        installPath: join(home, '.claude/plugins/cache/m/p/1.2.0'),
        enabledInClaude: true,
      },
    ]);
  });

  it('leaves out project and local scope', () => {
    writeList({
      'p@m': [entry('project', 'p', '1'), entry('user', 'p', '2')],
      'q@m': [entry('local', 'q', '1')],
    });
    expect(readInstalledPlugins(home).map((p) => [p.id, p.version])).toEqual([['p@m', '2']]);
  });

  it('enabledPlugins false marks it off; unnamed counts as on', () => {
    writeList({ 'p@m': [entry('user', 'p', '1')], 'q@m': [entry('user', 'q', '1')] });
    writeSettings({ enabledPlugins: { 'p@m': false } });
    expect(readInstalledPlugins(home).map((p) => [p.id, p.enabledInClaude])).toEqual([
      ['p@m', false],
      ['q@m', true],
    ]);
  });

  it('no list is empty', () => {
    expect(readInstalledPlugins(home)).toEqual([]);
  });

  it('a list of another version throws InstalledPluginsError', () => {
    writeList({ 'p@m': [entry('user', 'p', '1')] }, 3);
    expect(() => readInstalledPlugins(home)).toThrow(InstalledPluginsError);
  });

  it('reads no other key of settings.json', () => {
    writeList({ 'p@m': [entry('user', 'p', '1')] });
    writeSettings({
      env: { PATH: 42, ANTHROPIC_MODEL: ['odd'] },
      permissions: 'everything',
      hooks: null,
      enabledPlugins: { 'p@m': false },
    });
    expect(readInstalledPlugins(home).map((p) => p.enabledInClaude)).toEqual([false]);
  });
});
