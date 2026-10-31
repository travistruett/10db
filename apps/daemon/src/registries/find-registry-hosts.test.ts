import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import { findRegistryHosts, findRegistryHostsAt } from './index';
import { CONFIG_FORMATS, LOCK_FORMATS, namesNpmRegistry } from './package-file-formats';

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
    name: 'an .npmrc setting for a registry names its host only when its key ends in a setting',
    files: {
      '.npmrc':
        '  //npm.example.com:8443/path/:_authToken=x\n//no-setting.example.com/=x\n//spaced.example.com/:a key=x\n',
    },
    expected: ['npm.example.com <- .npmrc'],
  },
  {
    name: 'a registry set in the root .npmrc replaces the default for a package folder’s lockfile',
    files: {
      '.npmrc': 'registry=https://npm.corp.example.com/\n',
      'apps/web/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    expected: ['npm.corp.example.com <- .npmrc'],
  },
  {
    name: 'a registry set in a package folder replaces the default for that folder only',
    files: {
      'apps/a/.npmrc': 'registry=https://npm.a.example.com/\n',
      'apps/a/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'apps/b/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    expected: ['npm.a.example.com <- apps/a/.npmrc', 'registry.npmjs.org <- apps/b/pnpm-lock.yaml'],
  },
  {
    name: '.yarnrc.yml npmRegistryServer',
    files: { '.yarnrc.yml': 'npmRegistryServer: "https://yarn.corp.example.com"\n' },
    expected: ['yarn.corp.example.com <- .yarnrc.yml'],
  },
  {
    name: 'a scoped Yarn registry names its own host and leaves the default for every other package',
    files: {
      '.yarnrc.yml':
        'nodeLinker: node-modules\nnpmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example.com"\n',
      // A Yarn Berry lockfile names no URL, only each package's resolution.
      'yarn.lock':
        '__metadata:\n  version: 8\n\n"left-pad@npm:^1.3.0":\n  version: 1.3.0\n  resolution: "left-pad@npm:1.3.0"\n',
    },
    expected: ['npm.corp.example.com <- .yarnrc.yml', 'registry.yarnpkg.com <- yarn.lock'],
  },
  {
    name: 'a top-level Yarn registry replaces the default',
    files: {
      '.yarnrc.yml': 'npmRegistryServer: "https://yarn.corp.example.com"\n',
      'yarn.lock': '__metadata:\n  version: 8\n',
    },
    expected: ['yarn.corp.example.com <- .yarnrc.yml'],
  },
  {
    name: 'a registry URL with an escaped path, such as an Azure Artifacts feed, names its host',
    files: {
      '.npmrc':
        'registry=https://pkgs.dev.azure.com/acme/My%20Project/_packaging/feed/npm/registry/\n',
      'package-lock.json':
        '{"packages":{"node_modules/a":{"resolved":"https://pkgs.dev.azure.com/acme/My%20Project/_packaging/feed/npm/registry/a/-/a-1.tgz"}}}',
    },
    expected: ['pkgs.dev.azure.com <- .npmrc'],
  },
  {
    name: 'a registry URL with an escaped password names its host',
    files: {
      'pip.conf': '[global]\nindex-url = https://deploy:p%40ss@pypi.corp.example.com/simple\n',
    },
    expected: ['pypi.corp.example.com <- pip.conf'],
  },
  {
    name: 'a variable in the user name or password of a registry URL leaves its host to read',
    files: { '.npmrc': 'registry=https://deploy:${NPM_TOKEN}@npm.corp.example.com/npm/\n' },
    expected: ['npm.corp.example.com <- .npmrc'],
  },
  {
    name: 'pyproject and uv.toml index arrays and inline tables',
    files: {
      'pyproject.toml':
        '[tool.uv]\nextra-index-url = ["https://extra.corp.example.com/simple"]\nindex = [{ name = "corp", url = "https://inline.corp.example.com/simple" }]\n',
      'uv.toml':
        'extra-index-url = [\n  "https://one.corp.example.com/simple", # the first\n  # "https://commented.example.com/simple",\n  \'https://two.corp.example.com/simple\',\n]\n',
    },
    expected: [
      'extra.corp.example.com <- pyproject.toml',
      'inline.corp.example.com <- pyproject.toml',
      'one.corp.example.com <- uv.toml',
      'two.corp.example.com <- uv.toml',
    ],
  },
  {
    name: '.cargo/config.toml inline tables, such as a mirror that replaces crates.io',
    files: {
      '.cargo/config.toml':
        '[source]\ncrates-io = { replace-with = "corp-mirror" }\ncorp-mirror = { registry = "sparse+https://mirror.corp.example.com/" }\n[registries]\ncorp = { index = "sparse+https://cargo.corp.example.com/index/" } # the corp one\n# old = { index = "sparse+https://old.example.com/index/" }\n',
    },
    expected: [
      'cargo.corp.example.com <- .cargo/config.toml',
      'mirror.corp.example.com <- .cargo/config.toml',
    ],
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
    name: 'a table header with spaces inside its brackets names its table',
    files: {
      'pyproject.toml':
        '[ tool.uv ]\nextra-index-url = ["https://spaced.example.com/simple"]\n[[ tool.uv.index ]]\nurl = "https://spaced-index.example.com/simple"\n[ project.urls ]\nurl = "https://not-an-index.example.org"\n',
    },
    expected: [
      'spaced-index.example.com <- pyproject.toml',
      'spaced.example.com <- pyproject.toml',
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
    name: 'files three folders down are read: a Tauri app’s src-tauri/Cargo.lock',
    files: {
      'apps/desktop/src-tauri/Cargo.lock':
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    },
    expected: [
      'index.crates.io <- apps/desktop/src-tauri/Cargo.lock',
      'static.crates.io <- apps/desktop/src-tauri/Cargo.lock',
    ],
  },
  {
    name: 'files four folders down are not read',
    files: {
      'a/b/c/d/Cargo.lock': 'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
    },
    expected: [],
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
    name: 'a wildcard in a URL names no host: no package manager fetches from one',
    files: {
      '.npmrc': '@x:registry=https://*.s3.amazonaws.com/\n@y:registry=https://*.example.com/\n',
      'Cargo.lock': 'source = "sparse+https://*.example.com/index/"\n',
      'pip.conf': '[global]\ntrusted-host = *.example.com *.s3.amazonaws.com\n',
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

  it('keeps only the host of an escaped URL: no password, user name or path', async () => {
    const root = project({
      '.npmrc':
        'registry=https://pkgs.dev.azure.com/acme/My%20Project/_packaging/feed/npm/registry/\n',
      'pip.conf': '[global]\nindex-url = https://deploy:p%40ss@pypi.corp.example.com/simple\n',
    });
    const found = await findRegistryHosts(root);
    expect(found.map((f) => f.host).sort()).toEqual([
      'pkgs.dev.azure.com',
      'pypi.corp.example.com',
    ]);
    expect(JSON.stringify(found)).not.toMatch(/p%40ss|p@ss|deploy|acme|My|_packaging|simple/);
  });

  it('does not follow a link', async () => {
    const outside = project({ 'Cargo.lock': 'source = "git+https://github.com/o/r"\n' });
    const root = project({});
    symlinkSync(join(outside, 'Cargo.lock'), join(root, 'Cargo.lock'));
    symlinkSync(outside, join(root, 'linked'));
    expect(await hostsOf(root)).toEqual([]);
  });

  it('does not follow a link in the middle of a path, such as .cargo linked to ~/.cargo', async () => {
    // The builder's own cargo settings, which the sandboxes deny, outside the project.
    const home = project({
      '.cargo/config.toml': '[registries.corp]\nindex = "sparse+https://home-only.example.com/"\n',
      'pkg/.npmrc': 'registry=https://home-npm.example.com/\n',
    });
    const root = project({ 'apps/web/package.json': '{}' });
    symlinkSync(join(home, '.cargo'), join(root, '.cargo'));
    symlinkSync(join(home, '.cargo'), join(root, 'apps', '.cargo'));
    symlinkSync(join(home, 'pkg'), join(root, 'apps', 'web', 'pkg'));
    expect(await hostsOf(root)).toEqual([]);
  });

  it('reads a project whose own path runs through a link', async () => {
    const real = project({ 'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n' });
    const links = project({});
    symlinkSync(real, join(links, 'project'));
    expect(await hostsOf(join(links, 'project'))).toEqual(['rubygems.org <- Gemfile.lock']);
  });

  it('reads nothing from a folder that is not there', async () => {
    const none = tempDir('none');
    dirs.push(none);
    expect(await findRegistryHosts(join(none.path, 'missing'))).toEqual([]);
  });
});

describe('findRegistryHostsAt', () => {
  const git = createGit();
  const run = (repo: string, ...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });

  /** A repository whose main branch commits `files` on top of the temp repo's README. */
  function committed(files: Readonly<Record<string, string>>): string {
    const repo = createTempRepo();
    dirs.push(repo);
    for (const [name, text] of Object.entries(files)) {
      const path = join(repo.path, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    run(repo.path, 'add', '--all', '--force');
    run(repo.path, 'commit', '-q', '--allow-empty', '-m', 'files');
    return repo.path;
  }

  it.each(rows)('reads what the folder reader reads: $name', async ({ files, expected }) => {
    const repo = committed(files);
    const found = await findRegistryHostsAt(git, repo, 'refs/heads/main');
    expect(found.map((f) => `${f.host} <- ${f.file}`).sort()).toEqual([...expected].sort());
  });

  it('reads the commit, not the files in the checkout', async () => {
    const repo = committed({ 'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n' });
    writeFileSync(join(repo, 'Gemfile.lock'), 'GEM\n  remote: https://evil.example.net/\n');
    writeFileSync(join(repo, '.npmrc'), '@x:registry=https://exfil.example.net/\n');
    expect(await findRegistryHostsAt(git, repo, 'refs/heads/main')).toEqual([
      { host: 'rubygems.org', file: 'Gemfile.lock' },
    ]);
  });

  it('reads a linked file as absent', async () => {
    const repo = createTempRepo();
    dirs.push(repo);
    writeFileSync(join(repo.path, 'real.lock'), 'GEM\n  remote: https://rubygems.org/\n');
    symlinkSync('real.lock', join(repo.path, 'Gemfile.lock'));
    run(repo.path, 'add', '--all');
    run(repo.path, 'commit', '-q', '-m', 'link');
    expect(await findRegistryHostsAt(git, repo.path, 'refs/heads/main')).toEqual([]);
  });

  it('throws for a branch that is not there', async () => {
    const repo = committed({});
    await expect(findRegistryHostsAt(git, repo, 'refs/heads/nope')).rejects.toThrow();
  });

  it('lists each folder once, as the walk reaches it, never below three levels', async () => {
    const repo = committed({
      'a/b/c/Cargo.lock': 'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      'a/b/c/d/e/Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n',
      'node_modules/x/y/z.txt': 'z',
    });
    const listed: string[] = [];
    const counting = {
      fileAt: git.fileAt.bind(git),
      folderAt: (r: string, rev: string, folder: string) => {
        listed.push(folder);
        return git.folderAt(r, rev, folder);
      },
    };

    const found = await findRegistryHostsAt(counting, repo, 'refs/heads/main');

    expect(found.map((f) => f.host)).toEqual(['index.crates.io', 'static.crates.io']);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.filter((f) => !f.includes('.'))).toEqual(['', 'a', 'a/b', 'a/b/c']);
    expect(listed.some((f) => f.startsWith('node_modules') || f.startsWith('a/b/c/d'))).toBe(false);
  });
});

/** Every file findRegistryHosts reads in a folder: settings files, lockfiles and toolchain files. */
const FORMATS = [...CONFIG_FORMATS, ...LOCK_FORMATS];

/** What those files name when they hold no URL: each ecosystem's default hosts. */
const DEFAULT_HOSTS = [
  'files.pythonhosted.org <- poetry.lock',
  'nodejs.org <- .nvmrc',
  'proxy.golang.org <- go.sum',
  'pypi.org <- poetry.lock',
  'registry.npmjs.org <- package-lock.json',
  'registry.yarnpkg.com <- yarn.lock',
  'static.rust-lang.org <- rust-toolchain.toml',
  'sum.golang.org <- go.sum',
];

/**
 * Text a backtracking pattern can spend time quadratic or worse in its size on, as any package file. A
 * pattern does its matching on the daemon's only thread, so a slow one stalls the API, every lane's
 * broker and every gate.
 */
const CRAFTED: readonly { readonly name: string; readonly text: string }[] = [
  { name: 'a run of blank lines', text: '\n'.repeat(200_000) },
  { name: 'a run of blank Windows lines', text: '\r\n'.repeat(200_000) },
  { name: 'a table header padded with spaces', text: `[${' '.repeat(50_000)}x\n` },
  { name: 'an .npmrc key with no colon', text: `//${'a'.repeat(200_000)}\n` },
  {
    name: 'a setting whose value holds a lone carriage return',
    text: `a=${' '.repeat(200_000)}x\ry\n`,
  },
];

describe('the package files on crafted text', () => {
  it.each(CRAFTED)('every format reads $name in time linear in its size', ({ text }) => {
    const started = performance.now();
    for (const format of FORMATS) format.hosts(text, { npmRegistryNamed: false });
    namesNpmRegistry(text);
    // Each format takes a few milliseconds over these texts; a quadratic one takes seconds.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each(CRAFTED)('findRegistryHosts reads $name in every package file', async ({ text }) => {
    const root = project(Object.fromEntries(FORMATS.map((format) => [format.path, text])));
    const started = performance.now();
    const found = await hostsOf(root);
    // Reading the files is most of this; a quadratic pattern alone takes far longer.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(found).toEqual(DEFAULT_HOSTS);
  });
});
