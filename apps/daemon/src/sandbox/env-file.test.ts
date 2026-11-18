import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLaneEnvFile,
  removeLaneEnvFile,
  SandboxProfileError,
  SandboxTempDirError,
} from './index';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sbe-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The variables `/bin/sh` holds after running `file`'s content in an otherwise empty env. */
function sourced(file: string): Record<string, string> {
  const out = execFileSync('/bin/sh', [], {
    input: `${readFileSync(file, 'utf8')}exec /usr/bin/env -0\n`,
    env: {},
    encoding: 'utf8',
  });
  return Object.fromEntries(
    out
      .split('\0')
      .filter((entry) => entry !== '')
      .map((entry) => {
        const at = entry.indexOf('=');
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
  );
}

const LANE_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  CARGO_HOME: '/private/tmp/10db-abc/cache/cargo',
  npm_config_cache: '/private/tmp/10db-abc/cache/npm',
  MISE_CONFIG_DIR: '/private/tmp/10db-abc/mise',
};

describe('lane env file', () => {
  it('exports every variable it is given, read-only to its owner', () => {
    const file = createLaneEnvFile(LANE_ENV, root);
    expect(dirname(file)).toBe(root);
    expect(statSync(file).mode & 0o777).toBe(0o400);
    const vars = sourced(file);
    for (const [name, value] of Object.entries(LANE_ENV)) expect(vars[name], name).toBe(value);
  });

  it('carries a value with shell metacharacters through /bin/sh unchanged', () => {
    for (const [name, value] of [
      ['a single quote', "it's"],
      ['quotes of both kinds', `a'b"c'`],
      ['a dollar sign and braces', '$HOME ${PATH}'],
      ['backticks and a command substitution', '`id` $(id)'],
      ['a backslash', 'a\\b\\'],
      ['spaces and a glob', 'a b *'],
      ['a semicolon and an ampersand', 'a; b & c'],
      ['an empty value', ''],
      ['non-ASCII text', 'café ☕'],
    ] as const) {
      const file = createLaneEnvFile({ VALUE: value }, root);
      expect.soft(sourced(file)['VALUE'], name).toBe(value);
    }
  });

  it('refuses a variable with a control character or a bad name and writes no file', () => {
    for (const [name, env] of [
      ['a newline', { A: 'a\nexport B=1' }],
      ['a carriage return', { A: 'a\rb' }],
      ['a NUL', { A: 'a\0b' }],
      ['an escape', { A: 'a\u001bb' }],
      ['a DEL', { A: 'a\u007fb' }],
      ['a name with a space', { 'A B': 'x' }],
      ['a name with a quote', { "A'": 'x' }],
      ['a name that starts with a digit', { '1A': 'x' }],
      ['an empty name', { '': 'x' }],
    ] as const) {
      expect.soft(() => createLaneEnvFile(env, root), name).toThrow(SandboxProfileError);
      expect.soft(readdirSync(root), name).toEqual([]);
    }
  });

  it('names the variable it refuses, never its value', () => {
    expect(() => createLaneEnvFile({ CARGO_HOME: 'secret\nvalue' }, root)).toThrow(/CARGO_HOME/);
    expect(() => createLaneEnvFile({ CARGO_HOME: 'secret\nvalue' }, root)).not.toThrow(/secret/);
  });

  it('gives each session its own file', () => {
    expect(createLaneEnvFile(LANE_ENV, root)).not.toBe(createLaneEnvFile(LANE_ENV, root));
  });

  it('removes the file, and does nothing when it is already gone', () => {
    const file = createLaneEnvFile(LANE_ENV, root);
    removeLaneEnvFile(file, root);
    expect(existsSync(file)).toBe(false);
    expect(() => {
      removeLaneEnvFile(file, root);
    }).not.toThrow();
  });

  it('refuses to remove a file outside the root or without the prefix', () => {
    writeFileSync(join(root, 'other.sh'), 'x');
    for (const [name, path] of [
      ['a file outside the root', join(root, 'x', '10db-env-a.sh')],
      ['a file without the prefix', join(root, 'other.sh')],
    ] as const) {
      expect
        .soft(() => {
          removeLaneEnvFile(path, root);
        }, name)
        .toThrow(SandboxTempDirError);
      expect.soft(readFileSync(join(root, 'other.sh'), 'utf8'), name).toBe('x');
    }
  });
});
