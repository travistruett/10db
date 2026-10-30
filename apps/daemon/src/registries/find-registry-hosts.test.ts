import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { findRegistryHosts } from './index';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A project folder holding `files` (relative path to text). */
function project(files: Readonly<Record<string, string>>): string {
  const dir = tempDir('registries');
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir.path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir.path;
}

const hostsOf = async (root: string) =>
  (await findRegistryHosts(root)).map((f) => `${f.host} <- ${f.file}`).sort();

interface Row {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expected: readonly string[];
}

const rows: Row[] = [
  {
    name: 'Cargo.lock with the crates.io index names the sparse index and the download host',
    files: {
      'Cargo.lock':
        '[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    },
    expected: ['index.crates.io <- Cargo.lock', 'static.crates.io <- Cargo.lock'],
  },
  {
    name: 'Cargo.lock with only path dependencies names nothing',
    files: { 'Cargo.lock': '[[package]]\nname = "app"\nversion = "0.1.0"\n' },
    expected: [],
  },
  {
    name: 'Cargo.lock sparse registry and git source',
    files: {
      'Cargo.lock':
        'source = "sparse+https://crates.example.com/index/"\nsource = "git+https://github.com/o/r?rev=abc#def"\n',
    },
    expected: ['crates.example.com <- Cargo.lock', 'github.com <- Cargo.lock'],
  },
  {
    name: 'package-lock.json resolved URLs, and the default registry',
    files: {
      'package-lock.json':
        '{"packages":{"node_modules/a":{"resolved":"https://registry.npmjs.org/a/-/a-1.tgz"},"node_modules/b":{"resolved":"https://npm.internal.example.com/b/-/b-1.tgz"}}}',
    },
    expected: [
      'npm.internal.example.com <- package-lock.json',
      'registry.npmjs.org <- package-lock.json',
    ],
  },
  {
    name: 'pnpm-lock.yaml names the default registry and a tarball host',
    files: {
      'pnpm-lock.yaml':
        "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {integrity: sha512-x}\n  b@1.0.0:\n    resolution: {tarball: https://codeload.github.com/o/b/tar.gz/abc}\n",
    },
    expected: ['codeload.github.com <- pnpm-lock.yaml', 'registry.npmjs.org <- pnpm-lock.yaml'],
  },
  {
    name: 'yarn.lock v1 resolved lines',
    files: {
      'yarn.lock':
        'a@^1:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/a/-/a-1.tgz#abc"\n',
    },
    expected: ['registry.yarnpkg.com <- yarn.lock'],
  },
  {
    name: 'a registry set in .npmrc replaces the default for the lockfile beside it',
    files: {
      '.npmrc': 'registry=https://npm.corp.example.com/\n',
      'pnpm-lock.yaml':
        "lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: {integrity: sha512-x}\n",
    },
    expected: ['npm.corp.example.com <- .npmrc'],
  },
  {
    name: '.npmrc scoped registries and auth lines name hosts only',
    files: {
      '.npmrc':
        '@acme:registry=https://npm.acme.example.com/\n//npm.acme.example.com/:_authToken=${ACME_TOKEN}\n//other.example.com/:_authToken=secret-token\n',
    },
    expected: ['npm.acme.example.com <- .npmrc', 'other.example.com <- .npmrc'],
  },
  {
    name: '.yarnrc.yml npmRegistryServer',
    files: { '.yarnrc.yml': 'npmRegistryServer: "https://yarn.corp.example.com"\n' },
    expected: ['yarn.corp.example.com <- .yarnrc.yml'],
  },
  {
    name: '.cargo/config.toml registries and replaced sources',
    files: {
      '.cargo/config.toml':
        '[registries.corp]\nindex = "sparse+https://cargo.corp.example.com/index/"\n[source.crates-io]\nreplace-with = "mirror"\n[source.mirror]\nregistry = "sparse+https://mirror.example.com/"\n',
    },
    expected: [
      'cargo.corp.example.com <- .cargo/config.toml',
      'mirror.example.com <- .cargo/config.toml',
    ],
  },
  {
    name: 'uv.lock registry and file hosts',
    files: {
      'uv.lock':
        '[[package]]\nname = "a"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/a.tar.gz", hash = "sha256:x" }\n',
    },
    expected: ['files.pythonhosted.org <- uv.lock', 'pypi.org <- uv.lock'],
  },
  {
    name: 'poetry.lock names PyPI by default and a private source by url; descriptions are not read',
    files: {
      'poetry.lock':
        '[[package]]\nname = "a"\ndescription = "see https://docs.example.org/a"\n[package.source]\ntype = "legacy"\nurl = "https://py.corp.example.com/simple"\n',
    },
    expected: [
      'files.pythonhosted.org <- poetry.lock',
      'py.corp.example.com <- poetry.lock',
      'pypi.org <- poetry.lock',
    ],
  },
  {
    name: 'Gemfile.lock remote',
    files: { 'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    a (1.0)\n' },
    expected: ['rubygems.org <- Gemfile.lock'],
  },
  {
    name: 'go.sum names the module proxy and checksum database',
    files: { 'go.sum': 'github.com/a/b v1.0.0 h1:abc=\n' },
    expected: ['proxy.golang.org <- go.sum', 'sum.golang.org <- go.sum'],
  },
  {
    name: 'pip.conf index urls',
    files: {
      'pip.conf':
        '[global]\nindex-url = https://pip.corp.example.com/simple\nextra-index-url =\n  https://extra.example.com/simple\n  https://more.example.com/simple\n',
    },
    expected: [
      'extra.example.com <- pip.conf',
      'more.example.com <- pip.conf',
      'pip.corp.example.com <- pip.conf',
    ],
  },
  {
    name: 'pyproject indexes, not project links',
    files: {
      'pyproject.toml':
        '[project.urls]\nHomepage = "https://example.org"\nurl = "https://not-an-index.example.org"\n[[tool.uv.index]]\nname = "corp"\nurl = "https://uv.corp.example.com/simple"\n[[tool.poetry.source]]\nname = "p"\nurl = "https://poetry.corp.example.com/simple"\n',
    },
    expected: [
      'poetry.corp.example.com <- pyproject.toml',
      'uv.corp.example.com <- pyproject.toml',
    ],
  },
  {
    name: 'toolchain files',
    files: {
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.90"\n',
      '.nvmrc': '22\n',
    },
    expected: ['nodejs.org <- .nvmrc', 'static.rust-lang.org <- rust-toolchain.toml'],
  },
  {
    name: 'files in a package folder name their folder',
    files: {
      'apps/api/Cargo.lock': 'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    },
    expected: ['index.crates.io <- apps/api/Cargo.lock', 'static.crates.io <- apps/api/Cargo.lock'],
  },
  {
    name: 'the first file to name a host is the one reported',
    files: {
      'Cargo.lock': 'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      'apps/api/Cargo.lock': 'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    },
    expected: ['index.crates.io <- Cargo.lock', 'static.crates.io <- Cargo.lock'],
  },
  {
    name: 'a loopback, a bare name and an unparsable value are skipped',
    files: {
      '.npmrc':
        'registry=http://localhost:4873/\n@a:registry=https://${HOST}/\n@b:registry=not a url\n@c:registry=https://intranet/\n',
    },
    expected: [],
  },
  {
    name: 'node_modules, target and dot folders are not entered',
    files: {
      'node_modules/x/Cargo.lock':
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      'target/Cargo.lock': 'source = "git+https://github.com/o/r"\n',
      '.hidden/pip.conf': '[global]\nindex-url = https://hidden.example.com/simple\n',
    },
    expected: [],
  },
];

describe('findRegistryHosts', () => {
  it.each(rows)('$name', async ({ files, expected }) => {
    expect(await hostsOf(project(files))).toEqual([...expected].sort());
  });

  it('allows a private registry by host only: the token in its URL is never returned', async () => {
    const root = project({
      '.npmrc':
        'registry=https://deploy:s3cr3t-token@npm.corp.example.com:8443/path/s3cr3t-token/\n',
      'Cargo.lock': 'source = "sparse+https://u:cargo-secret@cargo.corp.example.com/index/"\n',
    });
    const found = await findRegistryHosts(root);
    expect(found.map((f) => f.host).sort()).toEqual([
      'cargo.corp.example.com',
      'npm.corp.example.com',
    ]);
    expect(JSON.stringify(found)).not.toMatch(/s3cr3t|cargo-secret|deploy|8443/);
  });

  it('does not follow a link', async () => {
    const outside = project({ 'Cargo.lock': 'source = "git+https://github.com/o/r"\n' });
    const root = project({});
    symlinkSync(join(outside, 'Cargo.lock'), join(root, 'Cargo.lock'));
    symlinkSync(outside, join(root, 'linked'));
    expect(await hostsOf(root)).toEqual([]);
  });

  it('reads nothing from a folder that is not there', async () => {
    expect(await findRegistryHosts(join(tempDir('none').path, 'missing'))).toEqual([]);
  });
});
