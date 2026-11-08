import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLaneProfile,
  protectedReads,
  SandboxProfileError,
  SYSTEM_READS,
  toolchainAccess,
  type LaneProfileInput,
} from './index';
import { childListingGrant, listingGrant } from './profile';
import { isEqualOrUnder } from './protected-reads';

let root: string;
let home: string;
let checkout: string;

function input(overrides: Partial<LaneProfileInput> = {}): LaneProfileInput {
  return {
    checkout,
    tmpDir: join(root, 'tmp'),
    home,
    protectedReads: protectedReads({
      home,
      dataDir: join(home, 'Library', 'Application Support', '10db'),
      configDirs: [join(home, '.config', 'gh')],
    }),
    secretFiles: [join(checkout, '.env')],
    toolchainSecrets: [join(home, '.cargo', 'credentials.toml')],
    toolchainReads: toolchainAccess(home, {}, [], { systemPrefixes: [] }).reads,
    toolchainListings: toolchainAccess(home, {}, [], { systemPrefixes: [] }).listings,
    allowedDomains: ['github.com', '*.npmjs.org'],
    readList: [],
    extraReads: [],
    extraWrites: [],
    denyWrites: [],
    sandboxRoots: [],
    ownFiles: [],
    loopback: false,
    deniedEnvNames: ['GH_TOKEN'],
    ...overrides,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-profile-')));
  home = join(root, 'home');
  checkout = join(root, 'repo');
  mkdirSync(home);
  mkdirSync(checkout);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildLaneProfile', () => {
  it('builds the base fields exactly', () => {
    const profile = buildLaneProfile(input());
    expect({
      enabled: profile.enabled,
      failIfUnavailable: profile.failIfUnavailable,
      allowUnsandboxedCommands: profile.allowUnsandboxedCommands,
      allowAppleEvents: profile.allowAppleEvents,
      autoAllowBashIfSandboxed: profile.autoAllowBashIfSandboxed,
    }).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      allowAppleEvents: false,
      autoAllowBashIfSandboxed: false,
    });
  });

  it('denies slash and every protected read', () => {
    const given = input();
    const { denyRead } = buildLaneProfile(given).filesystem;
    expect(denyRead[0]).toBe('/');
    for (const path of [...given.protectedReads, ...given.secretFiles]) {
      expect(denyRead).toContain(path);
    }
  });

  it("allows back the system paths, the checkout's real path and the temp dir", () => {
    const link = join(root, 'link');
    symlinkSync(checkout, link);
    const given = input({ checkout: link });
    const { allowRead, allowWrite } = buildLaneProfile(given).filesystem;
    expect(allowRead).toEqual(expect.arrayContaining([...SYSTEM_READS, given.tmpDir]));
    expect(allowRead).toContain(realpathSync(link));
    expect(allowRead).not.toContain(link);
    expect(allowWrite).toEqual([given.tmpDir]);
  });

  it('drops a read-list entry under a protected read', () => {
    const under = join(home, '.claude', 'x');
    const kept = join(root, 'elsewhere');
    const { allowRead } = buildLaneProfile(input({ readList: [under, kept] })).filesystem;
    expect(allowRead).not.toContain(under);
    expect(allowRead).toContain(kept);
  });

  /** A lane's sandbox roots as it has them: its temp dir's root, another lanes' root, the files root. */
  function withRoots(): LaneProfileInput & {
    readonly tempRoot: string;
    readonly lanes: string;
    readonly files: string;
    readonly envFile: string;
  } {
    const tempRoot = join(root, 'shared');
    const files = join(home, '.10db', 'run');
    const lanes = join(home, '.10db', 'lanes');
    const envFile = join(files, '10db-env-0123456789ab.sh');
    return {
      ...input({
        tmpDir: join(tempRoot, '10db-abcdef'),
        sandboxRoots: [tempRoot, lanes, files],
        ownFiles: [envFile],
        extraReads: [envFile],
        readList: [join(home, '.10db'), join(files, '10db-mcp-0123456789ab.sh'), lanes],
      }),
      tempRoot,
      lanes,
      files,
      envFile,
    };
  }

  it('closes every sandbox root but its own temp dir and files, whatever the read list holds', () => {
    const given = withRoots();
    const { allowRead, allowWrite, denyRead, denyWrite } = buildLaneProfile(given).filesystem;
    expect(denyRead).toEqual(expect.arrayContaining([given.tempRoot, given.lanes, given.files]));
    expect(allowRead).toEqual(expect.arrayContaining([given.tmpDir, given.envFile]));
    expect(allowWrite).toEqual([given.tmpDir]);
    // No read-list entry over, at or in a root survives: none opens another sandbox's files.
    for (const listed of given.readList) expect(allowRead, listed).not.toContain(listed);
    expect(denyWrite).toEqual([]);
  });

  it.each(SYSTEM_READS.map((entry) => [entry] as const))(
    'leaves out the built-in read %s when a sandbox root lies under it, keeping the lane own temp dir and files',
    (entry) => {
      const tempRoot = join(entry, 'sbx-shared');
      const files = join(entry, 'sbx-run');
      const envFile = join(files, '10db-env-0123456789ab.sh');
      const tmpDir = join(tempRoot, '10db-abcdef');
      const { allowRead, denyRead } = buildLaneProfile(
        input({
          tmpDir,
          sandboxRoots: [tempRoot, files],
          ownFiles: [envFile],
          extraReads: [envFile],
        }),
      ).filesystem;
      expect(allowRead).not.toContain(entry);
      expect(allowRead).toEqual(expect.arrayContaining([tmpDir, envFile]));
      expect(denyRead).toEqual(expect.arrayContaining([tempRoot, files]));
      // No remaining grant is a root or covers one, so nothing else opens another sandbox's files.
      for (const granted of allowRead) {
        for (const held of [tempRoot, files]) {
          expect(
            held === granted || held.startsWith(`${granted}/`),
            `${granted} covers ${held}`,
          ).toBe(false);
        }
      }
    },
  );

  it.each<[string, () => LaneProfileInput]>([
    // On Linux the test's temp dir lies under `/tmp`, a built-in read, so this row's roots do too.
    ['roots in the test temp dir', withRoots],
    // Roots no built-in read holds, on every platform.
    ['roots no built-in read holds', () => input({ sandboxRoots: ['/10db-nowhere/shared'] })],
  ])('keeps every built-in read that holds no sandbox root, with %s', (_name, make) => {
    const given = make();
    const { allowRead } = buildLaneProfile(given).filesystem;
    const kept = SYSTEM_READS.filter(
      (entry) => !given.sandboxRoots.some((sandboxRoot) => isEqualOrUnder(sandboxRoot, entry)),
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(allowRead).toEqual(expect.arrayContaining(kept));
  });

  it.each<
    [
      string,
      (given: ReturnType<typeof withRoots>) => {
        readonly writes: Partial<LaneProfileInput>;
        readonly path: string;
        readonly root: string;
      },
    ]
  >([
    // It holds `~/.10db`: other lanes' temp dirs and files there would be the lane's to write.
    [
      'the checkout holds the home',
      (given) => ({ writes: { checkout: home }, path: home, root: given.lanes }),
    ],
    // It holds the root of the lane's own temp dir, and every other sandbox's temp dir beside it.
    [
      'an extra write holds the temp root',
      (given) => ({ writes: { extraWrites: [root] }, path: root, root: given.tempRoot }),
    ],
    [
      'an extra write is a sandbox root',
      (given) => ({ writes: { extraWrites: [given.files] }, path: given.files, root: given.files }),
    ],
  ])('refuses the profile when %s, naming both paths', (_name, make) => {
    const given = withRoots();
    const { writes, path, root: held } = make(given);
    const build = () => buildLaneProfile({ ...given, ...writes });
    expect(build).toThrow(SandboxProfileError);
    expect(build).toThrow(
      `${path} holds ${held}, where 10db keeps every sandbox's temp dirs and files`,
    );
  });

  it('appends extra reads and writes, and filters them like the read list', () => {
    const gitDir = join(root, 'main', '.git', 'worktrees', 'w');
    const protectedExtra = join(home, '.claude', 'y');
    const { allowRead, allowWrite } = buildLaneProfile(
      input({
        extraReads: [gitDir, protectedExtra],
        extraWrites: [gitDir, protectedExtra],
      }),
    ).filesystem;
    expect(allowRead.at(-1)).toBe(gitDir);
    expect(allowWrite.at(-1)).toBe(gitDir);
    expect(allowRead).not.toContain(protectedExtra);
    expect(allowWrite).not.toContain(protectedExtra);
  });

  it('denies writes to exactly the paths it is given', () => {
    const gitdirFile = join(root, 'main', '.git', 'worktrees', 'w', 'gitdir');
    expect(buildLaneProfile(input()).filesystem.denyWrite).toEqual([]);
    expect(buildLaneProfile(input({ denyWrites: [gitdirFile] })).filesystem.denyWrite).toEqual([
      gitdirFile,
    ]);
  });

  it.each([
    ['false', false, undefined],
    ['true', true, true],
  ])('sets local binding only when asked: %s', (_name, loopback, expected) => {
    expect(buildLaneProfile(input({ loopback })).network.allowLocalBinding).toBe(expected);
  });

  it('opens a Docker socket only when given one, beside the temp dir', () => {
    const given = input({ dockerSockets: ['/var/run/docker.sock'] });
    expect(buildLaneProfile(given).network.allowUnixSockets).toEqual([
      given.tmpDir,
      '/var/run/docker.sock',
    ]);
    expect(buildLaneProfile(input()).network.allowUnixSockets).toEqual([input().tmpDir]);
  });

  it('refuses a Docker socket the profile cannot spell', () => {
    expect(() => buildLaneProfile(input({ dockerSockets: ['/run/a*b.sock'] }))).toThrow(
      SandboxProfileError,
    );
  });

  it('sets the network and credential fields', () => {
    const given = input();
    const profile = buildLaneProfile(given);
    expect(profile.network.allowedDomains).toEqual(['github.com', '*.npmjs.org']);
    expect(profile.network.allowMachLookup).toEqual(['com.apple.FSEvents']);
    expect(profile.network.allowUnixSockets).toEqual([given.tmpDir]);
    expect(profile.credentials.envVars).toEqual([{ name: 'GH_TOKEN', mode: 'deny' }]);
  });

  it.each<[string, Partial<LaneProfileInput>, string, string]>([
    [
      'a glob in a secret file',
      { secretFiles: ['/r/.env*'] },
      'filesystem.denyRead',
      "a path can't be used in the sandbox profile: /r/.env* (glob characters, `\\` or a newline)",
    ],
    [
      'a relative read-list path',
      { readList: ['rel/x'] },
      'filesystem.allowRead',
      "a path can't be used in the sandbox profile: rel/x (not a normalized absolute path)",
    ],
    [
      'a brace in an extra write',
      { extraWrites: ['/r/{a,b}'] },
      'filesystem.allowWrite',
      "a path can't be used in the sandbox profile: /r/{a,b} (glob characters, `\\` or a newline)",
    ],
    [
      'a glob in a denied write',
      { denyWrites: ['/r/.git/*'] },
      'filesystem.denyWrite',
      "a path can't be used in the sandbox profile: /r/.git/* (glob characters, `\\` or a newline)",
    ],
    [
      'a URL as a domain',
      { allowedDomains: ['https://x'] },
      'network.allowedDomains',
      "a host can't be used in the sandbox profile: https://x (not a lower-case host or *. wildcard)",
    ],
    [
      'a bad env name',
      { deniedEnvNames: ['A=B'] },
      'credentials.envVars',
      "an env name can't be used in the sandbox profile: A=B",
    ],
  ])('refuses %s, naming the value and the field', (_name, overrides, field, message) => {
    let thrown: unknown;
    try {
      buildLaneProfile(input(overrides));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SandboxProfileError);
    expect(thrown).toHaveProperty('message', message);
    expect(thrown).toHaveProperty('field', expect.stringContaining(field));
  });

  it.each<[string, string]>([
    ['a dot-dot segment', '/h/x/../.claude/y'],
    ['a doubled slash', '//h/.claude/y'],
    ['a dot segment', '/h/.claude/./y'],
    ['a trailing slash', '/h/.claude/y/'],
  ])('refuses a read-list path with %s', (_name, path) => {
    expect(() => buildLaneProfile(input({ readList: [path] }))).toThrow(SandboxProfileError);
  });

  it.skipIf(process.platform !== 'darwin')(
    'drops a differently cased spelling of a protected read',
    () => {
      const spelled = join(home, '.CLAUDE', 'y');
      const { allowRead, allowWrite } = buildLaneProfile(
        input({ readList: [spelled], extraWrites: [spelled] }),
      ).filesystem;
      expect(allowRead).not.toContain(spelled);
      expect(allowWrite).not.toContain(spelled);
    },
  );

  it('drops a read-list entry that is a secret file', () => {
    const secret = join(checkout, '.env');
    const { allowRead, allowWrite } = buildLaneProfile(
      input({ secretFiles: [secret], readList: [secret], extraWrites: [secret] }),
    ).filesystem;
    expect(allowRead).not.toContain(secret);
    expect(allowWrite).not.toContain(secret);
  });

  describe('toolchain listings', () => {
    const installs = () => join(home, '.local', 'share', 'mise', 'installs');

    it('spells a listing as an exact-match pattern: the dir with its last character as a set, or its children', () => {
      expect(listingGrant('/h/mise/installs')).toBe('/h/mise/install[s]');
      expect(listingGrant('/h/mise/a.b')).toBe('/h/mise/a.[b]');
      expect(childListingGrant('/h/mise/installs')).toBe('/h/mise/installs/*');
      expect(() => listingGrant('/h/we[ird]/installs')).toThrow(SandboxProfileError);
      expect(() => childListingGrant('/h/*/installs')).toThrow(SandboxProfileError);
      expect(() => listingGrant('relative')).toThrow(SandboxProfileError);
      expect(() => listingGrant('/')).toThrow(SandboxProfileError);
      expect(() => childListingGrant('/')).toThrow(SandboxProfileError);
    });

    it('allows them to be read, with the only pattern characters the profile holds', () => {
      const { allowRead } = buildLaneProfile(
        input({ toolchainListings: [listingGrant(installs()), childListingGrant(installs())] }),
      ).filesystem;
      expect(allowRead).toEqual(
        expect.arrayContaining([listingGrant(installs()), childListingGrant(installs())]),
      );
      expect(allowRead).not.toContain(installs());
      const patterned = allowRead.filter((path) => /[*?[\]{}\\\n]/.test(path));
      expect(patterned).toEqual([listingGrant(installs()), childListingGrant(installs())]);
    });

    it.each([
      ['the root as a child listing', () => '//*'],
      ['a set with no leading slash', () => '[/]'],
      ['an empty set', (dir: string) => `${dir.slice(0, -1)}[]`],
      ['a recursive glob', (dir: string) => `${dir}/**`],
      ['a wildcard in the middle', (dir: string) => `${dirname(dirname(dir))}/*/installs`],
      ['a set of several characters', (dir: string) => `${dir}[st]`],
      ['a brace', (dir: string) => `${dir}{a,b}`],
      ['a glob with no listing dir', () => '/*'],
    ])('refuses %s as a listing', (_name, pattern) => {
      const build = () => buildLaneProfile(input({ toolchainListings: [pattern(installs())] }));
      expect(build).toThrow(SandboxProfileError);
    });

    it('drops a listing of a dir that is, or lies under, a secret file or a protected read', () => {
      const tool = join(installs(), 'node');
      const kept = [listingGrant(installs()), childListingGrant(installs())];
      const { allowRead } = buildLaneProfile(
        input({
          toolchainListings: [
            ...kept,
            listingGrant(tool),
            childListingGrant(tool),
            listingGrant(join(home, '.cargo')),
          ],
          toolchainSecrets: [tool, join(home, '.cargo', 'credentials.toml')],
          protectedReads: [join(home, '.cargo')],
        }),
      ).filesystem;
      expect(allowRead).toEqual(expect.arrayContaining(kept));
      for (const dropped of [
        listingGrant(tool),
        childListingGrant(tool),
        listingGrant(join(home, '.cargo')),
      ])
        expect(allowRead).not.toContain(dropped);
    });

    it('refuses a pattern in the ordinary read list as before', () => {
      expect(() => buildLaneProfile(input({ readList: [`${installs()}/*`] }))).toThrow(
        SandboxProfileError,
      );
    });
  });

  it('denies the toolchain secrets to the commands', () => {
    expect(buildLaneProfile(input()).filesystem.denyRead).toContain(
      join(home, '.cargo', 'credentials.toml'),
    );
  });

  it("refuses with a toolchain message, not the .env one, when a toolchain secret holds a lane's path", () => {
    const build = () => buildLaneProfile(input({ toolchainSecrets: [checkout] }));
    expect(build).toThrow(SandboxProfileError);
    expect(build).toThrow(
      /a toolchain file that can hold a registry token, .*, holds .* every lane command needs/,
    );
    expect(build).not.toThrow(/\.env/);
  });

  it('refuses a checkout that does not exist', () => {
    expect(() => buildLaneProfile(input({ checkout: join(root, 'missing') }))).toThrow(
      SandboxProfileError,
    );
  });
});

describe('protectedReads', () => {
  it('lists the data dir, config dirs and credential paths, deduplicated', () => {
    const list = protectedReads({
      home: '/h',
      dataDir: '/d',
      configDirs: ['/c', '/h/.claude'],
    });
    expect(list).toEqual([
      '/d',
      '/c',
      '/h/.claude',
      '/h/.claude.json',
      '/h/.codex',
      '/h/.agents',
      '/h/Library/Keychains',
      '/usr/bin/security',
    ]);
  });
});

describe('protectedReads, relative input', () => {
  it('resolves a relative data or config dir instead of dropping it', () => {
    const list = protectedReads({ home: '/h', dataDir: 'data', configDirs: ['cfg'] });
    expect(list).toContain(resolve('data'));
    expect(list).toContain(resolve('cfg'));
  });
});
