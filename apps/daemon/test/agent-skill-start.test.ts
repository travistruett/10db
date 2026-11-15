import { existsSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentSkillInfo, AgentSkillStatus, SKILL_VERSION_HEADER } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { installedSkillDir } from '../src/agent-skill';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter } from '../src/sessions';
import { tempDir, type TempDir } from './fixtures';

const VERSION = '0123456789ab';
const cleanups: (() => void)[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(name: string): TempDir {
  const dir = tempDir(name);
  cleanups.push(() => {
    dir.cleanup();
  });
  return dir;
}

async function start(placement: 'installable' | 'other_data_dir') {
  const data = scratch('skill start data');
  const home = scratch('skill start home');
  const shipped = scratch('skill start shipped');
  writeFileSync(join(shipped.path, 'SKILL.md'), 'skill');
  writeFileSync(join(shipped.path, 'tendb.mjs'), 'cli');
  writeFileSync(join(shipped.path, 'VERSION'), `${VERSION}\n`);
  const daemon = await startDaemon({
    sandbox: null,
    dataDir: data.path,
    port: 0,
    adapter: new FakeAdapter({}),
    logLevel: 'warn',
    caffeinate: () => null,
    watch: false,
    builderHome: home.path,
    agentSkill:
      placement === 'installable'
        ? { kind: 'installable', shippedDir: shipped.path }
        : { kind: 'not_installable', reason: 'other_data_dir', shippedDir: shipped.path },
  });
  daemons.push(daemon);
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${daemon.url}${path}`, {
      headers: { Authorization: `Bearer ${daemon.token}`, ...headers },
    });
  return { home: home.path, get };
}

describe('a started daemon and the agent skill', () => {
  it('installs and links on start, serves its status, and refuses a skill of another version', async () => {
    const { home, get } = await start('installable');
    expect(readlinkSync(join(home, '.claude', 'skills', '10db-task'))).toBe(
      installedSkillDir(home),
    );
    expect(readlinkSync(join(home, '.agents', 'skills', '10db-task'))).toBe(
      installedSkillDir(home),
    );

    const status = AgentSkillStatus.parse(await (await get('/settings/agent-skill')).json());
    expect(status).toMatchObject({
      enabled: true,
      installable: true,
      version: VERSION,
      error: null,
    });
    const info = AgentSkillInfo.parse(await (await get('/agent-skill')).json());
    expect(info.version).toBe(VERSION);

    expect((await get('/projects', { [SKILL_VERSION_HEADER]: VERSION })).status).toBe(200);
    expect((await get('/projects', { [SKILL_VERSION_HEADER]: 'bbbbbbbbbbbb' })).status).toBe(409);
  });

  it('on another data dir creates nothing in the home and still serves the setting', async () => {
    const { home, get } = await start('other_data_dir');
    expect(existsSync(join(home, '.10db'))).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(join(home, '.agents'))).toBe(false);
    const status = AgentSkillStatus.parse(await (await get('/settings/agent-skill')).json());
    expect(status.installable).toEqual({ reason: 'other_data_dir' });
    expect(readdirSync(home)).toEqual([]);
  });
});
