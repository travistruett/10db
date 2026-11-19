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
    setupReads: [],
    setupSecrets: [],
    loopback: false,
    deniedEnvNames: ['GH_TOKEN'],
    ...overrides,
  };
}

/** What `build` throws, or undefined when it builds. */
function thrownBy(build: () => unknown): unknown {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
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
  it('builds the base, network and credential fields, binding loopback or a Docker socket only when asked', () => {
    const given = input();
    const profile = buildLaneProfile(given);
    expect
      .soft(
        {
          enabled: profile.enabled,
          failIfUnavailable: profile.failIfUnavailable,
          allowUnsandboxedCommands: profile.allowUnsandboxedCommands,
          allowAppleEvents: profile.allowAppleEvents,
          autoAllowBashIfSandboxed: profile.autoAllowBashIfSandboxed,
        },
        'base fields',
      )
      .toEqual({
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        allowAppleEvents: false,
        autoAllowBashIfSandboxed: false,
      });
    expect
      .soft(profile.network.allowedDomains, 'allowedDomains')
      .toEqual(['github.com', '*.npmjs.org']);
    expect.soft(profile.network.allowMachLookup, 'allowMachLookup').toEqual(['com.apple.FSEvents']);
    expect.soft(profile.network.allowUnixSockets, 'no Docker socket').toEqual([given.tmpDir]);
    expect
      .soft(profile.credentials.envVars, 'envVars')
      .toEqual([{ name: 'GH_TOKEN', mode: 'deny' }]);
    expect.soft(profile.network.allowLocalBinding, 'loopback false').toBe(undefined);
    expect
      .soft(buildLaneProfile(input({ loopback: true })).network.allowLocalBinding, 'loopback true')
      .toBe(true);
    const docker = input({ dockerSockets: ['/var/run/docker.sock'] });
    expect
      .soft(buildLaneProfile(docker).network.allowUnixSockets, 'a Docker socket')
      .toEqual([docker.tmpDir, '/var/run/docker.sock']);
  });

  it('denies slash, every protected read and toolchain secret, and allows back the system paths, the real checkout, the temp dir and the extras', () => {
    const link = join(root, 'link');
    symlinkSync(checkout, link);
    const gitDir = join(root, 'main', '.git', 'worktrees', 'w');
    const gitdirFile = join(gitDir, 'gitdir');
    const given = input({ checkout: link, extraReads: [gitDir], extraWrites: [gitDir] });
    const { allowRead, allowWrite, denyRead, denyWrite } = buildLaneProfile(given).filesystem;
    expect.soft(denyRead[0], 'first denied read').toBe('/');
    for (const path of [...given.protectedReads, ...given.secretFiles, ...given.toolchainSecrets])
      expect.soft(denyRead, `denied read ${path}`).toContain(path);
    expect
      .soft(allowRead, 'system reads and temp dir')
      .toEqual(expect.arrayContaining([...SYSTEM_READS, given.tmpDir]));
    expect.soft(allowRead, 'the real checkout').toContain(realpathSync(link));
    expect.soft(allowRead, 'the checkout link').not.toContain(link);
    expect.soft(allowRead.at(-1), 'last read: the extra read').toBe(gitDir);
    expect.soft(allowWrite, 'writes').toEqual([given.tmpDir, gitDir]);
    expect.soft(denyWrite, 'denyWrite with none given').toEqual([]);
    expect
      .soft(
        buildLaneProfile(input({ denyWrites: [gitdirFile] })).filesystem.denyWrite,
        'denyWrite given',
      )
      .toEqual([gitdirFile]);
  });

  it('drops a read-list, extra-read or extra-write entry under a protected read or that is a secret file', () => {
    const secret = join(checkout, '.env');
    const kept = join(root, 'elsewhere');
    const rows: { name: string; path: string; asExtraRead?: true; darwinOnly?: true }[] = [
      { name: 'under a protected read', path: join(home, '.claude', 'x'), asExtraRead: true },
      { name: 'a secret file', path: secret },
      {
        name: 'a differently cased protected read',
        path: join(home, '.CLAUDE', 'y'),
        darwinOnly: true,
      },
    ];
    for (const row of rows) {
      if (row.darwinOnly && process.platform !== 'darwin') continue;
      const { allowRead, allowWrite } = buildLaneProfile(
        input({
          secretFiles: [secret],
          readList: [row.path, kept],
          extraReads: row.asExtraRead ? [row.path] : [],
          extraWrites: [row.path],
        }),
      ).filesystem;
      expect.soft(allowRead, `${row.name}: read ${row.path}`).not.toContain(row.path);
      expect.soft(allowWrite, `${row.name}: write ${row.path}`).not.toContain(row.path);
      expect.soft(allowRead, `${row.name}: kept ${kept}`).toContain(kept);
    }
  });

  it('opens setup reads read-only, keeping every secret, toolchain secret and sandbox root inside them denied', () => {
    const skills = join(home, '.claude', 'skills');
    const opened = buildLaneProfile(input({ setupReads: [skills] })).filesystem;
    expect.soft(opened.allowRead, 'setup read').toContain(skills);
    expect.soft(opened.allowWrite, 'setup read written').not.toContain(skills);
    expect.soft(opened.denyRead, 'the protected read over it').toContain(join(home, '.claude'));

    const skill = join(skills, 's');
    const secret = join(skill, '.env');
    const toolchainSecret = join(home, '.cargo', 'credentials.toml');
    const sandboxRoot = join(root, 'files');
    const inside = buildLaneProfile(
      input({
        secretFiles: [secret],
        sandboxRoots: [sandboxRoot],
        setupReads: [skill, secret, toolchainSecret, join(sandboxRoot, 'x')],
      }),
    ).filesystem;
    expect.soft(inside.allowRead, 'skill').toContain(skill);
    expect.soft(inside.denyRead, 'secret in a setup read').toContain(secret);
    for (const closed of [secret, toolchainSecret, join(sandboxRoot, 'x')])
      expect.soft(inside.allowRead, `opened ${closed}`).not.toContain(closed);
  });

  it('denies a .env folder inside a setup read under /tmp, not refusing the session', () => {
    // Spelled /tmp, not resolved: the system reads compare as written, and Linux's temp dir is /tmp.
    const skill = mkdtempSync('/tmp/sbx-setup-');
    try {
      const secret = join(skill, '.env');
      mkdirSync(secret);
      const { allowRead, denyRead } = buildLaneProfile(
        input({ setupReads: [skill], setupSecrets: [secret] }),
      ).filesystem;
      expect(denyRead).toContain(secret);
      expect(allowRead).toContain(skill);
    } finally {
      rmSync(skill, { recursive: true, force: true });
    }
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

  it('closes every sandbox root but its own temp dir and files, leaving out only a built-in read that holds a root', () => {
    const given = withRoots();
    const { allowRead, allowWrite, denyRead, denyWrite } = buildLaneProfile(given).filesystem;
    expect
      .soft(denyRead, 'roots denied')
      .toEqual(expect.arrayContaining([given.tempRoot, given.lanes, given.files]));
    expect
      .soft(allowRead, 'own temp dir and files')
      .toEqual(expect.arrayContaining([given.tmpDir, given.envFile]));
    expect.soft(allowWrite, 'writes').toEqual([given.tmpDir]);
    // No read-list entry over, at or in a root survives: none opens another sandbox's files.
    for (const listed of given.readList) expect.soft(allowRead, listed).not.toContain(listed);
    expect.soft(denyWrite, 'denyWrite').toEqual([]);

    for (const entry of SYSTEM_READS) {
      const tempRoot = join(entry, 'sbx-shared');
      const files = join(entry, 'sbx-run');
      const envFile = join(files, '10db-env-0123456789ab.sh');
      const tmpDir = join(tempRoot, '10db-abcdef');
      const under = buildLaneProfile(
        input({
          tmpDir,
          sandboxRoots: [tempRoot, files],
          ownFiles: [envFile],
          extraReads: [envFile],
        }),
      ).filesystem;
      expect.soft(under.allowRead, `${entry} left out`).not.toContain(entry);
      expect
        .soft(under.allowRead, `${entry}: own temp dir and files`)
        .toEqual(expect.arrayContaining([tmpDir, envFile]));
      expect
        .soft(under.denyRead, `${entry}: roots denied`)
        .toEqual(expect.arrayContaining([tempRoot, files]));
      // No remaining grant is a root or covers one, so nothing else opens another sandbox's files.
      for (const granted of under.allowRead) {
        for (const held of [tempRoot, files]) {
          expect
            .soft(held === granted || held.startsWith(`${granted}/`), `${granted} covers ${held}`)
            .toBe(false);
        }
      }
    }

    const keeps: [string, () => LaneProfileInput][] = [
      // On Linux the test's temp dir lies under `/tmp`, a built-in read, so this row's roots do too.
      ['roots in the test temp dir', withRoots],
      // Roots no built-in read holds, on every platform.
      ['roots no built-in read holds', () => input({ sandboxRoots: ['/10db-nowhere/shared'] })],
    ];
    for (const [name, make] of keeps) {
      const made = make();
      const kept = SYSTEM_READS.filter(
        (entry) => !made.sandboxRoots.some((sandboxRoot) => isEqualOrUnder(sandboxRoot, entry)),
      );
      expect.soft(kept.length, `${name}: built-in reads kept`).toBeGreaterThan(0);
      expect
        .soft(buildLaneProfile(made).filesystem.allowRead, `${name}: built-in reads`)
        .toEqual(expect.arrayContaining(kept));
    }
  });

  it('refuses the profile when a write holds a sandbox root, naming both paths', () => {
    const given = withRoots();
    const rows: [string, Partial<LaneProfileInput>, string, string][] = [
      // It holds `~/.10db`: other lanes' temp dirs and files there would be the lane's to write.
      ['the checkout holds the home', { checkout: home }, home, given.lanes],
      // It holds the root of the lane's own temp dir, and every other sandbox's temp dir beside it.
      ['an extra write holds the temp root', { extraWrites: [root] }, root, given.tempRoot],
      [
        'an extra write is a sandbox root',
        { extraWrites: [given.files] },
        given.files,
        given.files,
      ],
    ];
    for (const [name, writes, path, held] of rows) {
      const error = thrownBy(() => buildLaneProfile({ ...given, ...writes }));
      expect.soft(error, name).toBeInstanceOf(SandboxProfileError);
      expect
        .soft((error as Error | undefined)?.message, name)
        .toContain(`${path} holds ${held}, where 10db keeps every sandbox's temp dirs and files`);
    }
  });

  it('refuses a value the profile cannot spell, naming the value and the field', () => {
    const named: [string, Partial<LaneProfileInput>, string, string][] = [
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
    ];
    for (const [name, overrides, field, message] of named) {
      const error = thrownBy(() => buildLaneProfile(input(overrides)));
      expect.soft(error, name).toBeInstanceOf(SandboxProfileError);
      expect.soft(error, name).toHaveProperty('message', message);
      expect.soft(error, name).toHaveProperty('field', expect.stringContaining(field));
    }
    const refused: [string, Partial<LaneProfileInput>][] = [
      ['a read-list path with a dot-dot segment', { readList: ['/h/x/../.claude/y'] }],
      ['a read-list path with a doubled slash', { readList: ['//h/.claude/y'] }],
      ['a read-list path with a dot segment', { readList: ['/h/.claude/./y'] }],
      ['a read-list path with a trailing slash', { readList: ['/h/.claude/y/'] }],
      ['a Docker socket with a glob', { dockerSockets: ['/run/a*b.sock'] }],
      ['a checkout that does not exist', { checkout: join(root, 'missing') }],
    ];
    for (const [name, overrides] of refused)
      expect
        .soft(
          thrownBy(() => buildLaneProfile(input(overrides))),
          name,
        )
        .toBeInstanceOf(SandboxProfileError);
  });

  it("refuses a setup or toolchain secret that holds what every lane command needs, with the secret's own message", () => {
    expect
      .soft(
        thrownBy(() => buildLaneProfile(input({ setupSecrets: [checkout] }))),
        'setup secret',
      )
      .toHaveProperty('message', expect.stringMatching(/holds .* that every lane command needs/));
    const toolchain = thrownBy(() => buildLaneProfile(input({ toolchainSecrets: [checkout] })));
    expect.soft(toolchain, 'toolchain secret').toBeInstanceOf(SandboxProfileError);
    expect
      .soft((toolchain as Error | undefined)?.message, 'toolchain secret')
      .toMatch(
        /a toolchain file that can hold a registry token, .*, holds .* every lane command needs/,
      );
    expect.soft((toolchain as Error | undefined)?.message, 'toolchain secret').not.toMatch(/\.env/);
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

    it('refuses any other pattern as a listing, and a pattern in the ordinary read list', () => {
      const dir = installs();
      const rows: [string, Partial<LaneProfileInput>][] = [
        ['the root as a child listing', { toolchainListings: ['//*'] }],
        ['a set with no leading slash', { toolchainListings: ['[/]'] }],
        ['an empty set', { toolchainListings: [`${dir.slice(0, -1)}[]`] }],
        ['a recursive glob', { toolchainListings: [`${dir}/**`] }],
        [
          'a wildcard in the middle',
          { toolchainListings: [`${dirname(dirname(dir))}/*/installs`] },
        ],
        ['a set of several characters', { toolchainListings: [`${dir}[st]`] }],
        ['a brace', { toolchainListings: [`${dir}{a,b}`] }],
        ['a glob with no listing dir', { toolchainListings: ['/*'] }],
        ['a pattern in the read list', { readList: [`${dir}/*`] }],
      ];
      for (const [name, overrides] of rows)
        expect
          .soft(
            thrownBy(() => buildLaneProfile(input(overrides))),
            name,
          )
          .toBeInstanceOf(SandboxProfileError);
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
  });
});

describe('protectedReads', () => {
  it('lists the data dir, config dirs and credential paths, deduplicated, resolving a relative dir', () => {
    expect
      .soft(protectedReads({ home: '/h', dataDir: '/d', configDirs: ['/c', '/h/.claude'] }))
      .toEqual([
        '/d',
        '/c',
        '/h/.claude',
        '/h/.claude.json',
        '/h/.codex',
        '/h/.agents',
        '/h/Library/Keychains',
        '/usr/bin/security',
      ]);
    const relative = protectedReads({ home: '/h', dataDir: 'data', configDirs: ['cfg'] });
    expect.soft(relative, 'relative data dir').toContain(resolve('data'));
    expect.soft(relative, 'relative config dir').toContain(resolve('cfg'));
  });
});
