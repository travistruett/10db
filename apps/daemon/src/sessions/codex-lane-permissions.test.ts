import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import type { LaneSandboxSpec } from '../sandbox';
import { lanePermissions } from './codex-lane-permissions';

let root: TempDir;
let home: string;
let checkout: string;

beforeEach(() => {
  root = tempDir('codex-perms');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(checkout);
});

afterEach(() => {
  root.cleanup();
});

/** A lane profile as the lane sandbox builds it, with only what these rows read. */
function spec(allowRead: readonly string[], denyWrite: readonly string[] = []): LaneSandboxSpec {
  const settings = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/', join(home, '.claude')],
      allowRead: ['/usr', checkout, ...allowRead],
      allowWrite: [join(root.path, 'tmp')],
      denyWrite: [...denyWrite],
    },
    network: {
      allowedDomains: [],
      allowMachLookup: ['com.apple.FSEvents'],
      allowUnixSockets: [],
    },
    credentials: { envVars: [] },
  } satisfies LaneSandboxSpec['settings'];
  return {
    settings,
    checkout,
    env: {},
    shellEnv: {},
    disallowedTools: [],
    askRules: [],
  };
}

function filesystem(
  allowRead: readonly string[],
  denyWrite: readonly string[] = [],
): Record<string, unknown> {
  const lane = lanePermissions(spec(allowRead, denyWrite))['lane'];
  if (typeof lane !== 'object' || lane === null || !('filesystem' in lane))
    throw new Error('no lane');
  const fs = lane.filesystem;
  if (typeof fs !== 'object' || fs === null) throw new Error('no filesystem');
  return { ...fs };
}

describe('lanePermissions and the setup reads', () => {
  it('opens a setup read under a denied root and keeps the root denied', () => {
    const skills = join(home, '.claude', 'skills');
    const entries = filesystem([skills]);
    expect(entries[skills]).toBe('read');
    expect(entries[join(home, '.claude')]).toBe('deny');
  });

  it('a collapsed setup of 200 skills adds at most 25 entries', () => {
    const outside = Array.from({ length: 20 }, (_, i) => {
      const dir = join(root.path, 'outside', `l${String(i)}`);
      mkdirSync(dir, { recursive: true });
      return realpathSync(dir);
    });
    const plain = Object.keys(filesystem([])).length;
    const withSetup = Object.keys(filesystem([join(home, '.claude', 'skills'), ...outside])).length;
    expect(withSetup - plain).toBeLessThanOrEqual(25);
  });

  // A chat's profile: writable while its turn holds Your folder, with git state read-only; read-only while it doesn't.
  it.each([
    {
      name: 'a writing chat: the checkout writes and its git state only reads',
      denyWrite: () => [join(checkout, '.git')],
      expected: () => ({ [checkout]: 'write', [join(checkout, '.git')]: 'read' }),
    },
    {
      name: 'a reading chat: the whole checkout only reads',
      denyWrite: () => [checkout],
      expected: () => ({ [checkout]: 'read' }),
    },
  ])('maps $name', ({ denyWrite, expected }) => {
    mkdirSync(join(checkout, '.git'));
    expect(filesystem([], denyWrite())).toMatchObject(expected());
  });
});

describe('lanePermissions and the toolchain listings', () => {
  // Escaped bug: every mise shim in a Codex lane failed with `Operation not permitted`, since the
  // profile dropped the listing patterns and mise lists its installs dir on every command.
  it('opens a listed dir and denies what under it the Claude profile keeps closed', () => {
    const installs = join(home, '.local', 'share', 'mise', 'installs');
    const tool = join(installs, 'node');
    const version = join(tool, '26.13.0');
    for (const dir of ['bin', 'etc', 'lib']) mkdirSync(join(version, dir), { recursive: true });
    mkdirSync(join(installs, 'empty', 'inside'), { recursive: true });
    writeFileSync(join(installs, '.mise-installs.toml'), '');
    writeFileSync(join(tool, '.mise.backend.toml'), '');
    writeFileSync(join(version, 'notes.txt'), '');
    symlinkSync(join(home, '.rustup'), join(tool, 'linked'));
    // The two patterns the lane profile lists `installs` with (`listingGrant`, `childListingGrant`).
    const listings = [`${installs.slice(0, -1)}[s]`, `${installs}/*`];
    const reads = [join(version, 'bin'), join(version, 'lib')];

    const entries = filesystem([...listings, ...reads]);

    expect(entries).toMatchObject({
      [installs]: 'read',
      [join(version, 'bin')]: 'read',
      [join(version, 'etc')]: 'deny',
      [join(version, 'notes.txt')]: 'deny',
      [join(tool, '.mise.backend.toml')]: 'deny',
      [join(installs, 'empty', 'inside')]: 'deny',
    });
    const listable = [tool, version, join(installs, 'empty')];
    for (const path of [join(installs, '.mise-installs.toml'), ...listable, join(tool, 'linked')])
      expect(entries).not.toHaveProperty([path]);
    expect(Object.keys(entries).some((key) => key.includes('*') || key.includes('['))).toBe(false);
  });
});
