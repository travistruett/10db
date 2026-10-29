import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { resolvePnpm } from './pnpm-binary';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir('pnpm-binary-');
});
afterEach(() => {
  tmp.cleanup();
});

const dir = (...parts: string[]): string => {
  const path = join(tmp.path, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
};
const script = (path: string, body = 'exit 0'): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};
/** A program that is not a script: any compiled executable will do. */
const program = (path: string): void => {
  copyFileSync('/bin/ls', path);
  chmodSync(path, 0o755);
};

describe('resolving the pnpm a worktree install runs', () => {
  it('returns a real pnpm program outside the checkouts', async () => {
    const bin = dir('real');
    program(join(bin, 'pnpm'));
    const found = await resolvePnpm({ PATH: bin }, [dir('checkout')]);
    expect(found?.endsWith('/real/pnpm')).toBe(true);
  });

  it.each([
    [
      'a script',
      () => {
        script(join(dir('bin'), 'pnpm'));
      },
    ],
    [
      'a corepack shim',
      () => {
        script(join(dir('corepack', 'bin'), 'pnpm'));
      },
    ],
    [
      'a volta binary',
      () => {
        program(join(dir('.volta', 'bin'), 'pnpm'));
      },
    ],
    [
      'an fnm link',
      () => {
        symlinkSync('/bin/ls', join(dir('fnm', 'bin'), 'pnpm'));
      },
    ],
    [
      'an asdf shim',
      () => {
        program(join(dir('asdf', 'shims'), 'pnpm'));
      },
    ],
  ])('refuses %s, and does not fall back to it', async (_name, plant) => {
    plant();
    const path = ['bin', 'corepack/bin', '.volta/bin', 'fnm/bin', 'asdf/shims']
      .map((part) => join(tmp.path, part))
      .join(':');
    expect(await resolvePnpm({ PATH: path }, [dir('checkout')])).toBeNull();
  });

  it('refuses a pnpm inside a checkout, also through a link', async () => {
    const checkout = dir('checkout');
    program(join(checkout, 'pnpm'));
    const linked = dir('linked');
    symlinkSync(join(checkout, 'pnpm'), join(linked, 'pnpm'));
    expect(await resolvePnpm({ PATH: `${checkout}:${linked}` }, [checkout])).toBeNull();
  });

  describe('a mise shim', () => {
    it('is asked, from the home directory, which program it stands for', async () => {
      const shims = dir('mise', 'shims');
      script(join(shims, 'pnpm'));
      const installs = dir('installs');
      program(join(installs, 'pnpm'));
      const tools = dir('tools');
      const cwdLog = join(tmp.path, 'cwd');
      script(join(tools, 'mise'), `pwd > '${cwdLog}'\necho '${join(installs, 'pnpm')}'`);
      const found = await resolvePnpm({ PATH: `${shims}:${tools}` }, [dir('checkout')]);
      expect(found?.endsWith('/installs/pnpm')).toBe(true);
      const asked = readFileSync(cwdLog, 'utf8').trim();
      expect(asked).toBe(realpathSync(homedir()));
    });

    it('is refused when the answer is a script, or lies in a checkout', async () => {
      const shims = dir('mise', 'shims');
      script(join(shims, 'pnpm'));
      const checkout = dir('checkout');
      program(join(checkout, 'pnpm'));
      const tools = dir('tools');
      script(join(tools, 'mise'), `echo '${join(checkout, 'pnpm')}'`);
      expect(await resolvePnpm({ PATH: `${shims}:${tools}` }, [checkout])).toBeNull();
      script(join(tools, 'mise'), `echo '${join(tools, 'mise')}'`);
      expect(await resolvePnpm({ PATH: `${shims}:${tools}` }, [checkout])).toBeNull();
    });
  });
});
