import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
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
  it("puts Apple's xcrun cache in the temp dir, where /usr/bin/git and make can create it", () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    expect(env['xcrun_db']).toBe(join(tmpDir, 'xcrun_db'));
  });

  it("keeps mise's logs to errors, as its tracked-config write can't land in the read-only state dir", () => {
    expect(prepareCommandEnv(tmpDir, join(root, 'home'), {})['MISE_LOG_LEVEL']).toBe('error');
  });

  it("links the cargo home's bin to the builder's rustup proxies, so mise finds its rust installs", () => {
    const home = join(root, 'home');
    const env = prepareCommandEnv(tmpDir, home, {});
    expect(readlinkSync(join(env['CARGO_HOME'] ?? '', 'bin'))).toBe(join(home, '.cargo', 'bin'));
  });

  it('sets only variables the env allowlist keeps for a sandboxed command', () => {
    const env = prepareCommandEnv(tmpDir, join(root, 'home'), {});
    expect(deniedEnvNames(env)).toEqual([]);
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

  it.each([
    ['the temp dir itself', (dir: string) => dir, false],
    ['a file under it', (dir: string) => join(dir, 'a', 'b'), false],
    ['a sibling that shares its prefix', (dir: string) => `${dir}-other`, true],
    ['a path elsewhere', () => '/usr/bin', true],
    ['a value that is no path', () => '1', true],
  ])('treats %s', (_name, value, kept) => {
    const result = withoutTempDirPaths({ X: value(tmpDir) }, tmpDir);
    expect(Object.keys(result)).toEqual(kept ? ['X'] : []);
  });
});
