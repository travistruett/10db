import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLaneProfile,
  protectedReads,
  SandboxProfileError,
  SYSTEM_READS,
  toolchainReads,
  type LaneProfileInput,
} from './index';

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
    toolchainReads: toolchainReads(home, ''),
    packageCacheDir: join(home, 'Library', 'Caches', '10db', 'projects', 'p'),
    allowedDomains: ['github.com', '*.npmjs.org'],
    readList: [],
    extraReads: [],
    extraWrites: [],
    denyWrites: [],
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
    expect(allowWrite).toEqual([given.tmpDir, given.packageCacheDir]);
  });

  it('drops a read-list entry under a protected read', () => {
    const under = join(home, '.claude', 'x');
    const kept = join(root, 'elsewhere');
    const { allowRead } = buildLaneProfile(input({ readList: [under, kept] })).filesystem;
    expect(allowRead).not.toContain(under);
    expect(allowRead).toContain(kept);
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

  it('sets the network and credential fields', () => {
    const given = input();
    const profile = buildLaneProfile(given);
    expect(profile.network.allowedDomains).toEqual(['github.com', '*.npmjs.org']);
    expect(profile.network.allowMachLookup).toEqual(['com.apple.FSEvents']);
    expect(profile.network.allowUnixSockets).toEqual([given.tmpDir]);
    expect(profile.credentials.envVars).toEqual([{ name: 'GH_TOKEN', mode: 'deny' }]);
  });

  it.each<[string, Partial<LaneProfileInput>, string]>([
    ['a glob in a secret file', { secretFiles: ['/r/.env*'] }, 'filesystem.denyRead'],
    ['a relative read-list path', { readList: ['rel/x'] }, 'filesystem.allowRead'],
    ['a brace in an extra write', { extraWrites: ['/r/{a,b}'] }, 'filesystem.allowWrite'],
    ['a glob in a denied write', { denyWrites: ['/r/.git/*'] }, 'filesystem.denyWrite'],
    ['a URL as a domain', { allowedDomains: ['https://x'] }, 'network.allowedDomains'],
    ['a bad env name', { deniedEnvNames: ['A=B'] }, 'credentials.envVars'],
  ])('refuses %s', (_name, overrides, field) => {
    let thrown: unknown;
    try {
      buildLaneProfile(input(overrides));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SandboxProfileError);
    expect(thrown).toHaveProperty('message', expect.stringContaining(field));
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

describe('toolchainReads', () => {
  const fixed = (h: string): string[] => [
    `${h}/.local/share/mise`,
    `${h}/.config/mise`,
    `${h}/.local/state/mise`,
    `${h}/.cache/mise`,
    `${h}/Library/pnpm`,
    `${h}/Library/Caches/pnpm`,
    `${h}/Library/Preferences/pnpm`,
    `${h}/.cargo`,
    `${h}/.rustup`,
  ];

  it.each<[string, string, string[]]>([
    [
      'a PATH entry under home, and home itself',
      `/usr/bin:/h/.local/share/mise/installs/node/26/bin:/h`,
      ['/h/.local/share/mise/installs/node/26/bin'],
    ],
    ['an entry whose parent is not opened', '/h/.docker/bin', ['/h/.docker/bin']],
    ['an entry under a protected read', '/h/.claude/bin:/h/Library/Keychains', []],
    ['an empty or relative entry', '::bin', []],
  ])('lists the fixed dirs plus %s', (_name, path, extra) => {
    const list = toolchainReads('/h', path);
    expect(list).toEqual([...fixed('/h'), ...extra.filter((e) => !fixed('/h').includes(e))]);
    expect(list).not.toContain('/h');
    expect(list).not.toContain('/h/.docker');
  });

  it.skipIf(process.platform !== 'darwin')('drops a case-variant spelling of home', () => {
    expect(toolchainReads('/Users/t', '/users/t:/USERS/T/')).not.toContain('/users/t');
    expect(toolchainReads('/Users/t', '/users/t')).toEqual(toolchainReads('/Users/t', ''));
  });

  it('drops a differently normalized spelling of home', () => {
    const nfd = '/h/cafe\u0301';
    const nfc = '/h/caf\u00e9';
    expect(toolchainReads(nfc, nfd)).toEqual(toolchainReads(nfc, ''));
  });
});
