import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillLinkState, AgentSkillNotInstallable, EventType } from '@10db/contracts';
import { createTestStore, listEventsAfter } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { agentSkillPlacement, createAgentSkill, type AgentSkillPlacement } from './index';
import { installedSkillDir } from './install';

let root: string;
let home: string;
let shipped: string;
let base: ReturnType<typeof createTestStore>['store'];
let close: () => void;
let state: StateStore;

const VERSION = '0123456789ab';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-skill-svc-'));
  home = join(root, 'home');
  shipped = join(root, 'shipped');
  mkdirSync(home);
  mkdirSync(shipped);
  writeFileSync(join(shipped, 'SKILL.md'), 'skill');
  writeFileSync(join(shipped, 'tendb.mjs'), 'cli');
  writeFileSync(join(shipped, 'VERSION'), `${VERSION}\n`);
  ({ store: base, close } = createTestStore());
  state = createStateStore(base, createEventBus());
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});

const installable = (): AgentSkillPlacement => ({ kind: 'installable', shippedDir: shipped });
const make = (placement: AgentSkillPlacement) =>
  createAgentSkill({ state, placement, home, logger: silentLogger });

describe('createAgentSkill', () => {
  it('is on by default and installs at start', () => {
    const skill = make(installable());
    expect(skill.status().enabled).toBe(true);
    skill.atStart();
    const status = skill.status();
    expect(status).toMatchObject({
      installable: true,
      version: VERSION,
      installedVersion: VERSION,
      installedPath: installedSkillDir(home),
      error: null,
    });
    expect(status.links.map((l) => l.state)).toEqual([
      AgentSkillLinkState.Linked,
      AgentSkillLinkState.Linked,
    ]);
    expect(skill.shippedVersion()).toBe(VERSION);
  });

  it('turning it off persists across a new service, uninstalls and emits a settings event', () => {
    const skill = make(installable());
    skill.atStart();
    const after = skill.setEnabled(false);
    expect(after.enabled).toBe(false);
    expect(existsSync(installedSkillDir(home))).toBe(false);
    const again = make(installable());
    expect(again.status().enabled).toBe(false);
    again.atStart();
    expect(existsSync(installedSkillDir(home))).toBe(false);
    const events = listEventsAfter(base.db, 0, 50).filter(
      (e) => e.type === EventType.SettingsChanged && e.entityId === 'agent_skill_enabled',
    );
    expect(events).toHaveLength(1);
    expect(again.setEnabled(true).installedVersion).toBe(VERSION);
  });

  it('keeps an install failure for status and never throws from atStart', () => {
    rmSync(join(shipped, 'VERSION'));
    const skill = make(installable());
    expect(() => {
      skill.atStart();
    }).not.toThrow();
    expect(skill.status().error).toMatch(/VERSION/);
  });

  it.each([
    { reason: AgentSkillNotInstallable.FromSource, shippedDir: null },
    { reason: AgentSkillNotInstallable.OtherDataDir, shippedDir: null },
  ])('a $reason placement writes nothing at start or when switched', ({ reason, shippedDir }) => {
    const skill = make({ kind: 'not_installable', reason, shippedDir });
    skill.atStart();
    expect(skill.status().installable).toEqual({ reason });
    expect(skill.setEnabled(false).enabled).toBe(false);
    expect(skill.setEnabled(true).enabled).toBe(true);
    expect(existsSync(join(home, '.10db'))).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('not_installable leaves an installed copy and both links byte-identical when switched off', () => {
    make(installable()).atStart();
    const copyBefore = readFileSync(join(installedSkillDir(home), 'SKILL.md'), 'utf8');
    const other = make({
      kind: 'not_installable',
      reason: AgentSkillNotInstallable.OtherDataDir,
      shippedDir: shipped,
    });
    other.setEnabled(false);
    expect(readFileSync(join(installedSkillDir(home), 'SKILL.md'), 'utf8')).toBe(copyBefore);
    expect(other.status().links.map((l) => l.state)).toEqual([
      AgentSkillLinkState.Linked,
      AgentSkillLinkState.Linked,
    ]);
  });
});

describe('agentSkillPlacement', () => {
  it.each([
    {
      name: 'no shipped copy: from source',
      shipped: null,
      dataDir: '/app',
      expected: { kind: 'not_installable', reason: 'from_source', shippedDir: null },
    },
    {
      name: 'another data dir',
      shipped: '/s',
      dataDir: '/other',
      expected: { kind: 'not_installable', reason: 'other_data_dir', shippedDir: '/s' },
    },
    {
      name: 'the app',
      shipped: '/s',
      dataDir: '/app',
      expected: { kind: 'installable', shippedDir: '/s' },
    },
  ])('$name', ({ shipped, dataDir, expected }) => {
    expect(agentSkillPlacement(shipped, dataDir, '/app')).toEqual(expected);
  });
});
