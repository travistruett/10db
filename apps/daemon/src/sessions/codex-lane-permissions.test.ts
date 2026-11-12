import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { autoModeRules, type LaneSandboxSpec } from '../sandbox';
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
function spec(allowRead: readonly string[]): LaneSandboxSpec {
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
      denyWrite: [],
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
    autoMode: autoModeRules(null),
  };
}

function filesystem(allowRead: readonly string[]): Record<string, unknown> {
  const lane = lanePermissions(spec(allowRead))['lane'];
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
});
