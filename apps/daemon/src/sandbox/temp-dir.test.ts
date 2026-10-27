import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SANDBOXED } from '../../test/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLaneTempDir,
  MAX_SANDBOX_TMP_BYTES,
  removeLaneTempDir,
  removeLaneTempDirAsync,
  SandboxTempDirError,
} from './index';

let root: string;

beforeEach(() => {
  // A short root: the limit counts the whole path, and macOS's OS temp dir is longer than it.
  root = realpathSync(mkdtempSync('/tmp/sbx-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Their root is a short path under the shared `/tmp`, so a temp dir made in it fits Claude Code's
// 44-byte limit, and no sandbox can write `/tmp`.
describe.skipIf(SANDBOXED)('lane temp directory', () => {
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
