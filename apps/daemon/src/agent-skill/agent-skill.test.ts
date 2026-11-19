import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSkillLinkState } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createAgentSkill, type AgentSkillPlacement } from './index';
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
});
