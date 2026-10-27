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
import { ManualClock } from '../src/clock';
import {
  createBatchStarter,
  createDeliveryJobs,
  createShipper,
  DEFAULT_DELIVERY_LIMITS,
  subscribeShipTrigger,
  type BatchStarter,
  type DeliveryContext,
  type DeliveryJobs,
  type Shipper,
} from '../src/delivery';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../src/events';
import { createGit, type Git } from '../src/git';
import { createInboxService, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { systemProcesses } from '../src/recovery';
import { seedTeam } from '../src/team';
import { createGateRunner } from '../src/verify';
import { measureForTests } from './catalogue';
import { FakeGh } from './fake-gh';
import { captureLogs, type LogCapture } from './log-capture';
import {
  createTempClone,
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
} from './fixtures';

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
  /** The delivery logger's lines: what daemon.log says about cuts, gates, pushes and PRs. */
  readonly logs: LogCapture;
  readonly starter: BatchStarter;
  readonly shipper: Shipper;
  /** Where the shipper writes PR bodies and gate logs. */
  readonly dataDir: string;
  /** Workstreams whose runner is live, as the shipper's `isRunning` sees them. */
  readonly running: Set<WorkstreamId>;
  readonly project: ProjectDto;
  readonly repo: string;
  readonly origin: string;
  /** How many times delivery asked the scheduler to look for work. */
  readonly ticks: { count: number };
  addTask(
    title: string,
    opts?: {
      readonly areas?: string[];
      readonly dependsOn?: TaskId[];
      readonly description?: string;
      readonly acceptanceCriteria?: string[];
    },
  ): TaskDto;
  /** Moves a workstream on from where it is, as the runner would; DONE also marks its task done. */
  settle(id: WorkstreamId, to: Settled): void;
  /** Commits a file on the checked-out branch, as the commit tool does for an agent. */
  commit(path: string, content?: string): string;
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

export function createDeliveryHarness(
  project: Partial<ProjectInput> = {},
  opts: {
    readonly gateTimeoutMs?: number;
    readonly networkTimeoutMs?: number;
    readonly pushTimeoutMs?: number;
    /** Added to the network calls' environment, such as an ssh command for a hanging transport. */
    readonly networkEnv?: Readonly<Record<string, string>>;
    readonly trigger?: boolean;
  } = {},
): DeliveryHarness {
  const remote = createTempRepoWithOrigin();
  // origin is github.com, as the daemon pins it and gh is told it; network calls and the test's
  // own pushes go to the local bare repository instead.
  const network = githubOrigin(remote.repo.path, remote.origin.path);
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
  const logs = captureLogs();
  const ctx: DeliveryContext = {
    state,
    git,
    gh,
    inbox,
    jobs,
    logger: logs.logger,
    limits: {
      ...DEFAULT_DELIVERY_LIMITS,
      networkTimeoutMs: opts.networkTimeoutMs ?? 10_000,
      pushTimeoutMs: opts.pushTimeoutMs ?? 20_000,
      gateTimeoutMs: opts.gateTimeoutMs ?? 20_000,
    },
    networkEnv: () => ({ ...NETWORK_ENV, GIT_CONFIG_GLOBAL: network.global, ...opts.networkEnv }),
    onWorkQueued: () => {
      ticks.count += 1;
    },
  };
  const data = tempDir('delivery-data');
  const running = new Set<WorkstreamId>();
  const shipper = createShipper({
    ...ctx,
    gate: createGateRunner(),
    clock: new ManualClock(),
    dataDir: data.path,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    identifyProcess: (pid) => systemProcesses.identify(pid),
    isRunning: (id) => running.has(id),
  });
  const unsubscribe =
    opts.trigger === false ? () => undefined : subscribeShipTrigger(bus, store.db, shipper);
  const run = (dir: string, args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], {
      env: { ...isolatedGitEnv(), GIT_CONFIG_GLOBAL: network.global },
      stdio: 'pipe',
    })
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
    logs,
    starter: createBatchStarter(ctx),
    shipper,
    dataDir: data.path,
    running,
    project: seeded,
    repo: remote.repo.path,
    origin: remote.origin.path,
    ticks,
    addTask(title, opts = {}) {
      return state.write((c) =>
        insertTask(c, seeded.id, {
          title,
          description: opts.description ?? '',
          acceptanceCriteria: opts.acceptanceCriteria ?? ['it works'],
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
    commit(path, content = `${path}\n`) {
      const file = join(remote.repo.path, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      run(remote.repo.path, ['add', path]);
      run(remote.repo.path, ['commit', '-q', '-m', `Add ${path}`]);
      return run(remote.repo.path, ['rev-parse', 'HEAD']);
    },
    git$: (...args) => run(remote.repo.path, args),
    origin$: (...args) => run(remote.origin.path, args),
    teammatePush(branch, path) {
      const other = createTempClone(remote.origin.path);
      try {
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
      unsubscribe();
      close();
      data.cleanup();
      remote.cleanup();
      network.cleanup();
    },
  };
}
