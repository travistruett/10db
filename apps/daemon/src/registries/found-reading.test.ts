import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestStore, deleteAppSetting, listPermissionRules, seedProject } from '@10db/db';
import type { Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  isolatedGitEnv,
  type TempDir,
} from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService, raiseGateHostCards } from '../inbox';
import { silentLogger } from '../log';
import {
  allowFoundHosts,
  foundHostFile,
  listNetworkHosts,
  readFoundHosts,
  writeFoundHosts,
} from '../permissions';
import { BlockedRun } from '../verify';
import { takeFoundHostsReading } from './index';

const CRATES = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n';
const git = createGit();

let close: () => void;
let store: Store;
let state: StateStore;
let bus: ReturnType<typeof createEventBus>;
let repo: TempDir;
beforeEach(() => {
  ({ store, close } = createTestStore());
  bus = createEventBus();
  state = createStateStore(store, bus);
  repo = createTempRepo();
});
afterEach(() => {
  close();
  repo.cleanup();
});

const run = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });

function write(name: string, text: string): void {
  const path = join(repo.path, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function commit(name: string, text: string): void {
  write(name, text);
  run('add', '--force', name);
  run('commit', '-q', '-m', `add ${name}`);
}

/** A project added before 10db kept a reading: its checkout is `repo`, and no reading was ever written. */
function oldProject(delivery: 'local' | 'pull_request' = 'pull_request') {
  const project = seedProject(store, { repoPath: repo.path, delivery });
  state.write((ctx) => {
    deleteAppSetting(ctx, `network-hosts-found:${project.id}`);
  });
  return project;
}

const take = (projectId: string) =>
  takeFoundHostsReading({ state, git, logger: silentLogger }, projectId as never);

describe('taking a reading for a project added before 10db kept one', () => {
  it('reads the files committed on its default branch, 3 folders down included', async () => {
    commit('apps/desktop/src-tauri/Cargo.lock', CRATES);
    const project = oldProject();

    await take(project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual([
      { host: 'index.crates.io', file: 'apps/desktop/src-tauri/Cargo.lock' },
      { host: 'static.crates.io', file: 'apps/desktop/src-tauri/Cargo.lock' },
    ]);
    expect(foundHostFile(state.db, project.id, 'index.crates.io')).toBe(
      'apps/desktop/src-tauri/Cargo.lock',
    );
  });

  it('allows no host, stores no rule and emits no event', async () => {
    commit('Cargo.lock', CRATES);
    const project = oldProject();
    const events: unknown[] = [];
    bus.subscribe((event) => events.push(event));

    await take(project.id);

    expect(events).toEqual([]);
    expect(listNetworkHosts(state.db, project.id)).toEqual([]);
    expect(listPermissionRules(state.db, project.id, null)).toEqual([]);
    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('does not read a lane’s uncommitted or untracked edits', async () => {
    commit('Cargo.lock', CRATES);
    write('.npmrc', '@x:registry=https://exfil.example.net/\n');
    write('Cargo.lock', 'source = "git+https://evil.example.net/o/r"\n');
    const project = oldProject();

    await take(project.id);

    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('keeps the reading: later files and later calls change nothing', async () => {
    commit('Cargo.lock', CRATES);
    const project = oldProject();
    await take(project.id);
    const first = readFoundHosts(state.db, project.id);

    commit('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    await take(project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual(first);
  });

  it('keeps an empty reading too: files that name nothing are not read again', async () => {
    const project = oldProject();
    await take(project.id);
    expect(readFoundHosts(state.db, project.id)).toEqual([]);

    commit('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    await take(project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual([]);
  });

  it('leaves the reading createProject made as it is', async () => {
    commit('Cargo.lock', CRATES);
    const project = seedProject(store, { repoPath: repo.path });
    allowFoundHosts(state, project.id, [{ host: 'rubygems.org', file: 'Gemfile.lock' }]);

    await take(project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual([
      { host: 'rubygems.org', file: 'Gemfile.lock' },
    ]);
  });

  it('reads the project’s default branch, not the branch checked out', async () => {
    commit('Cargo.lock', CRATES);
    run('switch', '-q', '-c', 'lane');
    commit('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    const project = oldProject();

    await take(project.id);

    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('takes none, and says nothing, when the default branch can’t be read; a later call tries again', async () => {
    const project = seedProject(store, {
      repoPath: repo.path,
      baseBranch: 'nope',
      delivery: 'pull_request',
    });
    state.write((ctx) => {
      deleteAppSetting(ctx, `network-hosts-found:${project.id}`);
    });

    await take(project.id);
    expect(readFoundHosts(state.db, project.id)).toEqual([]);

    run('branch', 'nope');
    commit('Cargo.lock', CRATES);
    run('branch', '-f', 'nope', 'main');
    await take(project.id);
    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('keeps a reading made while it read, never replacing it', async () => {
    commit('Cargo.lock', CRATES);
    const project = oldProject();
    const made = [{ host: 'rubygems.org', file: 'Gemfile.lock' }];
    // Another caller (or createProject) keeps its reading while this one is still listing the branch.
    const racing = {
      fileAt: git.fileAt.bind(git),
      folderAt: async (r: string, rev: string, folder: string) => {
        const listing = await git.folderAt(r, rev, folder);
        if (folder === '' && readFoundHosts(state.db, project.id).length === 0) {
          state.write((ctx) => {
            writeFoundHosts(ctx, project.id, made);
          });
        }
        return listing;
      },
    };

    await takeFoundHostsReading({ state, git: racing, logger: silentLogger }, project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual(made);
  });
});

describe('under local delivery', () => {
  let origin: ReturnType<typeof createTempRepoWithOrigin>;
  beforeEach(() => {
    repo.cleanup();
    origin = createTempRepoWithOrigin();
    repo = origin.repo;
  });
  afterEach(() => {
    origin.origin.cleanup();
  });

  it('reads origin’s copy of the default branch', async () => {
    commit('Cargo.lock', CRATES);
    run('push', '-q', 'origin', 'main');
    const project = oldProject('local');

    await take(project.id);

    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('never reads the local default branch, which a lane’s commit tool can move', async () => {
    commit('Cargo.lock', CRATES);
    run('push', '-q', 'origin', 'main');
    // The lane commits on main itself, as a local lane on the builder's checkout does.
    write('.npmrc', '@x:registry=https://exfil.example.net/\n');
    await git.commit({
      repo: repo.path,
      paths: ['.npmrc'],
      message: 'registry',
      opId: 'op-lane-npmrc',
      branch: 'main',
    });
    const project = oldProject('local');

    await take(project.id);

    expect(foundHostFile(state.db, project.id, 'exfil.example.net')).toBeNull();
    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toEqual([
      'index.crates.io',
      'static.crates.io',
    ]);
  });

  it('takes no reading when origin has no copy of the default branch', async () => {
    commit('Cargo.lock', CRATES);
    run('update-ref', '-d', 'refs/remotes/origin/main');
    const project = oldProject('local');

    await take(project.id);

    expect(readFoundHosts(state.db, project.id)).toEqual([]);
    commit('Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\n');
    run('push', '-q', 'origin', 'main');
    await take(project.id);
    expect(readFoundHosts(state.db, project.id).map((f) => f.host)).toContain('rubygems.org');
  });
});

describe('a blocked-host card for a project added before readings', () => {
  it('names the file that needs the host and recommends Allow, as for a project added now', async () => {
    commit('apps/desktop/src-tauri/Cargo.lock', CRATES);
    const project = oldProject();
    const inbox = createInboxService({ state, onParkedAnswer: () => undefined });

    await take(project.id);
    const [card] = raiseGateHostCards(
      { state, inbox },
      {
        projectId: project.id,
        run: BlockedRun.Gate,
        command: 'cargo test',
        hosts: ['index.crates.io'],
      },
    );

    expect(card?.body).toContain(
      "The project's apps/desktop/src-tauri/Cargo.lock needs index.crates.io",
    );
    expect(card?.recommendation).toBe('Allow for the project');
    expect(listNetworkHosts(state.db, project.id)).toEqual([]);
  });
});

describe('writeFoundHosts is the reading', () => {
  it('is what a project added now gets', () => {
    const project = seedProject(store, { repoPath: repo.path });
    state.write((ctx) => {
      writeFoundHosts(ctx, project.id, []);
    });
    expect(readFoundHosts(state.db, project.id)).toEqual([]);
  });
});
