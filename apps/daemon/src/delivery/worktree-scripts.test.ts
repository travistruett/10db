import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPolicy } from './worktree-scripts';

describe('buildPolicy with onlyBuiltDependenciesFile', () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'policy-'));
    root = join(base, 'copy');
    mkdirSync(root);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const workspace = (file: string): void => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), `onlyBuiltDependenciesFile: ${file}\n`);
  };

  it('reads the package names in a JSON file inside the root', () => {
    workspace('allowed.json');
    writeFileSync(join(root, 'allowed.json'), JSON.stringify(['prisma', '@scope/native@1.0.0']));
    expect(buildPolicy(root).allowed).toEqual(['@scope/native', 'prisma']);
  });

  it('reads a file in a subdirectory of the root', () => {
    workspace('config/allowed.json');
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'allowed.json'), JSON.stringify(['prisma']));
    expect(buildPolicy(root).allowed).toEqual(['prisma']);
  });

  it('drops entries that are not package names', () => {
    workspace('allowed.json');
    writeFileSync(join(root, 'allowed.json'), JSON.stringify(['../evil', 'Bad Name', 'sharp', 7]));
    expect(buildPolicy(root).allowed).toEqual(['sharp']);
  });

  it('does not read a path that leaves the root', () => {
    writeFileSync(join(base, 'outside.json'), JSON.stringify(['prisma']));
    workspace('../outside.json');
    expect(buildPolicy(root).allowed).toEqual([]);
  });

  it('does not read an absolute path outside the root', () => {
    const outside = join(base, 'outside.json');
    writeFileSync(outside, JSON.stringify(['prisma']));
    workspace(JSON.stringify(outside));
    expect(buildPolicy(root).allowed).toEqual([]);
  });

  it('does not read a file that is a link', () => {
    writeFileSync(join(root, 'real.json'), JSON.stringify(['prisma']));
    symlinkSync(join(root, 'real.json'), join(root, 'allowed.json'));
    workspace('allowed.json');
    expect(buildPolicy(root).allowed).toEqual([]);
  });

  it('does not read through a directory that is a link out of the root', () => {
    mkdirSync(join(base, 'elsewhere'));
    writeFileSync(join(base, 'elsewhere', 'allowed.json'), JSON.stringify(['prisma']));
    symlinkSync(join(base, 'elsewhere'), join(root, 'config'));
    workspace('config/allowed.json');
    expect(buildPolicy(root).allowed).toEqual([]);
  });

  it('does not read a file over the size cap', () => {
    workspace('allowed.json');
    writeFileSync(join(root, 'allowed.json'), JSON.stringify(['prisma', 'x'.repeat(300 * 1024)]));
    expect(buildPolicy(root).allowed).toEqual([]);
  });

  it('reads the file named in package.json`s pnpm field', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', pnpm: { onlyBuiltDependenciesFile: 'allowed.json' } }),
    );
    writeFileSync(join(root, 'allowed.json'), JSON.stringify(['prisma']));
    expect(buildPolicy(root).allowed).toEqual(['prisma']);
  });
});
