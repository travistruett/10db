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
import { basename, join } from 'node:path';
import { SANDBOXED } from '../../test/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeCodeTmpPath,
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
  it("puts Claude lanes' temp dirs in /Users/Shared within the limit, and a ChatGPT lane's and 10db's files under the home's .10db", () => {
    const uid = String(process.getuid?.());
    expect(laneTempRoot()).toBe(`/Users/Shared/10db-${uid}`);
    // mkdtemp's six characters, and Claude Code's own dir in it: what Claude Code measures.
    expect(claudeCodeTmpPath(join(laneTempRoot(), 'abcdef'))).toBe(
      `/Users/Shared/10db-${uid}/abcdef/claude-${uid}`,
    );
    expect(
      Buffer.byteLength(claudeCodeTmpPath(join(laneTempRoot(), 'abcdef'))),
    ).toBeLessThanOrEqual(MAX_SANDBOX_TMP_BYTES);
    expect(codexLaneTempRoot('/Users/me')).toBe('/Users/me/.10db/lanes');
    expect(sandboxFilesRoot('/Users/me')).toBe('/Users/me/.10db/run');
  });
});

// A temp parent stands in for `/Users/Shared` and the home.
describe('ensurePrivateRoot', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), '10db-root-')));
  });

  it('makes a missing root and its parents, or an existing root of its own, 0700, keeping what is in it', () => {
    const made = join(root, 'home', '.10db', 'run');
    expect(ensurePrivateRoot(made)).toBe(realpathSync(made));
    expect(lstatSync(made).isDirectory()).toBe(true);
    expect(statSync(made).mode & 0o777).toBe(0o700);
    const existing = join(root, 'shared');
    mkdirSync(existing, { mode: 0o755 });
    chmodSync(existing, 0o755);
    writeFileSync(join(existing, 'keep'), 'x');
    expect(ensurePrivateRoot(existing)).toBe(existing);
    expect(statSync(existing).mode & 0o777).toBe(0o700);
    expect(readdirSync(existing)).toEqual(['keep']);
  });

  it("refuses a root that is a link, a file or another user's dir, leaving a linked root's target as it was", () => {
    const rows: { name: string; make: (path: string) => void; rootOnly: boolean }[] = [
      {
        name: 'a link',
        make: (path) => {
          const target = join(root, 'elsewhere');
          mkdirSync(target, { mode: 0o755 });
          chmodSync(target, 0o755);
          symlinkSync(target, path);
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
    ];
    for (const [i, { name, make, rootOnly }] of rows.entries()) {
      if (rootOnly && process.getuid?.() !== 0) continue;
      const path = join(root, `shared-${String(i)}`);
      make(path);
      expect.soft(() => ensurePrivateRoot(path), name).toThrow(SandboxTempDirError);
      expect.soft(() => ensurePrivateRoot(path), name).toThrow(path);
    }
    expect(statSync(join(root, 'elsewhere')).mode & 0o777).toBe(0o755);
  });
});

// Their root is a short path under the shared `/tmp`, so a temp dir made in it fits Claude Code's
// 44-byte limit, and no sandbox can write `/tmp`.
describe.skipIf(SANDBOXED)('lane temp directory', () => {
  beforeEach(() => {
    // A short root: the limit counts the whole path, and macOS's OS temp dir is longer than it.
    root = realpathSync(mkdtempSync('/tmp/sbx-'));
  });

  /** A root whose temp dirs put Claude Code's own dir at exactly `bytes`, as it measures. */
  function rootFor(bytes: number): string {
    // The temp dir's name and Claude Code's `claude-<uid>` in it.
    const inside = Buffer.byteLength(claudeCodeTmpPath('/abcdef'));
    const made = join(root, 'a'.repeat(bytes - inside - Buffer.byteLength(root) - 1));
    mkdirSync(made);
    expect(Buffer.byteLength(claudeCodeTmpPath(join(made, 'abcdef')))).toBe(bytes);
    return made;
  }

  it('creates a private dir named by six random characters, measured with Claude Code’s claude-<uid> up to the limit, of any length for a ChatGPT lane', () => {
    const shortRoot = join(root, 'r');
    mkdirSync(shortRoot);
    const short = createLaneTempDir(shortRoot);
    expect(Buffer.byteLength(claudeCodeTmpPath(short))).toBeLessThanOrEqual(MAX_SANDBOX_TMP_BYTES);
    const atLimit = rootFor(MAX_SANDBOX_TMP_BYTES);
    const full = createLaneTempDir(atLimit);
    expect(Buffer.byteLength(claudeCodeTmpPath(full))).toBe(MAX_SANDBOX_TMP_BYTES);
    // No Claude Code or srt runs in a ChatGPT lane, so no limit applies there.
    const longRoot = join(root, 'a'.repeat(40));
    mkdirSync(longRoot);
    const long = createLaneTempDir(longRoot, null);
    for (const [at, dir] of [
      [shortRoot, short],
      [atLimit, full],
      [longRoot, long],
    ] as const) {
      expect.soft(statSync(dir).mode & 0o777, dir).toBe(0o700);
      expect.soft(dir.startsWith(`${at}/`), dir).toBe(true);
      expect.soft(basename(dir), dir).toMatch(/^[A-Za-z0-9]{6}$/);
      removeLaneTempDir(dir, at);
      expect.soft(readdirSync(at), dir).toEqual([]);
    }
  });

  it('refuses a root one byte over the limit, a longer one, or a missing one, leaving nothing behind', () => {
    // Refused, never handed to Claude Code, which would fall back to /tmp/claude-<uid> unsaid.
    const overLimit = rootFor(MAX_SANDBOX_TMP_BYTES + 1);
    expect(() => createLaneTempDir(overLimit)).toThrow(SandboxTempDirError);
    expect(() => createLaneTempDir(overLimit)).toThrow(
      `The lane temp directory path is over ${String(MAX_SANDBOX_TMP_BYTES)} bytes`,
    );
    expect(readdirSync(overLimit)).toEqual([]);
    const longRoot = join(root, 'a'.repeat(40));
    mkdirSync(longRoot);
    expect(() => createLaneTempDir(longRoot)).toThrow(SandboxTempDirError);
    expect(readdirSync(longRoot)).toEqual([]);
    expect(() => createLaneTempDir(join(root, 'missing'))).toThrow(SandboxTempDirError);
  });

  it('removes only its own directories, and a second removal is not an error', () => {
    const dir = createLaneTempDir(root);
    const other = join(root, 'keep');
    mkdirSync(other);
    // Seven characters: no name a temp dir is made with.
    const longer = join(root, 'abcdefg');
    mkdirSync(longer);
    expect(() => {
      removeLaneTempDir(root, root);
    }).toThrow(SandboxTempDirError);
    expect(() => {
      removeLaneTempDir(other, root);
    }).toThrow(SandboxTempDirError);
    expect(() => {
      removeLaneTempDir(longer, root);
    }).toThrow(SandboxTempDirError);
    expect(existsSync(longer)).toBe(true);
    expect(() => {
      removeLaneTempDir(dir, join(root, 'elsewhere'));
    }).toThrow(SandboxTempDirError);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(other)).toBe(true);
    removeLaneTempDir(dir, root);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(() => {
      removeLaneTempDir(dir, root);
    }).not.toThrow();
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

  it('removes a directory however the lane locked the folders in it, or the directory itself', () => {
    /** Each lays a file in `dir` and locks folders as a lane may leave them. */
    const layouts: { name: string; lock: (dir: string) => void }[] = [
      {
        name: 'read-only folders, with a file inside',
        lock: (dir) => {
          const locked = join(dir, 'locked');
          mkdirSync(join(locked, 'deeper'), { recursive: true });
          writeFileSync(join(locked, 'deeper', 'f'), 'x');
          chmodSync(join(locked, 'deeper'), 0o555);
          chmodSync(locked, 0o555);
        },
      },
      ...(
        [
          ['no permissions', 0o000],
          ['write and search only', 0o300],
        ] as const
      ).map(([what, mode]) => ({
        name: `a folder with ${what}, holding a file`,
        lock: (dir: string) => {
          const locked = join(dir, 'x');
          mkdirSync(locked);
          writeFileSync(join(locked, 'f'), 'x');
          chmodSync(locked, mode);
        },
      })),
      {
        name: 'the temp directory itself read-only',
        lock: (dir) => {
          mkdirSync(join(dir, 'a', 'b'), { recursive: true });
          writeFileSync(join(dir, 'a', 'b', 'f'), 'x');
          chmodSync(join(dir, 'a', 'b'), 0o555);
          chmodSync(join(dir, 'a'), 0o555);
          chmodSync(dir, 0o555);
        },
      },
    ];
    for (const { name, lock } of layouts) {
      const dir = createLaneTempDir(root);
      lock(dir);
      removeLaneTempDir(dir, root);
      expect.soft(existsSync(dir), name).toBe(false);
    }
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
});
