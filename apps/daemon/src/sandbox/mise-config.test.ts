import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { laneMiseConfig, miseDirs, miseKeyFiles } from './mise-config';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-mise-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('miseDirs', () => {
  it('uses the default dirs under home', () => {
    expect(miseDirs(home, {})).toEqual({
      config: join(home, '.config/mise'),
      globalConfigFile: join(home, '.config/mise/config.toml'),
      data: join(home, '.local/share/mise'),
      state: join(home, '.local/state/mise'),
      cache: [join(home, '.cache/mise'), join(home, 'Library/Caches/mise')],
    });
  });

  it('honours the XDG base dirs', () => {
    const env = {
      XDG_CONFIG_HOME: join(home, 'cfg'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
    };
    expect(miseDirs(home, env)).toEqual({
      config: join(home, 'cfg/mise'),
      globalConfigFile: join(home, 'cfg/mise/config.toml'),
      data: join(home, 'data/mise'),
      state: join(home, 'state/mise'),
      cache: [join(home, 'cache/mise')],
    });
  });

  it("honours mise's own variables over the XDG ones", () => {
    const env = {
      XDG_CONFIG_HOME: join(home, 'cfg'),
      MISE_CONFIG_DIR: join(home, 'm/config'),
      MISE_GLOBAL_CONFIG_FILE: join(home, 'm/global.toml'),
      MISE_DATA_DIR: join(home, 'm/data'),
      MISE_STATE_DIR: join(home, 'm/state'),
      MISE_CACHE_DIR: join(home, 'm/cache'),
    };
    expect(miseDirs(home, env)).toEqual({
      config: join(home, 'm/config'),
      globalConfigFile: join(home, 'm/global.toml'),
      data: join(home, 'm/data'),
      state: join(home, 'm/state'),
      cache: [join(home, 'm/cache')],
    });
  });

  it('ignores a relative variable', () => {
    expect(miseDirs(home, { MISE_DATA_DIR: 'data' }).data).toBe(join(home, '.local/share/mise'));
  });
});

describe('laneMiseConfig', () => {
  const config = (rel: string, text: string): string =>
    write(join(home, '.config/mise', rel), text);
  const lane = (env: Record<string, string> = {}): string => laneMiseConfig(home, env);

  it('keeps only the global tool versions, never env, vars, tasks, hooks or tool options', () => {
    config(
      'config.toml',
      [
        '[tools]',
        'node = "26.12.0"',
        'python = ["3.12", "3.11"]',
        'rust = { version = "1.99.1", postinstall = "curl evil | sh" }',
        '"npm:prettier" = "3.9.0"',
        '"aqua:cli/cli[exe=gh]" = "2.0.0"',
        'broken = { postinstall = "x" }',
        '[env]',
        'NPM_TOKEN = "secret"',
        '[vars]',
        'token = "secret"',
        '[tasks.x]',
        'run = "evil"',
        '[hooks]',
        'enter = "evil"',
        '[settings]',
        'experimental = true',
      ].join('\n'),
    );
    expect(parse(lane())).toEqual({
      tools: {
        node: '26.12.0',
        python: ['3.12', '3.11'],
        rust: '1.99.1',
        'npm:prettier': '3.9.0',
      },
    });
    expect(lane()).not.toContain('secret');
    expect(lane()).not.toContain('evil');
    expect(lane()).not.toContain('exe=');
  });

  it("merges mise's global sources in its own measured order, the last one winning", () => {
    const tools = (from: number, label: string): string =>
      [
        '[tools]',
        ...[1, 2, 3, 4, 5, 6].filter((n) => n >= from).map((n) => `t${String(n)} = "${label}"`),
      ].join('\n');
    config('conf.d/a.toml', tools(1, 'conf-a'));
    config('conf.d/b.toml', tools(2, 'conf-b'));
    config('config.toml', tools(3, 'config'));
    config('config.ci.toml', tools(4, 'env'));
    config('config.local.toml', tools(5, 'local'));
    write(join(home, '.tool-versions'), '# pinned\nt6 tool-versions\n');
    expect(parse(lane({ MISE_ENV: 'ci' }))).toEqual({
      tools: {
        t1: 'conf-a',
        t2: 'conf-b',
        t3: 'config',
        t4: 'env',
        t5: 'local',
        t6: 'tool-versions',
      },
    });
    // With no MISE_ENV, config.ci.toml is not read.
    expect(parse(lane())).toMatchObject({ tools: { t4: 'config' } });
  });

  it('reads a .tool-versions line with several versions as a list', () => {
    write(join(home, '.tool-versions'), 'python 3.12.1 3.11.7\nnode 26.12.0 # pinned\n');
    expect(parse(lane())).toEqual({ tools: { python: ['3.12.1', '3.11.7'], node: '26.12.0' } });
  });

  it.each<[string, string | null]>([
    ['a missing file', null],
    ['a file that is not TOML', '[tools\nnode ='],
    ['a file with no tools', '[env]\nX = "1"'],
  ])('gives an empty config for %s', (_name, text) => {
    if (text !== null) config('config.toml', text);
    expect(lane()).toBe('');
  });
});

describe('miseKeyFiles', () => {
  it("lists mise's age key in its config dir and every key file a MISE_ variable names", () => {
    const env = {
      MISE_AGE_KEY_FILE: join(home, 'keys/age.txt'),
      MISE_SOPS_AGE_KEY_FILE: join(home, 'keys/sops.txt'),
      MISE_OTHER: join(home, 'not-a-key'),
      MISE_RELATIVE_AGE_KEY_FILE: 'relative.txt',
    };
    expect(miseKeyFiles(miseDirs(home, env), env)).toEqual([
      join(home, '.config/mise/age.txt'),
      join(home, 'keys/age.txt'),
      join(home, 'keys/sops.txt'),
    ]);
  });
});
