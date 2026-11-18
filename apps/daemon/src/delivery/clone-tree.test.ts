import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { cloneWholeTrees } from './clone-tree';

let tmp: TempDir;
const signal = new AbortController().signal;

beforeEach(() => {
  tmp = tempDir('clone-tree');
});
afterEach(() => {
  tmp.cleanup();
});

function sourceTree(name: string): string {
  const from = join(tmp.path, name);
  mkdirSync(join(from, 'a/b'), { recursive: true });
  writeFileSync(join(from, 'a/b/file.js'), `module.exports = '${name}';\n`);
  symlinkSync('b/file.js', join(from, 'a/link.js'));
  symlinkSync('/nowhere/at/all', join(from, 'dangling'));
  return from;
}

// A whole-tree clone is a macOS file system call; elsewhere the caller copies.
describe.skipIf(process.platform !== 'darwin')('cloneWholeTrees', () => {
  it('clones each tree with its links as links, never followed, in one call', async () => {
    const clones = ['one', 'two'].map((name) => ({
      from: sourceTree(name),
      to: join(tmp.path, `${name}-clone`),
    }));
    expect(await cloneWholeTrees({ clones, signal })).toEqual(new Set([0, 1]));
    for (const [index, name] of ['one', 'two'].entries()) {
      const to = clones[index]?.to ?? '';
      expect(readFileSync(join(to, 'a/b/file.js'), 'utf8')).toBe(`module.exports = '${name}';\n`);
      expect(readlinkSync(join(to, 'a/link.js'))).toBe('b/file.js');
      expect(lstatSync(join(to, 'dangling')).isSymbolicLink()).toBe(true);
    }
  });

  it('is a copy: writing the clone leaves the source as it was', async () => {
    const from = sourceTree('src');
    const to = join(tmp.path, 'to');
    await cloneWholeTrees({ clones: [{ from, to }], signal });
    writeFileSync(join(to, 'a/b/file.js'), 'changed\n');
    expect(readFileSync(join(from, 'a/b/file.js'), 'utf8')).toBe("module.exports = 'src';\n");
  });

  it('leaves out a tree it can not clone, and still clones the others', async () => {
    const good = { from: sourceTree('good'), to: join(tmp.path, 'good-clone') };
    const taken = { from: sourceTree('taken'), to: join(tmp.path, 'taken-clone') };
    const missing = { from: join(tmp.path, 'none'), to: join(tmp.path, 'none-clone') };
    mkdirSync(taken.to);
    expect(await cloneWholeTrees({ clones: [taken, missing, good], signal })).toEqual(new Set([2]));
    expect(existsSync(join(taken.to, 'a'))).toBe(false);
    expect(existsSync(missing.to)).toBe(false);
    expect(existsSync(join(good.to, 'a/b/file.js'))).toBe(true);
  });
});
