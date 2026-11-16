import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { TakeoverRefusedError, type TakeoverCommand } from '../sessions';
import { renderTakeover } from './render';

// Sessions spec §7.5: what the terminal runs is exactly the command: nothing in a value is shell syntax, no key is
// inlined, and no billing switch of the builder's shell survives.

let dir: ReturnType<typeof tempDir>;
afterEach(() => {
  dir.cleanup();
});

const BASE: TakeoverCommand = {
  cwd: '/work/repo',
  unset: ['ANTHROPIC_API_KEY', 'CLAUDECODE'],
  unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'TENDB_'],
  set: { CLAUDE_CONFIG_DIR: '/data/accounts/a/claude' },
  keychain: [],
  sources: [],
  argv: ['/pinned/claude', '--resume', 'abc-123'],
};

describe('the script and the line, as text', () => {
  it('deletes itself first, then runs the lines in order', () => {
    dir = tempDir('render');
    const { script } = renderTakeover({
      ...BASE,
      keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }],
      sources: ['/data/t/sealed.env'],
    });
    const lines = script.split('\n');
    expect(lines.slice(0, 3)).toEqual(['#!/bin/sh', 'rm -- "$0"', "cd -- '/work/repo' || exit 1"]);
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(at('ANTHROPIC_DEFAULT_')).toBeLessThan(at('TENDB_'));
    expect(at('TENDB_')).toBeLessThan(at(". '/data/t/sealed.env'"));
    expect(lines[at(". '/data/t/sealed.env'") + 1]).toBe("rm -- '/data/t/sealed.env'");
    expect(at(". '/data/t/sealed.env'")).toBeLessThan(at('find-generic-password'));
    expect(at('find-generic-password')).toBeLessThan(at('export AWS_BEARER_TOKEN_BEDROCK'));
    expect(at('export AWS_BEARER_TOKEN_BEDROCK')).toBeLessThan(at('/usr/bin/env -u'));
    expect(lines[at('/usr/bin/env -u')]).toBe(
      "/usr/bin/env -u 'ANTHROPIC_API_KEY' -u 'CLAUDECODE' -- 'CLAUDE_CONFIG_DIR=/data/accounts/a/claude' '/pinned/claude' '--resume' 'abc-123'",
    );
    expect(lines.at(-2)).toBe("echo 'Back in 10db, click Hand Back.'");
  });

  it('reads a key through the Keychain into an exported variable, never writing a value', () => {
    dir = tempDir('render');
    const { script, line } = renderTakeover({
      ...BASE,
      keychain: [{ variable: 'AWS_BEARER_TOKEN_BEDROCK', account: 'account:k' }],
    });
    expect(script).toContain(
      "AWS_BEARER_TOKEN_BEDROCK=$(/usr/bin/security find-generic-password -s 10db -a 'account:k' -w)",
    );
    // The line quotes the whole body once more.
    expect(line).toContain(
      'AWS_BEARER_TOKEN_BEDROCK=$(/usr/bin/security find-generic-password -s 10db -a ',
    );
    expect(line).toContain('; export AWS_BEARER_TOKEN_BEDROCK;');
  });

  it('makes the line a /bin/sh -c of the same commands, without the deletion', () => {
    dir = tempDir('render');
    const { line, script } = renderTakeover(BASE);
    expect(line.startsWith("/bin/sh -c '")).toBe(true);
    expect(line).not.toContain('rm --');
    expect(line).not.toContain('\n');
    expect(script).toContain('rm --');
  });
});

describe('NUL and names', () => {
  it.each<[string, Partial<TakeoverCommand>]>([
    ['the folder', { cwd: '/work\0repo' }],
    ['an argument', { argv: ['/bin/x', 'a\0b'] }],
    ['a value', { set: { A: 'a\0b' } }],
    ['an argument file', { argv: ['/bin/x', { prefix: '', file: '/f\0' }] }],
    ['an argument prefix', { argv: ['/bin/x', { prefix: 'a\0', file: '/f' }] }],
    ['a set name', { set: { 'A B': 'x' } }],
    ['an unset name', { unset: ['A;B'] }],
    ['an unset prefix', { unsetPrefixes: ["A'"] }],
    ['a Keychain variable', { keychain: [{ variable: 'A B', account: 'x' }] }],
    ['an empty command', { argv: [] }],
  ])('refuses %s', (_name, change) => {
    dir = tempDir('render');
    expect(() => renderTakeover({ ...BASE, ...change })).toThrow(TakeoverRefusedError);
  });
});

/** A stub that records what it was run with, in the temp directory. */
function stub(): { path: string; args: () => string[]; names: () => string[]; inj: () => string } {
  const path = join(dir.path, 'stub');
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\0' "$@" > '${dir.path}/args'
printf '%s' "$INJ" > '${dir.path}/inj'
/usr/bin/env | /usr/bin/sed 's/=.*//' > '${dir.path}/names'
`,
  );
  chmodSync(path, 0o700);
  return {
    path,
    args: () => readFileSync(join(dir.path, 'args'), 'utf8').split('\0').slice(0, -1),
    names: () => readFileSync(join(dir.path, 'names'), 'utf8').split('\n'),
    inj: () => readFileSync(join(dir.path, 'inj'), 'utf8'),
  };
}

/** Values that would break quoting or become an option. */
const INJECTIONS = [
  "it's",
  '$(touch PWNED)',
  '`touch PWNED`',
  'a\nb',
  '--dangerous',
  '"quoted" and \\ and $HOME',
  'tab\there; rm -rf /',
  '',
];

describe('run under /bin/sh', () => {
  const run = (cmd: TakeoverCommand, how: 'script' | 'line', env: Record<string, string>): void => {
    const { script, line } = renderTakeover(cmd);
    const scriptPath = join(dir.path, 'takeover.command');
    writeFileSync(scriptPath, script, { mode: 0o700 });
    if (how === 'script') {
      execFileSync('/bin/sh', ['-n', scriptPath]);
      execFileSync('/bin/sh', [scriptPath], { env, stdio: 'pipe' });
      expect(existsSync(scriptPath)).toBe(false);
    } else execFileSync('/bin/sh', ['-c', line], { env, stdio: 'pipe' });
  };

  it.each(['script', 'line'] as const)(
    'hands each injection value to the program byte for byte (%s)',
    (how) => {
      dir = tempDir('render');
      const s = stub();
      const file = join(dir.path, 'instructions.txt');
      for (const value of INJECTIONS) {
        writeFileSync(file, value);
        run(
          {
            cwd: dir.path,
            unset: [],
            unsetPrefixes: [],
            set: { INJ: value },
            keychain: [],
            sources: [],
            argv: [s.path, value, { prefix: `--x=${value}`, file }, '--', 'tail'],
          },
          how,
          { PATH: '/usr/bin:/bin', HOME: dir.path },
        );
        expect(s.args()).toEqual([value, `--x=${value}${value}`, '--', 'tail']);
        expect(s.inj()).toBe(value);
        expect(existsSync(join(dir.path, 'PWNED'))).toBe(false);
      }
    },
  );

  it.each(['script', 'line'] as const)(
    'leaves out every unset name and prefix, and keeps what the builder exported (%s)',
    (how) => {
      dir = tempDir('render');
      const s = stub();
      run(
        {
          cwd: dir.path,
          unset: ['CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID'],
          unsetPrefixes: ['ANTHROPIC_DEFAULT_', 'TENDB_'],
          set: {},
          keychain: [],
          sources: [],
          argv: [s.path],
        },
        how,
        {
          PATH: '/usr/bin:/bin',
          HOME: dir.path,
          CLAUDECODE: '1',
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_ACCESS_KEY_ID: 'AKIA-x',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'm',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm',
          TENDB_DATA_DIR: '/d',
          EDITOR_CHOICE: 'vim',
        },
      );
      const names = s.names();
      for (const gone of [
        'CLAUDECODE',
        'CLAUDE_CODE_USE_BEDROCK',
        'AWS_ACCESS_KEY_ID',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'TENDB_DATA_DIR',
      ])
        expect(names).not.toContain(gone);
      expect(names).toContain('EDITOR_CHOICE');
    },
  );

  it.each(['script', 'line'] as const)(
    'exports a sealed file’s variables to the program and leaves no file (%s)',
    (how) => {
      dir = tempDir('render');
      const s = stub();
      const sealed = join(dir.path, 'sealed.env');
      writeFileSync(sealed, "export INJ='from-the-sealed-file'\n");
      run(
        {
          cwd: dir.path,
          unset: [],
          unsetPrefixes: [],
          set: {},
          keychain: [],
          sources: [sealed],
          argv: [s.path],
        },
        how,
        { PATH: '/usr/bin:/bin', HOME: dir.path },
      );
      expect(s.inj()).toBe('from-the-sealed-file');
      expect(existsSync(sealed)).toBe(false);
    },
  );
});
