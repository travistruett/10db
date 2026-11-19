import { existsSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareCommandEnv, withoutTempDirPaths } from './command-env';
import { deniedEnvNames } from './env-allowlist';

let root: string;
let tmpDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cmd-')));
  tmpDir = join(root, 'lane');
  mkdirSync(tmpDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepareCommandEnv tool-cache variables', () => {
  it("puts xcrun's cache in the temp dir, keeps mise's logs to errors, and sets only allowlisted variables", () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    // /usr/bin/git and make create xcrun's cache; mise's tracked-config write can't land in the
    // read-only state dir.
    expect.soft(env['xcrun_db'], 'xcrun_db').toBe(join(tmpDir, 'xcrun_db'));
    expect.soft(env['MISE_LOG_LEVEL'], 'MISE_LOG_LEVEL').toBe('error');
    expect.soft(deniedEnvNames(env), 'names the env allowlist denies').toEqual([]);
  });

  it("links the cargo home's bin to the builder's rustup proxies only when the builder has ~/.cargo/bin", () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.cargo', 'bin'), { recursive: true });
    const env = prepareCommandEnv(tmpDir, home, {});
    expect
      .soft(readlinkSync(join(env['CARGO_HOME'] ?? '', 'bin')), 'a home with ~/.cargo/bin')
      .toBe(join(home, '.cargo', 'bin'));
    const bareLane = join(root, 'bare-lane');
    mkdirSync(bareLane);
    const bare = prepareCommandEnv(bareLane, join(root, 'bare'), {});
    expect.soft(existsSync(bare['CARGO_HOME'] ?? ''), 'a home with no ~/.cargo/bin').toBe(false);
  });
});

describe('withoutTempDirPaths', () => {
  it('keeps only the variables whose value names nothing the lane can write', () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    const kept = withoutTempDirPaths(env, tmpDir);
    // Each of these makes a tool that Claude Code or its git runs outside the sandbox read or exec
    // what a lane wrote into its temp dir: mise's `[env] _.source`, xcrun's cache, git's and
    // Claude Code's own config under XDG_CONFIG_HOME, cargo's `rustc-wrapper`.
    for (const name of [
      'xcrun_db',
      'MISE_CONFIG_DIR',
      'MISE_GLOBAL_CONFIG_FILE',
      'MISE_SYSTEM_DIR',
      'MISE_SYSTEM_CONFIG_FILE',
      'XDG_CONFIG_HOME',
      'CARGO_HOME',
      'npm_config_cache',
    ])
      expect(Object.keys(kept), name).not.toContain(name);
    expect(kept).toEqual({
      MISE_LOG_LEVEL: 'error',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      TENDB_SANDBOX: '1',
    });
  });

  it('drops a value at or under the temp dir and keeps any other', () => {
    const rows: [string, (dir: string) => string, boolean][] = [
      ['the temp dir itself', (dir) => dir, false],
      ['a file under it', (dir) => join(dir, 'a', 'b'), false],
      ['a sibling that shares its prefix', (dir) => `${dir}-other`, true],
      ['a path elsewhere', () => '/usr/bin', true],
      ['a value that is no path', () => '1', true],
    ];
    for (const [name, value, kept] of rows) {
      const result = withoutTempDirPaths({ X: value(tmpDir) }, tmpDir);
      expect.soft(Object.keys(result), name).toEqual(kept ? ['X'] : []);
    }
  });
});
