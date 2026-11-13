import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LinkInPathError, openInRoot } from './open-in-root';

let root: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), '10db-open-in-root-')));
  root = join(base, 'checkout');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'dir'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'dir', 'a.md'), 'inside');
  writeFileSync(join(outside, 'a.md'), 'OUTSIDE');
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

const readOpened = (relative: string): string => {
  const fd = openInRoot(root, relative);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
};

// A lane writes the checkout, so any folder on the way to a file it holds may be a link at the
// moment 10db opens it, whatever a check by path saw before or after.
describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('openInRoot', () => {
  it('opens a file inside the root', () => {
    expect(readOpened('dir/a.md')).toBe('inside');
  });

  it.each([
    [
      'a parent folder that is a link outside',
      () => {
        symlinkSync(outside, join(root, 'out'));
      },
      'out/a.md',
    ],
    [
      'a parent folder that is a link inside',
      () => {
        symlinkSync(join(root, 'dir'), join(root, 'in'));
      },
      'in/a.md',
    ],
    [
      'the file itself a link',
      () => {
        symlinkSync(join(outside, 'a.md'), join(root, 'l.md'));
      },
      'l.md',
    ],
  ] as const)('refuses %s', (_name, plant, relative) => {
    plant();
    expect(() => openInRoot(root, relative)).toThrow(LinkInPathError);
  });

  it.each(['../outside/a.md', '/etc/hosts', '.'])('refuses %s, which is not inside', (relative) => {
    expect(() => openInRoot(root, relative)).toThrow(LinkInPathError);
  });

  it('passes on the error for a file that is not there', () => {
    expect(() => openInRoot(root, 'dir/none.md')).toThrow(/ENOENT/);
  });
});
