import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestStore, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { listWebHosts, removeWebHost } from '../permissions';
import { takeWebHostsStart } from './index';

const git = createGit();
const MANIFEST = JSON.stringify({ dependencies: { react: '19.0.0' } });

let close: () => void;
let store: Store;
let state: StateStore;
let origin: ReturnType<typeof createTempRepoWithOrigin>;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  origin = createTempRepoWithOrigin();
});
afterEach(() => {
  close();
  origin.cleanup();
});

const run = (...args: string[]) =>
  execFileSync('git', ['-C', origin.repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: 'pipe',
  });

function commit(name: string, text: string): void {
  writeFileSync(join(origin.repo.path, name), text);
  run('add', '--force', name);
  run('commit', '-q', '-m', `add ${name}`);
}

const hosts = (projectId: Parameters<typeof listWebHosts>[1]): string[] =>
  listWebHosts(state.db, projectId).map((h) => h.host);
const start = (projectId: Parameters<typeof listWebHosts>[1]) =>
  takeWebHostsStart({ state, git, logger: silentLogger }, projectId);

describe('the start of a project read list', () => {
  it('reads the dependencies committed on the default branch', async () => {
    commit('package.json', MANIFEST);
    run('push', '-q', 'origin', 'main');
    const project = seedProject(store, { repoPath: origin.repo.path });
    await start(project.id);
    expect(hosts(project.id)).toEqual([
      'github.com',
      'www.npmjs.com',
      'developer.mozilla.org',
      'react.dev',
    ]);
  });

  it('never sees a manifest a lane wrote in the checkout or committed locally', async () => {
    commit('package.json', MANIFEST);
    writeFileSync(join(origin.repo.path, 'Cargo.toml'), '[package]\n');
    const project = seedProject(store, { repoPath: origin.repo.path });
    await start(project.id);
    expect(hosts(project.id)).toEqual(['github.com']);
  });

  it('still lists github.com when the branch cannot be read', async () => {
    const project = seedProject(store, { repoPath: '/no/such/repo' });
    await start(project.id);
    expect(hosts(project.id)).toEqual(['github.com']);
  });

  it('happens once, so a removed host stays out', async () => {
    const project = seedProject(store, { repoPath: origin.repo.path });
    await start(project.id);
    removeWebHost(state, project.id, 'github.com');
    await start(project.id);
    expect(hosts(project.id)).toEqual([]);
  });
});
