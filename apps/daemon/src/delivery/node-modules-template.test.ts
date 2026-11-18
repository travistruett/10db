import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { silentLogger } from '../log';
import {
  createNodeModulesTemplates,
  nodeModulesDirs,
  templateKey,
  templatesRoot,
} from './node-modules-template';

let tmp: TempDir;
let copy: string;
let root: string;
const signal = new AbortController().signal;

beforeEach(() => {
  tmp = tempDir('nm-template');
  copy = join(tmp.path, 'copy');
  root = templatesRoot(join(tmp.path, 'data'));
  mkdirSync(copy);
});
afterEach(() => {
  tmp.cleanup();
});

const WORKSPACE_LOCKFILE = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .:',
  '    devDependencies:',
  '      left-pad:',
  '        specifier: 1.3.0',
  '        version: 1.3.0',
  '  packages/app:',
  '    dependencies:',
  '      lib:',
  '        specifier: workspace:*',
  '        version: link:../lib',
  '  packages/lib: {}',
  '',
].join('\n');

function write(base: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, relative)), { recursive: true });
    writeFileSync(join(base, relative), content);
  }
}

/** A pnpm workspace copy with its packages installed: a root and a nested `node_modules`, and a relative link. */
function installedWorkspace(at: string): void {
  write(at, {
    'pnpm-lock.yaml': WORKSPACE_LOCKFILE,
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'package.json': '{"name":"root"}\n',
    'packages/app/package.json': '{"name":"app"}\n',
    'packages/lib/package.json': '{"name":"lib"}\n',
    'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'node_modules/.modules.yaml': 'packageManager: pnpm@10.0.0\n',
  });
  symlinkSync('.pnpm/left-pad@1.3.0/node_modules/left-pad', join(at, 'node_modules', 'left-pad'));
  mkdirSync(join(at, 'packages/app/node_modules'));
  symlinkSync('../../lib', join(at, 'packages/app/node_modules/lib'));
}

describe('templateKey', () => {
  const base = {
    'pnpm-lock.yaml': WORKSPACE_LOCKFILE,
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    '.npmrc': 'auto-install-peers=true\n',
    'package.json': '{"name":"root"}\n',
    'packages/app/package.json': '{"name":"app"}\n',
    'packages/lib/package.json': '{"name":"lib"}\n',
  };
  const keyOf = (files: Record<string, string>, version: string | null = '10.0.0') => {
    const at = join(tmp.path, `k-${String(Math.random()).slice(2)}`);
    write(at, files);
    return templateKey(at, version);
  };

  it('is the same for the same inputs, and 32 hex characters', () => {
    const key = keyOf(base);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf(base)).toBe(key);
  });

  it.each<[string, Record<string, string>, string?]>([
    ['the lockfile changed', { 'pnpm-lock.yaml': `${WORKSPACE_LOCKFILE}# more\n` }],
    ['a workspace package manifest changed', { 'packages/app/package.json': '{"name":"app2"}\n' }],
    ['the root manifest changed', { 'package.json': '{"name":"root2"}\n' }],
    ['.npmrc changed', { '.npmrc': 'node-linker=hoisted\n' }],
    ['the workspace yaml changed', { 'pnpm-workspace.yaml': 'packages:\n  - other/*\n' }],
    ['the pnpm version changed', {}, '10.0.1'],
  ])('changes when %s', (_name, change, version) => {
    expect(keyOf({ ...base, ...change }, version)).not.toBe(keyOf(base));
  });

  it('keeps the key when an unrelated file changes', () => {
    expect(keyOf({ ...base, 'src/index.ts': 'export {};\n' })).toBe(keyOf(base));
  });

  it('is null with no lockfile, no pnpm version, or a manifest that is a link', () => {
    const without = (name: string) =>
      Object.fromEntries(Object.entries(base).filter(([file]) => file !== name));
    expect(keyOf(without('pnpm-lock.yaml'))).toBeNull();
    expect(keyOf(base, null)).toBeNull();
    const at = join(tmp.path, 'linked');
    write(at, { ...without('package.json'), 'elsewhere.json': '{}\n' });
    symlinkSync('elsewhere.json', join(at, 'package.json'));
    expect(templateKey(at, '10.0.0')).toBeNull();
  });
});

describe('a node_modules template', () => {
  it('captures a copy and clones it into another with its nested node_modules and relative links', async () => {
    installedWorkspace(copy);
    const key = templateKey(copy, '10.0.0');
    if (key === null) throw new Error('no key');
    const templates = createNodeModulesTemplates({ root, logger: silentLogger });
    await templates.capture({ key, path: copy });
    expect(readdirSync(root)).toEqual([key]);

    const other = join(tmp.path, 'other');
    installedWorkspace(other);
    rmSync(join(other, 'node_modules'), { recursive: true });
    rmSync(join(other, 'packages/app/node_modules'), { recursive: true });
    expect(await templates.cloneInto({ key, path: other, signal })).toBe('cloned');
    expect(readFileSync(join(other, 'node_modules/left-pad/index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
    expect(readlinkSync(join(other, 'packages/app/node_modules/lib'))).toBe('../../lib');
    expect(nodeModulesDirs(other)).toEqual(['node_modules', 'packages/app/node_modules']);
  });

  it('answers none when no template has the key', async () => {
    installedWorkspace(copy);
    const templates = createNodeModulesTemplates({ root, logger: silentLogger });
    expect(await templates.cloneInto({ key: 'f'.repeat(32), path: copy, signal })).toBe('none');
    // The copy's own install is left alone.
    expect(existsSync(join(copy, 'node_modules/left-pad'))).toBe(true);
  });

  it('keeps one template when the same key is captured twice', async () => {
    installedWorkspace(copy);
    const key = templateKey(copy, '10.0.0');
    if (key === null) throw new Error('no key');
    const templates = createNodeModulesTemplates({ root, logger: silentLogger });
    await Promise.all([
      templates.capture({ key, path: copy }),
      templates.capture({ key, path: copy }),
    ]);
    await templates.capture({ key, path: copy });
    expect(readdirSync(root)).toEqual([key]);
  });

  it.each([
    ['a kept template stays', 'kept', ['kept'], true],
    ['a template no copy uses goes', 'stale', [], false],
    ['a staging directory a crash left goes', '.staging-1234', [], false],
  ])('sweeps: %s', async (_name, entry, keep, stays) => {
    mkdirSync(join(root, entry, 'tree'), { recursive: true });
    const templates = createNodeModulesTemplates({ root, logger: silentLogger });
    await templates.sweep(new Set(keep));
    expect(existsSync(join(root, entry))).toBe(stays);
  });

  it('sweeps no template a clone is reading', async () => {
    installedWorkspace(copy);
    const key = templateKey(copy, '10.0.0');
    if (key === null) throw new Error('no key');
    const templates = createNodeModulesTemplates({ root, logger: silentLogger });
    await templates.capture({ key, path: copy });
    const other = join(tmp.path, 'other');
    installedWorkspace(other);
    const cloning = templates.cloneInto({ key, path: other, signal });
    const sweeping = templates.sweep(new Set());
    expect(await cloning).toBe('cloned');
    await sweeping;
    expect(existsSync(join(root, key))).toBe(true);
  });
});
