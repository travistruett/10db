import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  execFileAsync,
  KeychainError,
  keychainWith,
  secretFingerprint,
  unavailableKeychain,
} from './index';

interface Call {
  args: readonly string[];
  input: unknown;
}

/** A Keychain double at the `security` boundary: `-i` writes go to `items`, reads come from it. */
function securityDouble(opts: { mangle?: (s: string) => string } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const exec = (
    _cmd: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string => {
    calls.push({ args, input: options.input });
    if (args[0] === '-i') {
      const line = typeof options.input === 'string' ? options.input : '';
      const match = /-a "([^"]+)" -w "([^"]*)"/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined)
        items.set(match[1], opts.mangle ? opts.mangle(match[2]) : match[2]);
      return '';
    }
    const account = args[args.indexOf('-a') + 1] ?? '';
    if (args[0] === 'delete-generic-password') {
      if (!items.delete(account)) throw Object.assign(new Error('not found'), { status: 44 });
      return '';
    }
    const value = items.get(account);
    if (value === undefined) throw Object.assign(new Error('not found'), { status: 44 });
    return `${value}\n`;
  };
  return { exec, items, calls };
}

describe('keychainWith', () => {
  it('writes through security -i on standard input, never on the command line, and reads it back', () => {
    const security = securityDouble();
    const keychain = keychainWith(security.exec);
    keychain.write('account:acc_1', 'sk-ant-SECRET-1234');
    expect(keychain.read('account:acc_1')).toBe('sk-ant-SECRET-1234');
    const write = security.calls[0];
    expect(write?.args).toEqual(['-i']);
    expect(String(write?.input)).toContain(
      'add-generic-password -U -s 10db -a "account:acc_1" -w "sk-ant-SECRET-1234"',
    );
    for (const call of security.calls) expect(call.args.join(' ')).not.toContain('SECRET');
  });

  it('refuses a secret security -i would split or unquote, before running anything', () => {
    const security = securityDouble();
    const keychain = keychainWith(security.exec);
    for (const bad of ['has space', 'quote"d', 'back\\slash', 'new\nline'])
      expect(() => {
        keychain.write('account:acc_1', bad);
      }).toThrow(KeychainError);
    expect(security.calls).toEqual([]);
  });

  it('refuses an account name that would inject arguments into the security line', () => {
    const security = securityDouble();
    const keychain = keychainWith(security.exec);
    for (const bad of ['acc" -w "x', 'a b', 'a\nb', ''])
      expect(() => {
        keychain.write(bad, 'sk-ant-SECRET-1234');
      }).toThrow(KeychainError);
    expect(security.calls).toEqual([]);
  });

  it('fails a write the Keychain did not store as given, naming no value', () => {
    const keychain = keychainWith(securityDouble({ mangle: (s) => s.slice(1) }).exec);
    const write = () => {
      keychain.write('account:acc_1', 'sk-ant-SECRET-1234');
    };
    expect(write).toThrow(KeychainError);
    expect(write).not.toThrow(/SECRET/);
  });

  it('removes an item, and removing a missing one is not an error', () => {
    const security = securityDouble();
    const keychain = keychainWith(security.exec);
    keychain.write('openrouter-api-key', 'fake-router-key-SECRET-1234');
    keychain.remove('openrouter-api-key');
    expect(keychain.read('openrouter-api-key')).toBeNull();
    expect(() => {
      keychain.remove('openrouter-api-key');
    }).not.toThrow();
    const removal = security.calls.find((c) => c.args[0] === 'delete-generic-password');
    expect(removal?.args).toEqual([
      'delete-generic-password',
      '-s',
      '10db',
      '-a',
      'openrouter-api-key',
    ]);
  });

  it('refuses to remove an account name security would misread, before running anything', () => {
    const security = securityDouble();
    const keychain = keychainWith(security.exec);
    expect(() => {
      keychain.remove('a b');
    }).toThrow(KeychainError);
    expect(security.calls).toEqual([]);
  });

  it.each([
    ['user denied (status 51)', { status: 51 }, /status 51/],
    ['a timeout', { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }, /timed out/],
  ])('throws a KeychainError when removing fails: %s', (_name, props, message) => {
    const keychain = keychainWith(() => {
      throw Object.assign(new Error('Command failed: security ... fake-LEAK'), props);
    });
    const remove = () => {
      keychain.remove('openrouter-api-key');
    };
    expect(remove).toThrow(KeychainError);
    expect(remove).toThrow(message);
    expect(remove).not.toThrow(/LEAK/);
  });

  it('reads nothing for a missing or empty item', () => {
    const security = securityDouble();
    security.items.set('account:empty', '');
    const keychain = keychainWith(security.exec);
    expect(keychain.read('account:none')).toBeNull();
    expect(keychain.read('account:empty')).toBeNull();
  });

  it.each([
    ['user denied (status 51)', { status: 51 }, /status 51/],
    ['a locked Keychain (status 36)', { status: 36 }, /status 36/],
    ['a timeout', { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }, /timed out/],
    ['security missing', { code: 'ENOENT' }, /ENOENT/],
  ])('throws a KeychainError for %s, naming no output', (_name, props, message) => {
    const keychain = keychainWith(() => {
      throw Object.assign(new Error('Command failed: security ... sk-ant-LEAK'), props);
    });
    const read = () => keychain.read('account:acc_1');
    expect(read).toThrow(KeychainError);
    expect(read).toThrow(message);
    expect(read).not.toThrow(/LEAK/);
  });

  describe('readAsync', () => {
    /** A Keychain whose only working exec is the async one: a sync read would fail the test. */
    function asyncOnly(
      run: (args: readonly string[]) => Promise<string>,
      calls: (readonly string[])[] = [],
    ) {
      return keychainWith(
        () => {
          throw new Error('the synchronous exec must not run');
        },
        (_command, args) => {
          calls.push(args);
          return run(args);
        },
      );
    }

    it('reads through the async exec, never the sync one, and trims the value', async () => {
      const calls: (readonly string[])[] = [];
      const keychain = asyncOnly(() => Promise.resolve('sk-or-SECRET\n'), calls);
      expect(await keychain.readAsync('openrouter-api-key')).toBe('sk-or-SECRET');
      expect(calls[0]).toEqual([
        'find-generic-password',
        '-s',
        '10db',
        '-a',
        'openrouter-api-key',
        '-w',
      ]);
    });

    it('reads nothing for a missing or empty item', async () => {
      expect(
        await asyncOnly(() =>
          Promise.reject(Object.assign(new Error('nf'), { status: 44 })),
        ).readAsync('x'),
      ).toBeNull();
      expect(await asyncOnly(() => Promise.resolve('\n')).readAsync('x')).toBeNull();
    });

    it.each([
      ['user denied (status 51)', { status: 51 }, /status 51/],
      ['a timeout', { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }, /timed out/],
    ])('rejects with a KeychainError for %s, naming no output', async (_name, props, message) => {
      const keychain = asyncOnly(() =>
        Promise.reject(Object.assign(new Error('Command failed: sk-ant-LEAK'), props)),
      );
      const failure = await keychain.readAsync('x').then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(KeychainError);
      expect((failure as Error).message).toMatch(message);
      expect((failure as Error).message).not.toMatch(/LEAK/);
    });

    it('reads nothing from an unavailable Keychain', async () => {
      expect(await unavailableKeychain.readAsync('anything')).toBeNull();
    });
  });

  describe('execFileAsync', () => {
    it('answers what the program printed', async () => {
      expect(await execFileAsync('/bin/echo', ['hi'], { encoding: 'utf8', timeout: 5_000 })).toBe(
        'hi\n',
      );
    });
    it('reports the exit status as `status`, as the synchronous exec does', async () => {
      const failure = await execFileAsync('/bin/sh', ['-c', 'exit 44'], {
        encoding: 'utf8',
        timeout: 5_000,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 44 });
    });
    it('reports a timeout as ETIMEDOUT', async () => {
      const failure = await execFileAsync('/bin/sleep', ['30'], {
        encoding: 'utf8',
        timeout: 50,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
    });
  });

  it('has an unavailable Keychain that reads nothing and refuses writes', () => {
    expect(unavailableKeychain.read('anything')).toBeNull();
    expect(() => {
      unavailableKeychain.write('account:acc_1', 'sk-ant-SECRET-1234');
    }).toThrow(KeychainError);
    expect(() => {
      unavailableKeychain.remove('account:acc_1');
    }).toThrow(KeychainError);
  });

  it('fingerprints a secret without exposing it', () => {
    const print = secretFingerprint('sk-ant-SECRET-1234');
    expect(print).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(secretFingerprint('sk-ant-SECRET-1234')).toBe(print);
    expect(secretFingerprint('sk-ant-SECRET-1235')).not.toBe(print);
  });
});
