import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type {
  ProjectDto,
  ProjectInput,
  Provider,
  RiskTag,
  TaskDto,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  createTestStore,
  findFlowByName,
  getProject,
  getTask,
  getWorkstreamRow,
  insertTask,
  insertWorkstream,
  seedProject,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { ManualClock } from '../src/clock';
import { createEventBus, createStateStore, type StateStore } from '../src/events';
import { createGit } from '../src/git';
import { createInboxService, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { createMcpHandler } from '../src/mcp';
import {
  createLiveSessions,
  createRunner,
  DEFAULT_RUNNER_LIMITS,
  type Runner,
  type RunnerOptions,
} from '../src/runner';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { createGateRunner } from '../src/verify';
import { retryWorkstream, seedTeam, startTaskWithPlan } from '../src/team';
import { measureForTests } from './catalogue';
import { createTempRepo, tempDir } from './fixtures';

export interface TestEngine {
  readonly store: Store;
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly runner: Runner;
  readonly adapter: FakeAdapter;
  readonly clock: ManualClock;
  readonly project: ProjectDto;
  readonly repoPath: string;
  readonly rateLimited: { provider: Provider; resetsAt: Date | null }[];
  addTask(
    title: string,
    areas?: string[],
    dependsOn?: TaskDto['id'][],
    plan?: { flow: string; riskTags?: RiskTag[]; criteria?: number },
  ): { task: TaskDto; workstream: WorkstreamDto };
  /** Does what the scheduler does: claims, lease, STARTING, then launch. */
  launch(id: WorkstreamId): void;
  /** Retries a failed workstream the way the API does. */
  retry(id: WorkstreamId): WorkstreamDto;
  close(): Promise<void>;
}

export async function createTestEngine(
  book: FakeScriptBook,
  project: Partial<ProjectInput> = {},
  runnerOverrides: Partial<Pick<RunnerOptions, 'afterSession' | 'sessionEnv'>> = {},
): Promise<TestEngine> {
  const repo = createTempRepo();
  const data = tempDir('engine-data');
  const { store, close } = createTestStore();
  const state = createStateStore(store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  measureForTests(state);
  const clock = new ManualClock();
  const adapter = new FakeAdapter(book);
  const live = createLiveSessions();
  const git = createGit();
  const rateLimited: { provider: Provider; resetsAt: Date | null }[] = [];
  let runner: Runner | null = null;
  const inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
  });
  const server = serve({
    fetch: createMcpHandler({
      state,
      inbox,
      git,
      log: silentLogger,
      waitObserverFor: (id) => live.get(id)?.observer,
      sessionSignal: (id) => live.get(id)?.signal,
    }),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise((r) => server.once('listening', r));
  // serve() on a TCP port always reports an AddressInfo once listening.
  const mcpUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  const created = createRunner({
    state,
    adapter,
    inbox,
    git,
    gate: createGateRunner(),
    clock,
    logger: silentLogger,
    dataDir: data.path,
    live,
    limits: { ...DEFAULT_RUNNER_LIMITS, gateTimeoutMs: 20_000 },
    mcpUrl: () => mcpUrl,
    sessionEnv: () => ({ PATH: '/usr/bin:/bin' }),
    onRateLimited: (provider, resetsAt) => {
      rateLimited.push({ provider, resetsAt });
    },
    onLaneFreed: () => undefined,
    ...runnerOverrides,
  });
  runner = created;
  const seeded = seedProject(store, {
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [
      { name: 'api', globs: ['src/api/**'] },
      { name: 'ui', globs: ['src/ui/**'] },
    ],
    ...project,
  });
  const engine: TestEngine = {
    store,
    state,
    inbox,
    runner: created,
    adapter,
    clock,
    project: seeded,
    repoPath: repo.path,
    rateLimited,
    addTask(title, areas = ['api'], dependsOn = [], plan) {
      const criteria = Array.from({ length: plan?.criteria ?? 1 }, (_, i) =>
        i === 0 ? 'it works' : `criterion ${String(i + 1)}`,
      );
      const flowId = plan ? findFlowByName(store.db, plan.flow)?.id : null;
      if (flowId === undefined) throw new Error(`no seeded flow is named ${plan?.flow ?? ''}`);
      const task = state.write((ctx) =>
        insertTask(ctx, seeded.id, {
          title,
          acceptanceCriteria: criteria,
          areas,
          dependsOn,
          riskTags: plan?.riskTags ?? [],
          flowId,
        }),
      );
      const workstream = plan
        ? startTaskWithPlan(state, task.id)
        : state.write((ctx) => insertWorkstream(ctx, task.id));
      return { task, workstream };
    },
    launch(id) {
      const row = getWorkstreamRow(store.db, id);
      const task = getTask(store.db, row.taskId);
      const fence = state.write((ctx) => {
        const lease = new Date(clock.now().getTime() + 60_000).toISOString();
        const claims = acquireClaims(ctx, {
          projectId: row.projectId,
          workstreamId: id,
          requests: claimRequestsForTask(task, getProject(ctx.tx, row.projectId)),
          leaseExpiresAt: lease,
        });
        if (!claims.ok) throw new Error(`claim conflict on ${claims.conflict.name}`);
        const f = acquireLease(ctx, id, 'test-daemon', lease);
        transitionWorkstream(ctx, id, { to: 'STARTING', fence: f });
        return f;
      });
      created.launch(id, fence);
    },
    retry: (id) => retryWorkstream(state, id),
    async close() {
      await created.stopAll('shutdown');
      server.close();
      close();
      repo.cleanup();
      data.cleanup();
    },
  };
  return engine;
}
