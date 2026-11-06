import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOXED } from '../../test/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexLaneTempRoot,
  createLaneTempDir,
  ensurePrivateRoot,
  laneTempRoot,
  MAX_SANDBOX_TMP_BYTES,
  removeLaneTempDir,
  removeLaneTempDirAsync,
  sandboxFilesRoot,
  SandboxTempDirError,
} from './index';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('the sandbox roots', () => {
  it("puts Claude lanes' temp dirs in this user's folder of /Users/Shared, short enough for the limit", () => {
    expect(laneTempRoot()).toBe(`/Users/Shared/10db-${String(process.getuid?.())}`);
    // mkdtemp's six characters after the prefix: the longest path a temp dir there takes.
    expect(Buffer.byteLength(join(laneTempRoot(), '10db-abcdef'))).toBeLessThanOrEqual(
      MAX_SANDBOX_TMP_BYTES,
    );
  });

  it("puts a ChatGPT lane's temp dir and 10db's sandbox files under the home's .10db", () => {
    expect(codexLaneTempRoot('/Users/me')).toBe('/Users/me/.10db/lanes');
    expect(sandboxFilesRoot('/Users/me')).toBe('/Users/me/.10db/run');
  });
});

// A temp parent stands in for `/Users/Shared` and the home.
describe('ensurePrivateRoot', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), '10db-root-')));
  });

  it('makes a missing root 0700, its missing parents too, and returns its real path', () => {
    const made = join(root, 'home', '.10db', 'run');
    expect(ensurePrivateRoot(made)).toBe(realpathSync(made));
    expect(lstatSync(made).isDirectory()).toBe(true);
    expect(statSync(made).mode & 0o777).toBe(0o700);
  });

  it('makes an existing root of its own 0700, keeping what is in it', () => {
    const made = join(root, 'shared');
    mkdirSync(made, { mode: 0o755 });
    chmodSync(made, 0o755);
    writeFileSync(join(made, 'keep'), 'x');
    expect(ensurePrivateRoot(made)).toBe(made);
    expect(statSync(made).mode & 0o777).toBe(0o700);
    expect(readdirSync(made)).toEqual(['keep']);
  });

  it.for<{ name: string; make: (path: string) => void; rootOnly: boolean }>([
    {
      name: 'a link',
      make: (path) => {
        mkdirSync(join(root, 'elsewhere'));
        symlinkSync(join(root, 'elsewhere'), path);
      },
      rootOnly: false,
    },
    {
      name: 'a file',
      make: (path) => {
        writeFileSync(path, '');
      },
      rootOnly: false,
    },
    {
      name: "another user's dir",
      make: (path) => {
        mkdirSync(path, { mode: 0o700 });
        chownSync(path, 1, 1);
      },
      // Only root can give a dir to another user.
      rootOnly: true,
    },
  ])('refuses a root that is $name', ({ make, rootOnly }, { skip }) => {
    if (rootOnly && process.getuid?.() !== 0) skip('only root can give a dir to another user');
    const path = join(root, 'shared');
    make(path);
    expect(() => ensurePrivateRoot(path)).toThrow(SandboxTempDirError);
    expect(() => ensurePrivateRoot(path)).toThrow(path);
  });

  it("leaves a linked root's target as it was", () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(root, 'shared'));
    expect(() => ensurePrivateRoot(join(root, 'shared'))).toThrow(SandboxTempDirError);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

// Their root is a short path under the shared `/tmp`, so a temp dir made in it fits Claude Code's
// 44-byte limit, and no sandbox can write `/tmp`.
describe.skipIf(SANDBOXED)('lane temp directory', () => {
  beforeEach(() => {
    // A short root: the limit counts the whole path, and macOS's OS temp dir is longer than it.
    root = realpathSync(mkdtempSync('/tmp/sbx-'));
  });

  it('creates a short private directory', () => {
    const shortRoot = join(root, 'r');
    mkdirSync(shortRoot);
    const dir = createLaneTempDir(shortRoot);
    expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(MAX_SANDBOX_TMP_BYTES);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(dir.startsWith(`${shortRoot}/10db-`)).toBe(true);
  });

  it('refuses a root that makes the path too long, leaving nothing behind', () => {
    const longRoot = join(root, 'a'.repeat(40));
    mkdirSync(longRoot);
    expect(() => createLaneTempDir(longRoot)).toThrow(SandboxTempDirError);
    expect(readdirSync(longRoot)).toEqual([]);
  });

  it('makes a dir of any length where no Claude Code or srt runs, a ChatGPT lane’s', () => {
    const longRoot = join(root, 'a'.repeat(40));
    mkdirSync(longRoot);
    const dir = createLaneTempDir(longRoot, null);
    expect(dir.startsWith(`${longRoot}/10db-`)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    removeLaneTempDir(dir, longRoot);
  });

  it('refuses a root that does not exist', () => {
    expect(() => createLaneTempDir(join(root, 'missing'))).toThrow(SandboxTempDirError);
  });

  it('removes only its own directories', () => {
    const dir = createLaneTempDir(root);
    const other = join(root, 'keep');
    mkdirSync(other);
    expect(() => {
      removeLaneTempDir(root, root);
    }).toThrow(SandboxTempDirError);
    expect(() => {
      removeLaneTempDir(other, root);
    }).toThrow(SandboxTempDirError);
    expect(() => {
      removeLaneTempDir(dir, join(root, 'elsewhere'));
    }).toThrow(SandboxTempDirError);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(other)).toBe(true);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('removes only its own directories off the event loop too, read-only ones included', async () => {
    const dir = createLaneTempDir(root);
    const other = join(root, 'keep');
    mkdirSync(other);
    await expect(removeLaneTempDirAsync(other, root)).rejects.toThrow(SandboxTempDirError);
    await expect(removeLaneTempDirAsync(root, root)).rejects.toThrow(SandboxTempDirError);
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'f'), 'x');
    chmodSync(locked, 0o555);
    await removeLaneTempDirAsync(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  it('removes a directory the lane made read-only, with a file inside', () => {
    const dir = createLaneTempDir(root);
    const locked = join(dir, 'locked');
    mkdirSync(join(locked, 'deeper'), { recursive: true });
    writeFileSync(join(locked, 'deeper', 'f'), 'x');
    chmodSync(join(locked, 'deeper'), 0o555);
    chmodSync(locked, 0o555);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
  });

  it.each<[string, number]>([
    ['no permissions', 0o000],
    ['write and search only', 0o300],
  ])('removes a directory the lane left with %s, holding a file', (_name, mode) => {
    const dir = createLaneTempDir(root);
    const locked = join(dir, 'x');
    mkdirSync(locked);
    writeFileSync(join(locked, 'f'), 'x');
    chmodSync(locked, mode);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a lane temp directory that is itself read-only', () => {
    const dir = createLaneTempDir(root);
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f'), 'x');
    chmodSync(join(dir, 'a', 'b'), 0o555);
    chmodSync(join(dir, 'a'), 0o555);
    chmodSync(dir, 0o555);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not follow a link out of the directory while unlocking', () => {
    const dir = createLaneTempDir(root);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'x');
    chmodSync(outside, 0o500);
    // The link sits inside a locked directory, so the first removal cannot unlink it and the unlock
    // walk has to meet it.
    mkdirSync(join(dir, 'locked'));
    symlinkSync(outside, join(dir, 'locked', 'link'));
    chmodSync(join(dir, 'locked'), 0o000);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    chmodSync(outside, 0o700);
  });

  it('removing a directory that is already gone is not an error', () => {
    const dir = createLaneTempDir(root);
    removeLaneTempDir(dir, root);
    expect(() => {
      removeLaneTempDir(dir, root);
    }).not.toThrow();
  });
});
