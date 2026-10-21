import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  InboxKind,
  WORKSTREAM_TRANSITIONS,
  type InboxItemDto,
  type ProjectDto,
  type ProjectInput,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import {
  createTestStore,
  findFlowByName,
  getWorkstreamRow,
  insertTask,
  listInbox,
  seedProject,
  setTaskStatus,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import {
  createBatchStarter,
  createDeliveryJobs,
  DEFAULT_DELIVERY_LIMITS,
  type BatchStarter,
  type DeliveryContext,
  type DeliveryJobs,
} from '../src/delivery';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../src/events';
import { createGit, type Git } from '../src/git';
import { createInboxService, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { seedTeam } from '../src/team';
import { measureForTests } from './catalogue';
import { FakeGh } from './fake-gh';
import { createTempRepoWithOrigin, NETWORK_ENV, tempDir } from './fixtures';

type Settled = 'DONE' | 'FAILED' | 'CANCELLED' | 'WAITING_HUMAN' | 'RUNNING';

/** The shortest run of allowed transitions from `from` to `to`, as the runner would take it. */
function pathBetween(from: WorkstreamState, to: WorkstreamState): WorkstreamState[] {
  const previous = new Map<WorkstreamState, WorkstreamState>();
  const queue: WorkstreamState[] = [from];
  for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
    if (state === to) break;
    for (const next of WORKSTREAM_TRANSITIONS[state]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, state);
      queue.push(next);
    }
  }
  const path: WorkstreamState[] = [];
  for (let s: WorkstreamState | undefined = to; s !== undefined && s !== from; s = previous.get(s))
    path.unshift(s);
  if (path[0] === undefined || !WORKSTREAM_TRANSITIONS[from].includes(path[0]))
    throw new Error(`no path from ${from} to ${to}`);
  return path;
}

export interface DeliveryHarness {
  readonly store: Store;
  readonly bus: EventBus;
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly gh: FakeGh;
  readonly jobs: DeliveryJobs;
  readonly ctx: DeliveryContext;
  readonly starter: BatchStarter;
  readonly project: ProjectDto;
  readonly repo: string;
  readonly origin: string;
  /** How many times delivery asked the scheduler to look for work. */
  readonly ticks: { count: number };
  addTask(
    title: string,
    opts?: { readonly areas?: string[]; readonly dependsOn?: TaskId[] },
  ): TaskDto;
  /** Moves a workstream on from where it is, as the runner would; DONE also marks its task done. */
  settle(id: WorkstreamId, to: Settled): void;
  /** Commits a file on the checked-out branch, as the commit tool does for an agent. */
  commit(path: string): string;
  git$(...args: string[]): string;
  origin$(...args: string[]): string;
  /** Another clone commits `path` to `branch` on origin, as a teammate would; returns the new SHA. */
  teammatePush(branch: string, path: string): string;
  /** Open flag cards, oldest first. */
  cards(): InboxItemDto[];
  /** The single element of `items`; throws on none or several. */
  only<T>(items: readonly T[]): T;
  close(): void;
}

export function createDeliveryHarness(project: Partial<ProjectInput> = {}): DeliveryHarness {
  const remote = createTempRepoWithOrigin();
  const { store, close } = createTestStore();
  const bus = createEventBus();
  const state = createStateStore(store, bus);
  seedTeam(state, readDefaultPersonas());
  measureForTests(state);
  const inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const git = createGit();
  const gh = new FakeGh();
  const jobs = createDeliveryJobs(silentLogger);
  const ticks = { count: 0 };
  const quick = findFlowByName(store.db, 'quick');
  if (!quick) throw new Error('the quick flow was not seeded');
  const seeded = seedProject(store, {
    repoPath: remote.repo.path,
    gateCommand: 'true',
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    flowId: quick.id,
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
    ...project,
  });
  const ctx: DeliveryContext = {
    state,
    git,
    gh,
    inbox,
    jobs,
    logger: silentLogger,
    limits: { ...DEFAULT_DELIVERY_LIMITS, networkTimeoutMs: 10_000, gateTimeoutMs: 20_000 },
    networkEnv: () => NETWORK_ENV,
    onWorkQueued: () => {
      ticks.count += 1;
    },
  };
  const run = (dir: string, args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
      .toString()
      .trim();
  return {
    store,
    bus,
    state,
    inbox,
    git,
    gh,
    jobs,
    ctx,
    starter: createBatchStarter(ctx),
    project: seeded,
    repo: remote.repo.path,
    origin: remote.origin.path,
    ticks,
    addTask(title, opts = {}) {
      return state.write((c) =>
        insertTask(c, seeded.id, {
          title,
          acceptanceCriteria: ['it works'],
          areas: opts.areas ?? ['api'],
          dependsOn: opts.dependsOn ?? [],
        }),
      );
    },
    settle(id, to) {
      state.write((c) => {
        for (const step of pathBetween(getWorkstreamRow(c.tx, id).state, to))
          transitionWorkstream(c, id, { to: step, fence: null });
        if (to === 'DONE') setTaskStatus(c, getWorkstreamRow(c.tx, id).taskId, 'done');
      });
    },
    commit(path) {
      const file = join(remote.repo.path, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${path}\n`);
      run(remote.repo.path, ['add', path]);
      run(remote.repo.path, ['commit', '-q', '-m', `Add ${path}`]);
      return run(remote.repo.path, ['rev-parse', 'HEAD']);
    },
    git$: (...args) => run(remote.repo.path, args),
    origin$: (...args) => run(remote.origin.path, args),
    teammatePush(branch, path) {
      const other = tempDir('teammate');
      try {
        execFileSync('git', ['clone', '-q', remote.origin.path, other.path], { stdio: 'pipe' });
        run(other.path, ['config', 'user.name', 'teammate']);
        run(other.path, ['config', 'user.email', 'teammate@10db.invalid']);
        run(other.path, ['config', 'commit.gpgsign', 'false']);
        if (branch !== 'main') run(other.path, ['switch', '-q', '-c', branch]);
        const file = join(other.path, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${path}\n`);
        run(other.path, ['add', path]);
        run(other.path, ['commit', '-q', '-m', `Add ${path}`]);
        run(other.path, ['push', '-q', 'origin', branch]);
        return run(other.path, ['rev-parse', 'HEAD']);
      } finally {
        other.cleanup();
      }
    },
    cards: () => listInbox(store.db, { states: ['OPEN'] }).filter((i) => i.kind === InboxKind.Flag),
    only(items) {
      const [item] = items;
      if (item === undefined || items.length !== 1)
        throw new Error(`expected exactly one, got ${String(items.length)}`);
      return item;
    },
    close() {
      close();
      remote.cleanup();
    },
  };
}
