import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { insideAny, surelyInside } from './lane-writable';

const FOLDS_CASE = process.platform === 'darwin';

let dir: TempDir;
beforeEach(() => {
  dir = tempDir('lane-writable');
  mkdirSync(join(dir.path, 'root', 'sub'), { recursive: true });
  mkdirSync(join(dir.path, 'elsewhere'), { recursive: true });
  writeFileSync(join(dir.path, 'root', 'sub', 'f'), '');
  writeFileSync(join(dir.path, 'elsewhere', 'f'), '');
  // A link inside the root that leads out of it, and one outside that leads in.
  symlinkSync(join(dir.path, 'elsewhere'), join(dir.path, 'root', 'out'));
  symlinkSync(join(dir.path, 'root', 'sub'), join(dir.path, 'in'));
});
afterEach(() => {
  dir.cleanup();
});

const at = (...parts: string[]) => join(dir.path, ...parts);
const nfd = 'café';
const nfc = 'café';

describe('insideAny', () => {
  it.each([
    { name: 'the root itself', path: () => at('root'), roots: () => [at('root')], inside: true },
    {
      name: 'a file under the root',
      path: () => at('root', 'sub', 'f'),
      roots: () => [at('root')],
      inside: true,
    },
    {
      name: 'a file elsewhere',
      path: () => at('elsewhere', 'f'),
      roots: () => [at('root')],
      inside: false,
    },
    {
      name: 'a sibling whose name starts with the root',
      path: () => at('rootless'),
      roots: () => [at('root')],
      inside: false,
    },
    {
      name: 'a path through a link that leads into the root',
      path: () => at('in', 'f'),
      roots: () => [at('root')],
      inside: true,
    },
    {
      name: 'a path under the root whose link leads out of it, read as written',
      path: () => at('root', 'out', 'f'),
      roots: () => [at('root')],
      inside: true,
    },
    {
      name: 'a path out of the root through a link, read as the kernel opens it',
      path: () => at('root', 'out', 'f'),
      roots: () => [at('elsewhere')],
      inside: true,
    },
    {
      name: '.. through a link, which the kernel follows and text collapses',
      path: () => `${at('in')}/../elsewhere/f`,
      roots: () => [at('root')],
      inside: true,
    },
    {
      name: 'a root named in another case',
      path: () => at('root', 'sub', 'f'),
      roots: () => [at('ROOT')],
      inside: FOLDS_CASE,
    },
    {
      name: 'a root named in NFD, a path in NFC',
      path: () => at(nfc, 'f'),
      roots: () => [at(nfd)],
      inside: true,
      setup: () => {
        mkdirSync(at(nfc));
        writeFileSync(at(nfc, 'f'), '');
      },
    },
    {
      name: 'a path that cannot be resolved, which counts as inside',
      path: () => `${at('missing')}/../../x`,
      roots: () => [at('root')],
      inside: true,
    },
    {
      name: 'a root that does not exist, compared as written',
      path: () => at('gone', 'f'),
      roots: () => [at('gone')],
      inside: true,
    },
    {
      name: 'a root that does not exist, and a path outside it',
      path: () => at('elsewhere', 'f'),
      roots: () => [at('gone')],
      inside: false,
    },
  ])('$name', ({ path, roots, inside, setup }) => {
    setup?.();
    expect(insideAny(path(), roots())).toBe(inside);
  });
});

describe('surelyInside', () => {
  it.each([
    { name: 'the root itself', path: () => at('root'), inside: true },
    { name: 'a file under the root', path: () => at('root', 'sub', 'f'), inside: true },
    { name: 'a file elsewhere', path: () => at('elsewhere', 'f'), inside: false },
    {
      name: 'a path under the root whose link leads out of it',
      path: () => at('root', 'out', 'f'),
      inside: false,
    },
    { name: 'a path through a link into the root', path: () => at('in', 'f'), inside: true },
    {
      name: 'a path that cannot be resolved',
      path: () => `${at('root', 'missing')}/../../x`,
      inside: false,
    },
  ])('$name', ({ path, inside }) => {
    expect(surelyInside(path(), at('root'))).toBe(inside);
  });
});
