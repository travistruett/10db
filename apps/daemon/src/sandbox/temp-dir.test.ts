import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLaneTempDir,
  MAX_SANDBOX_TMP_BYTES,
  removeLaneTempDir,
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

describe('lane temp directory', () => {
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

  it('removing a directory that is already gone is not an error', () => {
    const dir = createLaneTempDir(root);
    removeLaneTempDir(dir, root);
    expect(() => {
      removeLaneTempDir(dir, root);
    }).not.toThrow();
  });
});
