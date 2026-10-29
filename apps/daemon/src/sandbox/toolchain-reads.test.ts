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

describe('toolchainAccess reads', () => {
  const always = (h: string): string[] => [
    `${h}/.local/state/mise`,
    `${h}/.cache/mise`,
    `${h}/Library/Caches/mise`,
    `${h}/.cargo/bin`,
  ];

  it("opens mise's state and cache and cargo's bin, and never mise's config dir", () => {
    plant('.config/mise/config.toml');
    plant('.config/mise/age.txt');
    const { reads, secretFiles } = access();
    expect(reads).toEqual(always(home));
    expect(reads.filter((path) => path.startsWith(at('.config')))).toEqual([]);
    expect(secretFiles).toContain(at('.config/mise/age.txt'));
  });

  it("honours mise's XDG dirs and denies a named age key", () => {
    const env = {
      XDG_STATE_HOME: at('xdg/state'),
      XDG_CACHE_HOME: at('xdg/cache'),
      XDG_DATA_HOME: at('xdg/data'),
      MISE_AGE_KEY_FILE: at('keys/age.txt'),
    };
    plant('xdg/data/mise/installs/node/26.12.0/bin/node');
    const { reads, secretFiles } = access(env);
    expect(reads).toEqual(
      expect.arrayContaining([
        at('xdg/state/mise'),
        at('xdg/cache/mise'),
        at('xdg/data/mise/installs/node/26.12.0/bin'),
      ]),
    );
    expect(secretFiles).toContain(at('keys/age.txt'));
  });

  it("opens each mise install's own entries, by written and real path, but never its etc", () => {
    const real = nodeInstall('.local/share/mise/installs/node/26.12.0');
    symlinkSync('./26.12.0', at('.local/share/mise/installs/node/26'));
    plant('.local/share/mise/installs/node/.mise.backend.toml');
    plant('.local/share/mise/installs/pnpm/12.13.0/pnpm');
    mkdirSync(at('.local/share/mise/shims'), { recursive: true });
    mkdirSync(at('.local/share/mise/downloads'), { recursive: true });
    const { reads } = access();
    const linked = at('.local/share/mise/installs/node/26');
    for (const dir of ['bin', 'lib', 'include', 'share']) {
      expect(reads).toContain(join(real, dir));
      expect(reads).toContain(join(linked, dir));
    }
    expect(reads).toEqual(
      expect.arrayContaining([
        at('.local/share/mise/shims'),
        at('.local/share/mise/installs/node/.mise.backend.toml'),
        at('.local/share/mise/installs/pnpm/12.13.0/pnpm'),
      ]),
    );
    expect(reads.filter((path) => path.endsWith('/etc'))).toEqual([]);
    expect(reads).not.toContain(at('.local/share/mise'));
    expect(reads).not.toContain(at('.local/share/mise/downloads'));
    expect(reads).not.toContain(real);
  });

  it("opens the listing of mise's installs dir and of each tool dir, so mise can list what is installed, and nothing of its data dir", () => {
    nodeInstall('.local/share/mise/installs/node/26.12.0');
    plant('.local/share/mise/installs/pnpm/12.13.0/pnpm');
    mkdirSync(at('.local/share/mise/downloads'), { recursive: true });
    plant('.local/share/mise/plugins/x/secret');
    const { reads, listings } = access();
    const installs = at('.local/share/mise/installs');
    expect(listings).toEqual([listingGrant(installs), childListingGrant(installs)]);
    // A listing is not a read: nothing of the installs dir, or of any tool dir, opens whole.
    expect(reads).not.toContain(installs);
    expect(reads).not.toContain(join(installs, 'node'));
    expect(reads).not.toContain(at('.local/share/mise'));
    expect(reads.filter((path) => path.startsWith(at('.local/share/mise/plugins')))).toEqual([]);
    expect(reads.filter((path) => path.startsWith(at('.local/share/mise/downloads')))).toEqual([]);
  });

  it('never opens a version, so one installed after the profile is built stays closed', () => {
    nodeInstall('.local/share/mise/installs/node/26.12.0');
    const { reads, listings } = access();
    expect(reads).toContain(at('.local/share/mise/installs/node/26.12.0/bin'));
    expect(reads).not.toContain(at('.local/share/mise/installs/node/26.12.0'));
    // The only patterns are the two exact-match listings, so none reaches below a tool dir.
    expect(listings).toHaveLength(2);
  });

  it("opens mise's listings under the dir MISE_DATA_DIR names, and nothing when it is missing", () => {
    nodeInstall('mise-data/installs/node/26.12.0');
    expect(access({ MISE_DATA_DIR: at('mise-data') }).listings).toEqual([
      listingGrant(at('mise-data/installs')),
      childListingGrant(at('mise-data/installs')),
    ]);
    expect(access({ MISE_DATA_DIR: at('absent') }).listings).toEqual([]);
  });

  it('lists an installs dir that is a link by its written path, and by its real path only inside a granted read', () => {
    nodeInstall('.local/share/mise/store/installs/node/26.12.0');
    symlinkSync(at('.local/share/mise/store/installs'), at('.local/share/mise/installs'));
    expect(access().listings).toEqual(
      expect.arrayContaining([
        listingGrant(at('.local/share/mise/installs')),
        listingGrant(at('.local/share/mise/store/installs')),
        childListingGrant(at('.local/share/mise/store/installs')),
      ]),
    );
    rmSync(at('.local/share/mise/installs'));
    plant('elsewhere/installs/node/22/bin/node');
    symlinkSync(at('elsewhere/installs'), at('.local/share/mise/installs'));
    const { listings, reads } = access();
    expect(listings).toContain(listingGrant(at('.local/share/mise/installs')));
    expect(listings.filter((path) => path.includes(at('elsewhere')))).toEqual([]);
    expect(reads.filter((path) => path.startsWith(at('elsewhere')))).toEqual([]);
  });

  it('lists nothing for nvm or volta, which need no listing', () => {
    nodeInstall('.nvm/versions/node/v22.0.0');
    nodeInstall('.volta/tools/image/node/22.0.0');
    expect(access().listings).toEqual([]);
  });

  it('lists nothing of a mise home inside a checkout', () => {
    const checkout = at('proj');
    nodeInstall('proj/mise/installs/node/26.12.0');
    const { reads, listings } = access(
      { MISE_DATA_DIR: join(checkout, 'mise') },
      { untrustedRoots: [checkout] },
    );
    expect(reads.filter((path) => path.startsWith(checkout))).toEqual([]);
    expect(listings).toEqual([]);
  });

  it('lists nothing at a path the profile cannot hold', () => {
    mkdirSync(at('we[ird]/installs'), { recursive: true });
    expect(access({ MISE_DATA_DIR: at('we[ird]') }).listings).toEqual([]);
  });

  it('opens a version linked into another granted read by its real path too', () => {
    plant('.cargo/bin/cargo');
    mkdirSync(at('.local/share/mise/installs/rust'), { recursive: true });
    symlinkSync(at('.cargo/bin'), at('.local/share/mise/installs/rust/1.99.1'));
    expect(access().reads).toEqual(
      expect.arrayContaining([
        at('.local/share/mise/installs/rust/1.99.1/cargo'),
        at('.cargo/bin/cargo'),
      ]),
    );
  });

  it('opens a version linked elsewhere in home only by its written path, which the kernel refuses', () => {
    plant('elsewhere/node-22/bin/node');
    mkdirSync(at('.local/share/mise/installs/node'), { recursive: true });
    symlinkSync(at('elsewhere/node-22'), at('.local/share/mise/installs/node/22'));
    const { reads } = access();
    expect(reads).toContain(at('.local/share/mise/installs/node/22/bin'));
    expect(reads.filter((path) => path.startsWith(at('elsewhere')))).toEqual([]);
  });

  it("opens nvm's script, aliases and installs with no marker needed, as Homebrew's nvm leaves none", () => {
    plant('.nvm/alias/default');
    const v22 = nodeInstall('.nvm/versions/node/v22.1.0');
    const { reads } = access();
    expect(reads).toEqual(
      expect.arrayContaining([at('.nvm/alias'), join(v22, 'bin'), join(v22, 'lib')]),
    );
    expect(reads).not.toContain(at('.nvm'));
    expect(reads).not.toContain(join(v22, 'etc'));
  });

  it("opens volta's shims, user state and images with no marker needed, never an image's etc", () => {
    plant('.volta/bin/volta-shim');
    symlinkSync('volta-shim', at('.volta/bin/node'));
    plant('.volta/layout.v4');
    plant('.volta/tools/user/platform.json');
    const image = nodeInstall('.volta/tools/image/node/22.1.0');
    plant('.volta/tools/inventory/node/node-v22.1.0.tar.gz');
    const { reads } = access();
    expect(reads).toEqual(
      expect.arrayContaining([
        at('.volta/bin'),
        at('.volta/layout.v4'),
        at('.volta/tools/user'),
        join(image, 'bin'),
      ]),
    );
    expect(reads).not.toContain(at('.volta'));
    expect(reads).not.toContain(join(image, 'etc'));
    expect(reads).not.toContain(at('.volta/tools/inventory'));
  });

  it('opens rustup whole as its own layout', () => {
    plant('.rustup/toolchains/stable/bin/cargo');
    expect(access().reads).toContain(at('.rustup'));
  });

  it.each<[string, string, string]>([
    ['NVM_DIR', 'tools/nvm', 'versions/node/v1/bin/node'],
    ['VOLTA_HOME', 'tools/volta', 'bin/volta'],
    ['RUSTUP_HOME', 'tools/rustup', 'settings.toml'],
    ['MISE_DATA_DIR', 'tools/mise', 'installs/node/1/bin/node'],
  ])('honours a custom %s under home', (name, dir, file) => {
    plant(join(dir, file));
    const named = join(home, dir);
    expect(access({ [name]: named }).reads.some((path) => path.startsWith(named))).toBe(true);
  });

  it.each<[string, string, string]>([
    ['an ancestor of a protected read', 'NVM_DIR', 'Library'],
    ['a broad config dir', 'VOLTA_HOME', '.config'],
    ['a broad data dir', 'NVM_DIR', '.local/share'],
    ['the documents dir', 'RUSTUP_HOME', 'Documents'],
  ])('refuses a custom home that is %s', (_name, name, dir) => {
    plant(join(dir, 'versions/node/v1/bin/node'));
    plant(join(dir, 'bin/volta'));
    expect(access({ [name]: join(home, dir) }).reads).toEqual(access().reads);
  });

  it('opens only the bin dir of ~/.cargo, and denies its credentials and config', () => {
    for (const file of ['credentials', 'credentials.toml', 'config', 'config.toml'])
      plant(join('.cargo', file));
    const { reads, secretFiles } = access({ PATH: at('.cargo') });
    expect(reads.filter((path) => path.startsWith(at('.cargo')))).toEqual([at('.cargo/bin')]);
    expect(secretFiles).toEqual(expect.arrayContaining(baseSecrets().slice(0, 4)));
  });

  it("denies a custom CARGO_HOME's credentials and config", () => {
    const { secretFiles } = access({ CARGO_HOME: at('tools/cargo') });
    expect(secretFiles).toEqual(
      expect.arrayContaining([at('tools/cargo/credentials.toml'), at('tools/cargo/config.toml')]),
    );
  });
});

describe('toolchainAccess PATH', () => {
  it("opens a PATH entry's own files, never the dir itself or its subdirectories", () => {
    plant('.local/bin/tool');
    plant('.local/bin/nested/nodejs/22/etc/npmrc');
    const { reads } = access({ PATH: at('.local/bin') });
    expect(reads).toContain(at('.local/bin/tool'));
    expect(reads).not.toContain(at('.local/bin'));
    expect(reads.filter((path) => path.startsWith(at('.local/bin/nested')))).toEqual([]);
  });

  it("opens nothing of a PATH entry that can't be listed", () => {
    const { reads } = access({ PATH: at('missing/bin') });
    expect(reads.filter((path) => path.startsWith(at('missing')))).toEqual([]);
  });

  it("opens pnpm's node installs and self-updates in a PATH entry by layout, never their etc", () => {
    plant('Library/pnpm/pnpm');
    const v22 = nodeInstall('Library/pnpm/nodejs/22.1.0');
    plant('Library/pnpm/.tools/pnpm/12.13.0/bin/pnpm');
    plant('Library/pnpm/.tools/pnpm/12.13.0/etc/npmrc');
    plant('Library/pnpm/global/5/node_modules/x/index.js');
    const entry = at('Library/pnpm');
    const { reads, secretFiles } = access({ PATH: entry });
    expect(reads).toEqual(
      expect.arrayContaining([
        join(entry, 'pnpm'),
        join(v22, 'bin'),
        join(v22, 'lib'),
        join(entry, '.tools/pnpm/12.13.0/bin'),
      ]),
    );
    expect(reads.filter((path) => path.endsWith('/etc'))).toEqual([]);
    expect(reads.filter((path) => path.includes('/global'))).toEqual([]);
    expect(secretFiles).toEqual(
      expect.arrayContaining([
        join(v22, 'lib/node_modules/npm/npmrc'),
        join(v22, 'etc/npmrc'),
        join(entry, '.tools/pnpm/12.13.0/etc/npmrc'),
      ]),
    );
  });

  it('drops a PATH entry under a checkout or the lane temp root before reading or denying', () => {
    plant('repo/node_modules/.bin/tool');
    plant('repo/node_modules/.bin/node');
    const entry = at('repo/node_modules/.bin');
    const trusted = access({ PATH: entry });
    expect(trusted.reads).toContain(join(entry, 'tool'));
    expect(npmrcs(trusted.secretFiles)).not.toEqual([]);
    const untrusted = access({ PATH: entry }, { untrustedRoots: [at('repo')] });
    expect(untrusted.reads).toEqual(access().reads);
    expect(untrusted.secretFiles).toEqual(access().secretFiles);
  });

  it("drops a PATH entry outside home from the reads, though its node's npmrcs are denied", () => {
    const system = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-sys-')));
    try {
      plant('Cellar/node/22.0.0/bin/node', system);
      mkdirSync(join(system, 'bin'));
      symlinkSync(join(system, 'Cellar/node/22.0.0/bin/node'), join(system, 'bin', 'node'));
      const { reads, secretFiles } = access({ PATH: join(system, 'bin') });
      expect(reads.filter((path) => path.startsWith(system))).toEqual([]);
      expect(npmrcs(secretFiles)).toEqual(
        [
          join(system, 'etc/npmrc'),
          join(system, 'lib/node_modules/npm/npmrc'),
          join(system, 'Cellar/node/22.0.0/etc/npmrc'),
          join(system, 'Cellar/node/22.0.0/lib/node_modules/npm/npmrc'),
        ].sort(),
      );
    } finally {
      rmSync(system, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('drops a case-variant spelling of home', () => {
    expect(access({ PATH: home.toUpperCase() }).reads).toEqual(access().reads);
  });

  it('drops a differently normalized spelling of home', () => {
    const nfd = '/h/café';
    const nfc = '/h/café';
    expect(toolchainAccess(nfc, { PATH: nfd }, [], { systemPrefixes: [] }).reads).toEqual(
      toolchainAccess(nfc, {}, [], { systemPrefixes: [] }).reads,
    );
  });
});

describe('toolchainAccess untrusted and mise config dirs', () => {
  it.each<[string, Record<string, string>, string]>([
    [
      'a state dir that is the config dir',
      { MISE_STATE_DIR: '<h>/.config/mise' },
      '<h>/.config/mise',
    ],
    [
      'a cache dir under the config dir',
      { MISE_CACHE_DIR: '<h>/.config/mise/cache' },
      '<h>/.config/mise/cache',
    ],
    [
      'a state dir that holds the global config file',
      { MISE_STATE_DIR: '<h>/mise-state', MISE_GLOBAL_CONFIG_FILE: '<h>/mise-state/global.toml' },
      '<h>/mise-state',
    ],
  ])("never opens %s, so mise's own config stays closed", (_name, named, dropped) => {
    const fill = (value: string): string => value.split('<h>').join(home);
    const env = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, fill(v)]));
    expect(access(env).reads).not.toContain(fill(dropped));
  });

  it('lists nothing inside a checkout, even under a trusted PATH dir laid out like pnpm', () => {
    plant('tools/tool');
    nodeInstall('tools/nodejs/22');
    plant('tools/.tools/pnpm/12.13.0/bin/pnpm');
    const checkout = at('tools/nodejs/22');
    const { reads, secretFiles } = access(
      { PATH: at('tools') },
      { untrustedRoots: [checkout, at('tools/.tools/pnpm')] },
    );
    expect(reads).toContain(at('tools/tool'));
    expect(reads.filter((path) => path.startsWith(checkout))).toEqual([]);
    expect(reads.filter((path) => path.startsWith(at('tools/.tools')))).toEqual([]);
    expect(secretFiles.filter((path) => path.startsWith(checkout))).toEqual([]);
  });

  it('opens no version manager home inside a checkout', () => {
    nodeInstall('repo/nvm/versions/node/v22.1.0');
    const { reads } = access({ NVM_DIR: at('repo/nvm') }, { untrustedRoots: [at('repo')] });
    expect(reads.filter((path) => path.startsWith(at('repo')))).toEqual([]);
  });

  it('drops a PATH entry that links into a checkout', () => {
    plant('repo/bin/tool');
    symlinkSync(at('repo/bin'), at('linkbin'));
    const { reads } = access({ PATH: at('linkbin') }, { untrustedRoots: [at('repo')] });
    expect(reads.filter((path) => path.endsWith('/tool'))).toEqual([]);
  });

  it('drops a PATH entry inside a checkout given by a link', () => {
    plant('repo/bin/tool');
    symlinkSync(at('repo'), at('repo-link'));
    const { reads } = access({ PATH: at('repo/bin') }, { untrustedRoots: [at('repo-link')] });
    expect(reads.filter((path) => path.endsWith('/tool'))).toEqual([]);
  });
});

describe('toolchainAccess secret files', () => {
  it("denies each install's global and builtin npmrc by both spellings", () => {
    const real = nodeInstall('.local/share/mise/installs/node/26.12.0');
    symlinkSync('./26.12.0', at('.local/share/mise/installs/node/latest'));
    const linked = at('.local/share/mise/installs/node/latest');
    expect(npmrcs(access().secretFiles)).toEqual(
      [
        join(real, 'etc/npmrc'),
        join(real, 'lib/node_modules/npm/npmrc'),
        join(linked, 'etc/npmrc'),
        join(linked, 'lib/node_modules/npm/npmrc'),
      ].sort(),
    );
  });

  it('closes no etc dir: no version of any manager is opened whole, so nothing reaches its etc', () => {
    nodeInstall('.local/share/mise/installs/node/26.12.0');
    nodeInstall('.nvm/versions/node/v22.0.0');
    const { reads, secretFiles } = access();
    expect(secretFiles.filter((path) => path.endsWith('/etc'))).toEqual([]);
    expect(reads.filter((path) => /\/etc(\/|$)/.test(path))).toEqual([]);
  });

  it('leaves no read that equals or lies under a secret file', () => {
    plant('.local/bin/npmrc');
    const { reads, secretFiles } = access({ PATH: at('.local/bin') });
    for (const secret of secretFiles)
      expect(reads.filter((path) => path === secret || path.startsWith(secret + '/'))).toEqual([]);
  });

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

  it("always denies an install prefix's npmrcs, and probes its direct children for bin/node", () => {
    withPrefix(
      (system) => {
        plant('local/bin/node', system);
        plant('deep/a/b/bin/node', system);
      },
      (system) => {
        const { secretFiles, reads } = probe(system);
        expect(npmrcs(secretFiles)).toEqual(
          [
            join(system, 'etc/npmrc'),
            join(system, 'lib/node_modules/npm/npmrc'),
            join(system, 'local/etc/npmrc'),
            join(system, 'local/lib/node_modules/npm/npmrc'),
          ].sort(),
        );
        expect(reads).toEqual(access().reads);
      },
    );
  });

  it("leaves out a probed npmrc that is a directory, which holds no token, and doesn't refuse", () => {
    withPrefix(
      (system) => mkdirSync(join(system, 'etc', 'npmrc'), { recursive: true }),
      (system) => {
        expect(npmrcs(probe(system).secretFiles)).toEqual([
          join(system, 'lib/node_modules/npm/npmrc'),
        ]);
      },
    );
  });

  it('denies a linked npmrc by its link and by the regular file it leads to', () => {
    withPrefix(
      (system) => {
        plant('real/npmrc', system);
        mkdirSync(join(system, 'etc'));
        symlinkSync(join(system, 'real/npmrc'), join(system, 'etc/npmrc'));
      },
      (system) => {
        expect(npmrcs(probe(system).secretFiles)).toEqual(
          [
            join(system, 'etc/npmrc'),
            join(system, 'real/npmrc'),
            join(system, 'lib/node_modules/npm/npmrc'),
          ].sort(),
        );
      },
    );
  });

  it('denies a linked npmrc by its link path when the link leads nowhere', () => {
    withPrefix(
      (system) => {
        mkdirSync(join(system, 'etc'));
        symlinkSync(join(system, 'missing/npmrc'), join(system, 'etc/npmrc'));
      },
      (system) => {
        expect(npmrcs(probe(system).secretFiles)).toContain(join(system, 'etc/npmrc'));
      },
    );
  });

  it("refuses the session, naming the path, for an npmrc whose name the profile can't hold", () => {
    withPrefix(
      (system) => plant('x[1]/bin/node', system),
      (system) => {
        expect(() => probe(system)).toThrow(SandboxProfileError);
        expect(() => probe(system)).toThrow(join(system, 'x[1]/etc/npmrc'));
      },
    );
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
