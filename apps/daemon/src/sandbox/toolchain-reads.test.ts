import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { childListingGrant, listingGrant, SandboxProfileError } from './profile';
import { homeProtectedReads, isEqualOrUnder } from './protected-reads';
import { SYSTEM_NODE_PREFIXES, toolchainAccess } from './toolchain-reads';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-tool-')));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Starts a folded case in an empty home of its own, so each case keeps its own real fixture. */
function freshHome(): void {
  rmSync(home, { recursive: true, force: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-tool-')));
}

/** Creates `rel` under `base` as a file, with its parent dirs. */
function plant(rel: string, base: string = home): string {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

/** A node install in a version manager's layout: its tool dirs, and an `etc` it must never open. */
function nodeInstall(rel: string): string {
  for (const file of [
    'bin/node',
    'lib/node_modules/npm/index.js',
    'include/node/node.h',
    'share/doc/x',
    'etc/npmrc',
  ])
    plant(join(rel, file));
  return join(home, rel);
}

const at = (rel: string): string => join(home, rel);

/** Hermetic: no system prefix is probed unless a test passes one. */
const access = (
  env: Record<string, string> = {},
  options: { untrustedRoots?: string[]; systemPrefixes?: string[] } = {},
) => toolchainAccess(home, env, homeProtectedReads(home), { systemPrefixes: [], ...options });

/** The registry-config entries of a secret list, leaving out cargo's and mise's own files. */
const npmrcs = (files: readonly string[]): string[] =>
  files.filter((file) => file.endsWith('npmrc'));

/** The files every secret list carries for this home: cargo's and mise's. */
const baseSecrets = (): string[] => [
  at('.cargo/config'),
  at('.cargo/config.toml'),
  at('.cargo/credentials'),
  at('.cargo/credentials.toml'),
  at('.config/mise/age.txt'),
];

/** A fake install prefix in a temp dir, probed in place of the real ones. */
const withPrefix = (build: (system: string) => void, check: (system: string) => void): void => {
  const system = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-sys-')));
  try {
    build(system);
    check(system);
  } finally {
    rmSync(system, { recursive: true, force: true });
  }
};
const probe = (system: string) => access({}, { systemPrefixes: [system] });

describe('toolchainAccess reads', () => {
  it("opens mise's state and cache and cargo's bin, never mise's config or cargo's credentials, and denies their keys", () => {
    plant('.config/mise/config.toml');
    plant('.config/mise/age.txt');
    const defaults = access();
    expect
      .soft(defaults.reads, 'default: reads')
      .toEqual([
        `${home}/.local/state/mise`,
        `${home}/.cache/mise`,
        `${home}/Library/Caches/mise`,
        `${home}/.cargo/bin`,
      ]);
    expect
      .soft(
        defaults.reads.filter((path) => path.startsWith(at('.config'))),
        'default: reads in .config',
      )
      .toEqual([]);
    expect.soft(defaults.secretFiles, 'default: age key').toContain(at('.config/mise/age.txt'));

    // mise's XDG dirs, and an age key a variable names.
    freshHome();
    plant('xdg/data/mise/installs/node/26.12.0/bin/node');
    const xdg = access({
      XDG_STATE_HOME: at('xdg/state'),
      XDG_CACHE_HOME: at('xdg/cache'),
      XDG_DATA_HOME: at('xdg/data'),
      MISE_AGE_KEY_FILE: at('keys/age.txt'),
    });
    expect
      .soft(xdg.reads, 'XDG: reads')
      .toEqual(
        expect.arrayContaining([
          at('xdg/state/mise'),
          at('xdg/cache/mise'),
          at('xdg/data/mise/installs/node/26.12.0/bin'),
        ]),
      );
    expect.soft(xdg.secretFiles, 'XDG: named age key').toContain(at('keys/age.txt'));

    // A state or cache dir that is, or holds, mise's config stays closed.
    const configDirs: [string, Record<string, string>, string][] = [
      [
        'a state dir that is the config dir',
        { MISE_STATE_DIR: at('.config/mise') },
        at('.config/mise'),
      ],
      [
        'a cache dir under the config dir',
        { MISE_CACHE_DIR: at('.config/mise/cache') },
        at('.config/mise/cache'),
      ],
      [
        'a state dir that holds the global config file',
        { MISE_STATE_DIR: at('mise-state'), MISE_GLOBAL_CONFIG_FILE: at('mise-state/global.toml') },
        at('mise-state'),
      ],
    ];
    for (const [name, env, dropped] of configDirs)
      expect.soft(access(env).reads, name).not.toContain(dropped);

    // Only the bin dir of ~/.cargo, with its credentials and config denied.
    for (const file of ['credentials', 'credentials.toml', 'config', 'config.toml'])
      plant(join('.cargo', file));
    const cargo = access({ PATH: at('.cargo') });
    expect
      .soft(
        cargo.reads.filter((path) => path.startsWith(at('.cargo'))),
        '~/.cargo on PATH: reads',
      )
      .toEqual([at('.cargo/bin')]);
    expect
      .soft(cargo.secretFiles, '~/.cargo: secrets')
      .toEqual(expect.arrayContaining(baseSecrets().slice(0, 4)));
    expect
      .soft(access({ CARGO_HOME: at('tools/cargo') }).secretFiles, 'custom CARGO_HOME: secrets')
      .toEqual(
        expect.arrayContaining([at('tools/cargo/credentials.toml'), at('tools/cargo/config.toml')]),
      );
  });

  it("opens each mise install's own entries, by written and real path, never a whole version or its etc", () => {
    const real = nodeInstall('.local/share/mise/installs/node/26.12.0');
    symlinkSync('./26.12.0', at('.local/share/mise/installs/node/26'));
    plant('.local/share/mise/installs/node/.mise.backend.toml');
    plant('.local/share/mise/installs/pnpm/12.13.0/pnpm');
    mkdirSync(at('.local/share/mise/shims'), { recursive: true });
    mkdirSync(at('.local/share/mise/downloads'), { recursive: true });
    const { reads, listings } = access();
    const linked = at('.local/share/mise/installs/node/26');
    for (const dir of ['bin', 'lib', 'include', 'share']) {
      expect.soft(reads, `install: real ${dir}`).toContain(join(real, dir));
      expect.soft(reads, `install: linked ${dir}`).toContain(join(linked, dir));
    }
    expect
      .soft(reads, 'install: shims, backend file, pnpm')
      .toEqual(
        expect.arrayContaining([
          at('.local/share/mise/shims'),
          at('.local/share/mise/installs/node/.mise.backend.toml'),
          at('.local/share/mise/installs/pnpm/12.13.0/pnpm'),
        ]),
      );
    expect
      .soft(
        reads.filter((path) => path.endsWith('/etc')),
        'install: etc',
      )
      .toEqual([]);
    expect.soft(reads, 'install: data dir').not.toContain(at('.local/share/mise'));
    expect.soft(reads, 'install: downloads').not.toContain(at('.local/share/mise/downloads'));
    // A version installed after the profile is built stays closed: none is opened whole, and the
    // only patterns are the two exact-match listings, so none reaches below a tool dir.
    expect.soft(reads, 'install: the whole version').not.toContain(real);
    expect.soft(listings, 'install: listings').toHaveLength(2);

    // A version linked into another granted read opens by its real path too.
    freshHome();
    plant('.cargo/bin/cargo');
    mkdirSync(at('.local/share/mise/installs/rust'), { recursive: true });
    symlinkSync(at('.cargo/bin'), at('.local/share/mise/installs/rust/1.99.1'));
    expect
      .soft(access().reads, 'linked into ~/.cargo/bin')
      .toEqual(
        expect.arrayContaining([
          at('.local/share/mise/installs/rust/1.99.1'),
          at('.local/share/mise/installs/rust/1.99.1/cargo'),
          at('.cargo/bin/cargo'),
        ]),
      );

    // A version linked elsewhere in home opens only by its written path, which the kernel refuses.
    freshHome();
    plant('elsewhere/node-22/bin/node');
    mkdirSync(at('.local/share/mise/installs/node'), { recursive: true });
    symlinkSync(at('elsewhere/node-22'), at('.local/share/mise/installs/node/22'));
    const elsewhere = access().reads;
    expect
      .soft(elsewhere, 'linked elsewhere: written bin')
      .toContain(at('.local/share/mise/installs/node/22/bin'));
    expect
      .soft(elsewhere, 'linked elsewhere: whole version')
      .not.toContain(at('.local/share/mise/installs/node/22'));
    expect
      .soft(
        elsewhere.filter((path) => path.startsWith(at('elsewhere'))),
        'linked elsewhere: target',
      )
      .toEqual([]);

    // Only an ancestor of a plain version is a link: still no whole version dir.
    freshHome();
    plant('.local/share/mise/store/installs/node/22.11.0/bin/node');
    symlinkSync(at('.local/share/mise/store/installs'), at('.local/share/mise/installs'));
    expect
      .soft(
        access().reads.filter((path) => path.endsWith('/node/22.11.0')),
        'linked ancestor: whole version',
      )
      .toEqual([]);
  });

  it('opens nvm, volta and rustup by their own layouts with no marker needed, never a whole version or an etc', () => {
    // Homebrew's nvm leaves no marker.
    plant('.nvm/alias/default');
    const v22 = nodeInstall('.nvm/versions/node/v22.1.0');
    const nvm = access().reads;
    expect
      .soft(nvm, 'nvm: script, aliases, installs')
      .toEqual(expect.arrayContaining([at('.nvm/alias'), join(v22, 'bin'), join(v22, 'lib')]));
    expect.soft(nvm, 'nvm: whole dir').not.toContain(at('.nvm'));
    expect.soft(nvm, 'nvm: etc').not.toContain(join(v22, 'etc'));

    freshHome();
    plant('.volta/bin/volta-shim');
    symlinkSync('volta-shim', at('.volta/bin/node'));
    plant('.volta/layout.v4');
    plant('.volta/tools/user/platform.json');
    const image = nodeInstall('.volta/tools/image/node/22.1.0');
    plant('.volta/tools/inventory/node/node-v22.1.0.tar.gz');
    const volta = access().reads;
    expect
      .soft(volta, 'volta: shims, state, image')
      .toEqual(
        expect.arrayContaining([
          at('.volta/bin'),
          at('.volta/layout.v4'),
          at('.volta/tools/user'),
          join(image, 'bin'),
        ]),
      );
    expect.soft(volta, 'volta: whole dir').not.toContain(at('.volta'));
    expect.soft(volta, 'volta: etc').not.toContain(join(image, 'etc'));
    expect.soft(volta, 'volta: inventory').not.toContain(at('.volta/tools/inventory'));

    freshHome();
    plant('.rustup/toolchains/stable/bin/cargo');
    expect.soft(access().reads, 'rustup: whole').toContain(at('.rustup'));

    // No etc dir is closed: no version of any manager opens whole, so nothing reaches its etc.
    freshHome();
    nodeInstall('.local/share/mise/installs/node/26.12.0');
    nodeInstall('.nvm/versions/node/v22.0.0');
    const both = access();
    expect
      .soft(
        both.secretFiles.filter((path) => path.endsWith('/etc')),
        'mise and nvm: etc denied',
      )
      .toEqual([]);
    expect
      .soft(
        both.reads.filter((path) => /\/etc(\/|$)/.test(path)),
        'mise and nvm: etc read',
      )
      .toEqual([]);
  });

  it("lists mise's installs dir and each tool dir by exact match, under whatever dir names them, and nothing else", () => {
    nodeInstall('.local/share/mise/installs/node/26.12.0');
    plant('.local/share/mise/installs/pnpm/12.13.0/pnpm');
    mkdirSync(at('.local/share/mise/downloads'), { recursive: true });
    plant('.local/share/mise/plugins/x/secret');
    const { reads, listings } = access();
    const installs = at('.local/share/mise/installs');
    expect
      .soft(listings, 'default: listings')
      .toEqual([listingGrant(installs), childListingGrant(installs)]);
    // A listing is not a read: nothing of the installs dir, or of any tool dir, opens whole.
    expect.soft(reads, 'default: installs dir').not.toContain(installs);
    expect.soft(reads, 'default: tool dir').not.toContain(join(installs, 'node'));
    expect.soft(reads, 'default: data dir').not.toContain(at('.local/share/mise'));
    expect
      .soft(
        reads.filter((path) => path.startsWith(at('.local/share/mise/plugins'))),
        'default: plugins',
      )
      .toEqual([]);
    expect
      .soft(
        reads.filter((path) => path.startsWith(at('.local/share/mise/downloads'))),
        'default: downloads',
      )
      .toEqual([]);

    freshHome();
    nodeInstall('mise-data/installs/node/26.12.0');
    expect
      .soft(access({ MISE_DATA_DIR: at('mise-data') }).listings, 'MISE_DATA_DIR')
      .toEqual([
        listingGrant(at('mise-data/installs')),
        childListingGrant(at('mise-data/installs')),
      ]);
    expect
      .soft(access({ MISE_DATA_DIR: at('absent') }).listings, 'missing MISE_DATA_DIR')
      .toEqual([]);

    // An installs dir that is a link lists by its written path, and by its real path only inside a
    // granted read.
    freshHome();
    nodeInstall('.local/share/mise/store/installs/node/26.12.0');
    symlinkSync(at('.local/share/mise/store/installs'), at('.local/share/mise/installs'));
    expect
      .soft(access().listings, 'linked installs in the data dir')
      .toEqual(
        expect.arrayContaining([
          listingGrant(at('.local/share/mise/installs')),
          listingGrant(at('.local/share/mise/store/installs')),
          childListingGrant(at('.local/share/mise/store/installs')),
        ]),
      );
    rmSync(at('.local/share/mise/installs'));
    plant('elsewhere/installs/node/22/bin/node');
    symlinkSync(at('elsewhere/installs'), at('.local/share/mise/installs'));
    const linked = access();
    expect
      .soft(linked.listings, 'linked installs elsewhere: written path')
      .toContain(listingGrant(at('.local/share/mise/installs')));
    expect
      .soft(
        linked.listings.filter((path) => path.includes(at('elsewhere'))),
        'linked installs elsewhere: real path listed',
      )
      .toEqual([]);
    expect
      .soft(
        linked.reads.filter((path) => path.startsWith(at('elsewhere'))),
        'linked installs elsewhere: real path read',
      )
      .toEqual([]);

    // nvm and volta need no listing.
    freshHome();
    nodeInstall('.nvm/versions/node/v22.0.0');
    nodeInstall('.volta/tools/image/node/22.0.0');
    expect.soft(access().listings, 'nvm and volta').toEqual([]);
  });

  it('opens a custom version-manager home under home', () => {
    const rows: [string, string, string][] = [
      ['NVM_DIR', 'tools/nvm', 'versions/node/v1/bin/node'],
      ['VOLTA_HOME', 'tools/volta', 'bin/volta'],
      ['RUSTUP_HOME', 'tools/rustup', 'settings.toml'],
      ['MISE_DATA_DIR', 'tools/mise', 'installs/node/1/bin/node'],
    ];
    for (const [name, dir, file] of rows) {
      freshHome();
      plant(join(dir, file));
      const named = join(home, dir);
      expect
        .soft(
          access({ [name]: named }).reads.some((path) => path.startsWith(named)),
          name,
        )
        .toBe(true);
    }
  });

  it('refuses a custom home that is a protected-read ancestor, a broad config or data dir, or the documents dir', () => {
    const rows: [string, string, string][] = [
      ['an ancestor of a protected read', 'NVM_DIR', 'Library'],
      ['a broad config dir', 'VOLTA_HOME', '.config'],
      ['a broad data dir', 'NVM_DIR', '.local/share'],
      ['the documents dir', 'RUSTUP_HOME', 'Documents'],
    ];
    for (const [what, name, dir] of rows) {
      freshHome();
      plant(join(dir, 'versions/node/v1/bin/node'));
      plant(join(dir, 'bin/volta'));
      expect
        .soft(access({ [name]: join(home, dir) }).reads, `${what}: ${name}=${dir}`)
        .toEqual(access().reads);
    }
  });

  it("refuses the session, naming the path, when an installs dir or an npmrc has a name the profile can't hold", () => {
    mkdirSync(at('we[ird]/installs'), { recursive: true });
    const build = () => access({ MISE_DATA_DIR: at('we[ird]') });
    expect.soft(build, 'installs dir').toThrow(SandboxProfileError);
    expect.soft(build, 'installs dir').toThrow(at('we[ird]/installs'));
    withPrefix(
      (system) => plant('x[1]/bin/node', system),
      (system) => {
        expect.soft(() => probe(system), 'npmrc').toThrow(SandboxProfileError);
        expect.soft(() => probe(system), 'npmrc').toThrow(join(system, 'x[1]/etc/npmrc'));
      },
    );
  });
});

describe('toolchainAccess PATH', () => {
  it("opens a PATH entry's own files and pnpm's installs by layout, never the dir, its other subdirectories or an etc", () => {
    plant('.local/bin/tool');
    plant('.local/bin/nested/nodejs/22/etc/npmrc');
    const own = access({ PATH: at('.local/bin') }).reads;
    expect.soft(own, 'own file').toContain(at('.local/bin/tool'));
    expect.soft(own, 'the dir').not.toContain(at('.local/bin'));
    expect
      .soft(
        own.filter((path) => path.startsWith(at('.local/bin/nested'))),
        'subdirectory',
      )
      .toEqual([]);
    expect
      .soft(
        access({ PATH: at('missing/bin') }).reads.filter((path) => path.startsWith(at('missing'))),
        "an entry that can't be listed",
      )
      .toEqual([]);

    plant('Library/pnpm/pnpm');
    const v22 = nodeInstall('Library/pnpm/nodejs/22.1.0');
    plant('Library/pnpm/.tools/pnpm/12.13.0/bin/pnpm');
    plant('Library/pnpm/.tools/pnpm/12.13.0/etc/npmrc');
    plant('Library/pnpm/global/5/node_modules/x/index.js');
    const entry = at('Library/pnpm');
    const { reads, secretFiles } = access({ PATH: entry });
    expect
      .soft(reads, 'pnpm: node installs and self-updates')
      .toEqual(
        expect.arrayContaining([
          join(entry, 'pnpm'),
          join(v22, 'bin'),
          join(v22, 'lib'),
          join(entry, '.tools/pnpm/12.13.0/bin'),
        ]),
      );
    expect
      .soft(
        reads.filter((path) => path.endsWith('/etc')),
        'pnpm: etc',
      )
      .toEqual([]);
    expect
      .soft(
        reads.filter((path) => path.includes('/global')),
        'pnpm: global',
      )
      .toEqual([]);
    expect
      .soft(secretFiles, 'pnpm: npmrcs')
      .toEqual(
        expect.arrayContaining([
          join(v22, 'lib/node_modules/npm/npmrc'),
          join(v22, 'etc/npmrc'),
          join(entry, '.tools/pnpm/12.13.0/etc/npmrc'),
        ]),
      );
  });

  it('drops a PATH entry, version manager home or mise home inside a checkout or the lane temp root, however a link names it', () => {
    plant('repo/node_modules/.bin/tool');
    plant('repo/node_modules/.bin/node');
    const entry = at('repo/node_modules/.bin');
    const trusted = access({ PATH: entry });
    expect.soft(trusted.reads, 'trusted entry: reads').toContain(join(entry, 'tool'));
    expect.soft(npmrcs(trusted.secretFiles), 'trusted entry: npmrcs').not.toEqual([]);
    const untrusted = access({ PATH: entry }, { untrustedRoots: [at('repo')] });
    expect.soft(untrusted.reads, 'entry in a checkout: reads').toEqual(access().reads);
    expect
      .soft(untrusted.secretFiles, 'entry in a checkout: secrets')
      .toEqual(access().secretFiles);

    // A trusted PATH dir laid out like pnpm lists nothing inside a checkout.
    freshHome();
    plant('tools/tool');
    nodeInstall('tools/nodejs/22');
    plant('tools/.tools/pnpm/12.13.0/bin/pnpm');
    const inside = at('tools/nodejs/22');
    const pnpm = access(
      { PATH: at('tools') },
      { untrustedRoots: [inside, at('tools/.tools/pnpm')] },
    );
    expect.soft(pnpm.reads, 'pnpm layout: own file').toContain(at('tools/tool'));
    expect
      .soft(
        pnpm.reads.filter((path) => path.startsWith(inside)),
        'pnpm layout: node in a checkout',
      )
      .toEqual([]);
    expect
      .soft(
        pnpm.reads.filter((path) => path.startsWith(at('tools/.tools'))),
        'pnpm layout: self-update in a checkout',
      )
      .toEqual([]);
    expect
      .soft(
        pnpm.secretFiles.filter((path) => path.startsWith(inside)),
        'pnpm layout: secrets in a checkout',
      )
      .toEqual([]);

    freshHome();
    nodeInstall('repo/nvm/versions/node/v22.1.0');
    expect
      .soft(
        access({ NVM_DIR: at('repo/nvm') }, { untrustedRoots: [at('repo')] }).reads.filter((path) =>
          path.startsWith(at('repo')),
        ),
        'NVM_DIR in a checkout',
      )
      .toEqual([]);

    freshHome();
    nodeInstall('proj/mise/installs/node/26.12.0');
    const mise = access({ MISE_DATA_DIR: at('proj/mise') }, { untrustedRoots: [at('proj')] });
    expect
      .soft(
        mise.reads.filter((path) => path.startsWith(at('proj'))),
        'mise home in a checkout: reads',
      )
      .toEqual([]);
    expect.soft(mise.listings, 'mise home in a checkout: listings').toEqual([]);

    freshHome();
    plant('repo/bin/tool');
    symlinkSync(at('repo/bin'), at('linkbin'));
    symlinkSync(at('repo'), at('repo-link'));
    const tools = (reads: string[]) => reads.filter((path) => path.endsWith('/tool'));
    expect
      .soft(
        tools(access({ PATH: at('linkbin') }, { untrustedRoots: [at('repo')] }).reads),
        'an entry that links into a checkout',
      )
      .toEqual([]);
    expect
      .soft(
        tools(access({ PATH: at('repo/bin') }, { untrustedRoots: [at('repo-link')] }).reads),
        'an entry in a checkout given by a link',
      )
      .toEqual([]);
  });

  it('drops a PATH entry outside home, or home in another spelling, from the reads', () => {
    // Outside home its node's npmrcs are still denied.
    withPrefix(
      (system) => {
        plant('Cellar/node/22.0.0/bin/node', system);
        mkdirSync(join(system, 'bin'));
        symlinkSync(join(system, 'Cellar/node/22.0.0/bin/node'), join(system, 'bin', 'node'));
      },
      (system) => {
        const { reads, secretFiles } = access({ PATH: join(system, 'bin') });
        expect
          .soft(
            reads.filter((path) => path.startsWith(system)),
            'outside home: reads',
          )
          .toEqual([]);
        expect
          .soft(npmrcs(secretFiles), 'outside home: npmrcs')
          .toEqual(
            [
              join(system, 'etc/npmrc'),
              join(system, 'lib/node_modules/npm/npmrc'),
              join(system, 'Cellar/node/22.0.0/etc/npmrc'),
              join(system, 'Cellar/node/22.0.0/lib/node_modules/npm/npmrc'),
            ].sort(),
          );
      },
    );
    if (process.platform === 'darwin')
      expect
        .soft(access({ PATH: home.toUpperCase() }).reads, 'a case-variant spelling of home')
        .toEqual(access().reads);
    const nfd = '/h/café';
    const nfc = '/h/café';
    expect
      .soft(
        toolchainAccess(nfc, { PATH: nfd }, [], { systemPrefixes: [] }).reads,
        'a differently normalized spelling of home',
      )
      .toEqual(toolchainAccess(nfc, {}, [], { systemPrefixes: [] }).reads);
  });
});

describe('toolchainAccess secret files', () => {
  it('denies every npmrc of an install or a probed prefix, by its link and its target, never one that is a directory', () => {
    const real = nodeInstall('.local/share/mise/installs/node/26.12.0');
    symlinkSync('./26.12.0', at('.local/share/mise/installs/node/latest'));
    const linked = at('.local/share/mise/installs/node/latest');
    expect
      .soft(npmrcs(access().secretFiles), 'an install by both spellings')
      .toEqual(
        [
          join(real, 'etc/npmrc'),
          join(real, 'lib/node_modules/npm/npmrc'),
          join(linked, 'etc/npmrc'),
          join(linked, 'lib/node_modules/npm/npmrc'),
        ].sort(),
      );

    // A prefix's npmrcs are always denied, and its direct children are probed for bin/node.
    freshHome();
    withPrefix(
      (system) => {
        plant('local/bin/node', system);
        plant('deep/a/b/bin/node', system);
      },
      (system) => {
        const { secretFiles, reads } = probe(system);
        expect
          .soft(npmrcs(secretFiles), 'a probed prefix and its child')
          .toEqual(
            [
              join(system, 'etc/npmrc'),
              join(system, 'lib/node_modules/npm/npmrc'),
              join(system, 'local/etc/npmrc'),
              join(system, 'local/lib/node_modules/npm/npmrc'),
            ].sort(),
          );
        expect.soft(reads, 'a probed prefix: reads').toEqual(access().reads);
      },
    );

    // A probed npmrc that is a directory holds no token, and doesn't refuse.
    withPrefix(
      (system) => mkdirSync(join(system, 'etc', 'npmrc'), { recursive: true }),
      (system) => {
        expect
          .soft(npmrcs(probe(system).secretFiles), 'an npmrc that is a directory')
          .toEqual([join(system, 'lib/node_modules/npm/npmrc')]);
      },
    );

    withPrefix(
      (system) => {
        plant('real/npmrc', system);
        mkdirSync(join(system, 'etc'));
        symlinkSync(join(system, 'real/npmrc'), join(system, 'etc/npmrc'));
      },
      (system) => {
        expect
          .soft(npmrcs(probe(system).secretFiles), 'a linked npmrc')
          .toEqual(
            [
              join(system, 'etc/npmrc'),
              join(system, 'real/npmrc'),
              join(system, 'lib/node_modules/npm/npmrc'),
            ].sort(),
          );
      },
    );

    withPrefix(
      (system) => {
        mkdirSync(join(system, 'etc'));
        symlinkSync(join(system, 'missing/npmrc'), join(system, 'etc/npmrc'));
      },
      (system) => {
        expect
          .soft(npmrcs(probe(system).secretFiles), 'a linked npmrc that leads nowhere')
          .toContain(join(system, 'etc/npmrc'));
      },
    );
  });

  it('leaves no read that equals or lies under a secret file', () => {
    plant('.local/bin/npmrc');
    const { reads, secretFiles } = access({ PATH: at('.local/bin') });
    for (const secret of secretFiles)
      expect(reads.filter((path) => path === secret || path.startsWith(secret + '/'))).toEqual([]);
  });

  it('probes the real install prefixes by default, never a temp dir', () => {
    const { secretFiles } = toolchainAccess(home, {}, homeProtectedReads(home));
    // Denied whether or not the file exists yet, since it may appear later.
    for (const prefix of SYSTEM_NODE_PREFIXES)
      expect(secretFiles).toContain(join(prefix, 'etc/npmrc'));
    // The home's own cargo and mise files are secret too; here the home is itself a temp dir.
    const probed = secretFiles.filter((path) => !isEqualOrUnder(path, home));
    const temp = [tmpdir(), realpathSync(tmpdir()), '/tmp', '/private/tmp'];
    expect(probed.filter((path) => temp.some((dir) => isEqualOrUnder(path, dir)))).toEqual([]);
    expect(baseSecrets().every((file) => secretFiles.includes(file))).toBe(true);
  });
});
