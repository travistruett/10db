import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { checkInstall, removeBrokenInstall } from './install-health';

let tmp: TempDir;
let root: string;

beforeEach(() => {
  tmp = tempDir('install-health');
  root = join(tmp.path, 'copy');
  mkdirSync(root);
});
afterEach(() => {
  tmp.cleanup();
});

const LOCKFILE = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    devDependencies:',
  '      tsx:',
  '        specifier: 4.23.15',
  '        version: 4.23.15',
  '  apps/daemon:',
  '    dependencies:',
  "      '@10db/contracts':",
  '        specifier: workspace:*',
  '        version: link:../../packages/contracts',
  '      zod:',
  '        specifier: 4.6.7',
  '        version: 4.6.7',
  '  packages/contracts: {}',
  '',
].join('\n');

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `name` in the virtual store, linked from the node_modules of `where` the way pnpm does. */
function link(where: string, name: string): void {
  const store = join(
    root,
    'node_modules/.pnpm',
    `${name.replace('/', '+')}@1.0.0/node_modules`,
    name,
  );
  mkdirSync(store, { recursive: true });
  const at = join(root, where, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(store, at);
}

function install(): void {
  write(join(root, 'pnpm-lock.yaml'), LOCKFILE);
  mkdirSync(join(root, 'packages/contracts'), { recursive: true });
  link('.', 'tsx');
  link('apps/daemon', 'zod');
  mkdirSync(join(root, 'apps/daemon/node_modules/@10db'), { recursive: true });
  symlinkSync(
    join(root, 'packages/contracts'),
    join(root, 'apps/daemon/node_modules/@10db/contracts'),
  );
}

describe('checkInstall', () => {
  it('has nothing to check in a project without a pnpm lockfile', () => {
    expect(checkInstall(root)).toEqual({ kind: 'not_pnpm' });
  });

  it('calls an install whole when every package of the lockfile resolves its dependencies', () => {
    install();
    expect(checkInstall(root)).toEqual({ kind: 'whole' });
  });

  it("reads a pnpm 12 lockfile, whose env document comes before the project's own", () => {
    install();
    const env = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    configDependencies: {}',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.15.0',
      '        version: 12.15.0',
      '',
      '---',
      '',
    ].join('\n');
    write(join(root, 'pnpm-lock.yaml'), env + LOCKFILE);
    expect(checkInstall(root)).toEqual({ kind: 'whole' });
    rmSync(join(root, 'apps/daemon/node_modules/zod'));
    expect(checkInstall(root)).toMatchObject({
      kind: 'broken',
      missing: ['apps/daemon: zod'],
      total: 3,
    });
  });

  it('names the dependencies that do not resolve when node_modules is missing', () => {
    write(join(root, 'pnpm-lock.yaml'), LOCKFILE);
    const result = checkInstall(root);
    expect(result).toMatchObject({ kind: 'broken', total: 3 });
    if (result.kind !== 'broken') return;
    expect(result.missing).toContain('apps/daemon: zod');
    expect(result.missing).toContain('.: tsx');
  });

  it('finds a link whose target was pruned from the virtual store', () => {
    install();
    // What a half-removed .pnpm leaves: the link stays, its target is gone.
    const dangling = join(root, 'apps/daemon/node_modules/zod');
    // Replace the good link with one to nothing.
    rmSync(dangling);
    symlinkSync(join(root, 'node_modules/.pnpm/gone'), dangling);
    expect(checkInstall(root)).toMatchObject({ kind: 'broken', missing: ['apps/daemon: zod'] });
  });

  it('calls a hoisted install whole: a dependency in the root node_modules resolves from a package', () => {
    // node-linker=hoisted (or dedupe-direct-deps): packages/app has no node_modules of its own.
    write(
      join(root, 'pnpm-lock.yaml'),
      [
        'importers:',
        '  .: {}',
        '  packages/app:',
        '    dependencies:',
        '      react:',
        '        version: 19.0.0',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'packages/app'), { recursive: true });
    mkdirSync(join(root, 'node_modules/react'), { recursive: true });
    expect(checkInstall(root)).toEqual({ kind: 'whole' });
  });

  it('does not look above the copy for a dependency', () => {
    write(
      join(root, 'pnpm-lock.yaml'),
      [
        'importers:',
        '  .:',
        '    dependencies:',
        '      above:',
        '        version: 1.0.0',
        '',
      ].join('\n'),
    );
    mkdirSync(join(tmp.path, 'node_modules/above'), { recursive: true });
    expect(checkInstall(root)).toMatchObject({ kind: 'broken', missing: ['.: above'] });
  });

  it('reads a lockfile it cannot parse as broken, not as whole', () => {
    write(join(root, 'pnpm-lock.yaml'), 'importers: [unclosed');
    expect(checkInstall(root).kind).toBe('broken');
  });

  it('ignores an importer path that leaves the copy', () => {
    write(
      join(root, 'pnpm-lock.yaml'),
      [
        'importers:',
        '  ../../elsewhere:',
        '    dependencies:',
        '      x:',
        '        version: 1.0.0',
        '',
      ].join('\n'),
    );
    expect(checkInstall(root)).toEqual({ kind: 'whole' });
  });
});

describe('removeBrokenInstall', () => {
  it('removes the root node_modules and leaves the sources', () => {
    install();
    write(join(root, 'src/a.ts'), 'export {};');
    removeBrokenInstall(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
  });

  it('removes a node_modules that is a link without touching its target', () => {
    const outside = join(tmp.path, 'outside');
    write(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(root, 'node_modules'));
    removeBrokenInstall(root);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });
});
