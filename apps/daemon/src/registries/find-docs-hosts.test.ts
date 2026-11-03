import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { checkWebHost } from '../permissions';
import { docsHostsOfPackageJson, DOCS_HOSTS_BY_PACKAGE, findDocsHosts } from './index';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

function project(files: Readonly<Record<string, string>>): string {
  const dir = tempDir('docs hosts');
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir.path;
}

const manifest = (dependencies: Readonly<Record<string, string>>): string =>
  JSON.stringify({ name: 'app', dependencies });

describe('docsHostsOfPackageJson', () => {
  it.each<[string, string, string[]]>([
    ['a named package', manifest({ react: '19.0.0' }), ['react.dev']],
    ['a package of a known scope', manifest({ '@mantine/core': '8.0.0' }), ['mantine.dev']],
    [
      'dev and peer dependencies too',
      JSON.stringify({ devDependencies: { vitest: '5' }, peerDependencies: { zod: '4' } }),
      ['vitest.dev', 'zod.dev'],
    ],
    ['a package 10db has no host for', manifest({ 'left-pad': '1.3.0' }), []],
    ['a package named like a table key', manifest({ constructor: '1.0.0' }), []],
    ['a manifest that is not JSON', '{ nope', []],
    ['a manifest with no dependencies', '{}', []],
    ['dependencies of the wrong shape', '{"dependencies": ["react"]}', []],
  ])('%s', (_name, text, expected) => {
    expect(docsHostsOfPackageJson(text).filter((h) => !GENERAL.includes(h))).toEqual(expected);
  });

  // A lane in shared mode can write this file; none of these words comes from it.
  it.each<[string, string]>([
    ['a homepage', '{"homepage": "https://evil.example.net/docs"}'],
    ['a documentation field', '{"documentation": "https://evil.example.net/"}'],
    ['a repository', '{"repository": "https://evil.example.net/x.git"}'],
    ['a dependency URL', manifest({ x: 'https://evil.example.net/x.tgz' })],
    ['a dependency named as a host', manifest({ 'evil.example.net': '1.0.0' })],
  ])('takes no host from %s', (_name, text) => {
    expect(docsHostsOfPackageJson(text).join()).not.toContain('evil.example.net');
  });
});

const GENERAL = ['www.npmjs.com', 'developer.mozilla.org'];

describe('findDocsHosts', () => {
  it('names the hub of each language and the docs of named packages, with the file', async () => {
    const root = project({
      'package.json': manifest({ react: '19.0.0' }),
      'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "x"\n',
      'services/api/go.mod': 'module x\n',
      'tools/requirements.txt': 'requests\n',
    });
    expect(await findDocsHosts(root)).toEqual([
      { host: 'www.npmjs.com', file: 'package.json' },
      { host: 'developer.mozilla.org', file: 'package.json' },
      { host: 'react.dev', file: 'package.json' },
      { host: 'pypi.org', file: 'tools/requirements.txt' },
      { host: 'pkg.go.dev', file: 'services/api/go.mod' },
      { host: 'docs.rs', file: 'apps/desktop/src-tauri/Cargo.toml' },
    ]);
  });

  it('never reads node_modules or follows a link', async () => {
    const root = project({
      'node_modules/x/package.json': manifest({ react: '19.0.0' }),
      'outside/package.json': manifest({ vue: '3.0.0' }),
    });
    symlinkSync(join(root, 'outside/package.json'), join(root, 'package.json'));
    expect(await findDocsHosts(join(root))).toEqual([
      { host: 'www.npmjs.com', file: 'outside/package.json' },
      { host: 'developer.mozilla.org', file: 'outside/package.json' },
      { host: 'vuejs.org', file: 'outside/package.json' },
    ]);
  });

  it('finds nothing in a project with no manifest', async () => {
    expect(await findDocsHosts(project({ 'README.md': 'hello' }))).toEqual([]);
  });
});

describe('the table of documentation hosts', () => {
  it.each(Object.entries(DOCS_HOSTS_BY_PACKAGE))(
    '%s names a host a list may hold',
    (_key, host) => {
      expect(checkWebHost(host)).toBe(host);
    },
  );
});
