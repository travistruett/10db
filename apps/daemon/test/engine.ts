import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { mintId } from '@10db/contracts';
import type {
  AccountId,
  BatchId,
  AccountInput,
  InboxAnswer,
  InboxItemDto,
  ProjectDto,
  ProjectId,
  ProjectInput,
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
  patchAccount,
  accountSecretRef,
  recordAccountSecret,
  seedAccount,
  seedProject,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { readDefaultPersonas, readSkillBody } from '@10db/harness';
import {
  createAccountCardAnswers,
  createAccountLimits,
  createAccountMoves,
  createAccountPauses,
  createAccountRuntime,
  createMoveBack,
  MoveCause,
  createStartGate,
  createUsageReports,
  type AccountLimits,
  type AccountMoves,
  type AccountRuntime,
  type StartGate,
  type UsageReport,
} from '../src/accounts';
import { ManualClock } from '../src/clock';
import {
  AwsCredentialsError,
  createLauncher,
  secretFingerprint,
  type Keychain,
} from '../src/environment';
import { createEventBus, createStateStore, type EventBus, type StateStore } from '../src/events';
import { createDeliveryJobs } from '../src/delivery';
import { createGit } from '../src/git';
import { startSignOff } from '../src/pass';
import type { Judge } from '../src/judge';
import { createInboxService, createParkAnswers, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { protectedPaths } from '../src/guard';
import { createMcpHandler } from '../src/mcp';
import {
  applyCheckAnswer,
  RunnerNotStartedError,
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
import { seedProfiles } from './seed-profiles';
import { createMemoryKeychain, createTempRepo, tempDir } from './fixtures';

export interface TestEngine {
  readonly store: Store;
  readonly state: StateStore;
  /** Every event the engine's writes push, as the daemon's listeners get them. */
  readonly bus: EventBus;
  readonly inbox: InboxService;
  readonly runner: Runner;
  readonly adapter: FakeAdapter;
  readonly clock: ManualClock;
  readonly project: ProjectDto;
  readonly repoPath: string;
  /** The daemon's data directory, which the guard protects. */
  readonly dataDir: string;
  readonly accounts: AccountRuntime;
  readonly moves: AccountMoves;
  readonly keychain: Keychain;
  readonly rateLimited: { accountId: AccountId; resetsAt: Date | null }[];
  /** Every usage report the runner passed on, before the limits acted on it. */
  readonly usageReports: { accountId: AccountId; report: UsageReport }[];
  readonly startGate: StartGate;
  /** The account each ended session reported to the account runtime. */
  readonly sessionsEnded: { accountId: AccountId; projectId: ProjectId }[];
  /** What the runner asked the preparer; the engine has no scheduler. */
  readonly prepared: { accountId: AccountId; projectId: ProjectId }[];
  addTask(
    title: string,
    areas?: string[],
    dependsOn?: TaskDto['id'][],
    plan?: { flow: string; riskTags?: RiskTag[]; criteria?: number },
    batchId?: BatchId,
  ): { task: TaskDto; workstream: WorkstreamDto };
  /** Does what the scheduler does: claims, lease, STARTING, then launch. */
  launch(id: WorkstreamId): void;
  /** Retries a failed workstream the way the API does. */
  retry(id: WorkstreamId, note?: string): WorkstreamDto;
  close(): Promise<void>;
}

/** A judge that is off: every decision keeps today's rule. */
export const offJudge: Judge = {
  off: true,
  choose: () =>
    Promise.resolve({
      kind: 'fallback',
      reason: 'off',
      detail: 'off',
      callId: mintId('JudgeCall'),
    }),
};

export async function createTestEngine(
  book: FakeScriptBook,
  project: Partial<ProjectInput> = {},
  runnerOverrides: Partial<
    Pick<
      RunnerOptions,
      | 'afterSession'
      | 'modelWait'
      | 'logger'
      | 'skillBody'
      | 'launcher'
      | 'laneSandbox'
      | 'identifyProcess'
      | 'gate'
      | 'onLaneFreed'
      | 'baseUpdates'
      | 'hold'
      | 'laneTempDirs'
      | 'migrationsBase'
      | 'judge'
      | 'git'
      | 'worktreeRoot'
      | 'builderHome'
      | 'laneWritableRoots'
      | 'codexLaneTempRoot'
      | 'awaitBeforePicture'
    >
  > = {},
  setup: {
    readonly account?: AccountInput;
    readonly secret?: string;
    /** How long one request_claim call waits before it answers "still waiting", and how often it looks. */
    readonly claims?: { readonly sliceMs: number; readonly pollMs: number };
  } = {},
): Promise<TestEngine> {
  const repo = createTempRepo();
  const data = tempDir('engine-data');
  // The store stamps sessions with the test clock, so the monthly cap reads the clock's month.
  const clock = new ManualClock();
  const { store, close } = createTestStore(() => clock.now());
  const bus = createEventBus();
  const state = createStateStore(store, bus);
  seedTeam(state, readDefaultPersonas());
  seedProfiles(state);
  measureForTests(state);
  const adapter = new FakeAdapter(book);
  const live = createLiveSessions();
  const git = createGit();
  const jobs = createDeliveryJobs(silentLogger);
  const keychain = createMemoryKeychain();
  const rateLimited: { accountId: AccountId; resetsAt: Date | null }[] = [];
  const usageReports: { accountId: AccountId; report: UsageReport }[] = [];
  const prepared: { accountId: AccountId; projectId: ProjectId }[] = [];
  const sessionsEnded: { accountId: AccountId; projectId: ProjectId }[] = [];
  const startGate = createStartGate();
  let runner: Runner | null = null;
  let answerAccountCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  // As start.ts wires it: "Park the task" stops the run as a cancel from the Board does.
  const parkAnswers = createParkAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    log: silentLogger,
  });
  const inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
    onParkAnswer: parkAnswers,
    onCheckAnswer: (ctx, item, answer) => {
      const ready = runner;
      if (!ready) throw new RunnerNotStartedError();
      return applyCheckAnswer(ready, ctx, item, answer, (taskId) => {
        startSignOff(
          {
            state,
            git,
            inbox,
            jobs,
            logger: silentLogger,
            clock,
            stopLane: (id) => ready.stopPassLane(id),
          },
          taskId,
        );
      });
    },
    onFlagAnswer: (item, answer) => {
      runner?.retryTurn(item, answer);
      answerAccountCard?.(item, answer);
    },
  });
  const pauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: (id) => runner?.stopAccount(id, 'paused') ?? Promise.resolve(),
    onResume: () => undefined,
  });
  const accounts = createAccountRuntime({
    state,
    clock,
    inbox,
    pauses,
    defaultPauseMs: 30 * 60_000,
  });
  const usageReportBook = createUsageReports({ clock, staleMs: 30 * 60_000 });
  // Built after the moves, which tell it when a project moved.
  let limits: AccountLimits | null = null;
  const moveBack = createMoveBack({
    state,
    clock,
    inbox,
    pauses,
    reports: usageReportBook,
    defaultPauseMs: 30 * 60_000,
    back: (projectId, to) => {
      moves.move(projectId, to, { cause: MoveCause.MoveBack });
    },
  });
  const moves = createAccountMoves({
    state,
    inbox,
    pauses,
    moveBack,
    handOff: (projectId, accountId, reason) => {
      runner?.handOff(projectId, accountId, reason);
    },
    onMoved: (projectId) => {
      limits?.forget(projectId);
    },
  });
  limits = createAccountLimits({ state, clock, inbox, pauses, moves, reports: usageReportBook });
  answerAccountCard = createAccountCardAnswers({
    resume: (id, about) => {
      pauses.resume(id, about);
    },
    confirm: (id, identity, answering) => {
      state.write((ctx) => patchAccount(ctx, id, { expectedIdentity: identity }));
      accounts.saved(id, answering);
    },
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: (projectId) => {
      moves.stay(projectId);
    },
    // The engine has no preparer: it never probes an account.
    recheck: () => undefined,
    raiseCap: (id, toUsd, answering) => {
      state.write((ctx) => patchAccount(ctx, id, { monthlyCapUsd: toUsd }));
      accounts.saved(id, answering);
    },
  });
  const guarded = protectedPaths({ dataDir: data.path, home: homedir(), loginConfigDir: null });
  const server = serve({
    fetch: createMcpHandler({
      protectedPaths: guarded,
      state,
      inbox,
      git,
      log: silentLogger,
      waitObserverFor: (id) => live.get(id)?.observer,
      sessionSignal: (id) => live.get(id)?.signal,
      askedToHandOff: (id) => live.get(id)?.askedToHandOff(),
      // As the daemon does: a builder message the MCP side writes goes to the page's session.
      deliverMessage: (taskId, messageId) =>
        created.deliverMessage(taskId, messageId, { redo: false }),
      ...(setup.claims
        ? { claimWaitSliceMs: setup.claims.sliceMs, claimPollMs: setup.claims.pollMs }
        : {}),
    }),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise((r) => server.once('listening', r));
  // serve() on a TCP port always reports an AddressInfo once listening.
  const mcpUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  const created = createRunner({
    laneSandbox: null,
    protectedPaths: guarded,
    state,
    adapter,
    inbox,
    git,
    jobs,
    gate: createGateRunner({ sandbox: null, logger: silentLogger }),
    // The engine's repository has no origin to fetch a base from: every branch is up to date.
    baseUpdates: {
      beforeGate: () => Promise.resolve({ kind: 'up_to_date', note: null }),
      gate: (_batchId, _signal, run) => run(),
      atLaunch: () => Promise.resolve({ kind: 'up_to_date', note: null }),
    },
    // No decision is asked of a model unless a test scripts one.
    judge: offJudge,
    clock,
    logger: silentLogger,
    // No test declares an AWS profile; one that did would have no CLI to ask.
    exportAwsCredentials: () => Promise.reject(new AwsCredentialsError('no AWS CLI in this test')),
    dataDir: data.path,
    worktreeRoot: join(data.path, 'worktrees'),
    codexLaneTempRoot: join(data.path, 'lanes'),
    // Never the developer's own home: a test's builder has no instructions, skills or plugins.
    builderHome: join(data.path, 'home'),
    laneWritableRoots: [join(data.path, 'lanes')],
    live,
    limits: { ...DEFAULT_RUNNER_LIMITS, gateTimeoutMs: 20_000 },
    mcpUrl: () => mcpUrl,
    skillBody: (name) => readSkillBody(name),
    launcher: createLauncher({ base: { PATH: '/usr/bin:/bin' }, clientApp: 'test', keychain }),
    // A usage limit is recorded but pauses nothing, so a test sees the lane's own outcome.
    accounts: {
      ...accounts,
      rateLimited: (accountId, resetsAt) => {
        rateLimited.push({ accountId, resetsAt });
      },
      sessionEnded: (account, projectId) => {
        sessionsEnded.push({ accountId: account.id, projectId });
        accounts.sessionEnded(account, projectId);
      },
      prepare: (account, projectId) => {
        prepared.push({ accountId: account.id, projectId });
      },
      usageReported: (accountId, report) => {
        usageReports.push({ accountId, report });
        limits.usageReported(accountId, report);
      },
    },
    startGate,
    onLaneFreed: () => undefined,
    ...runnerOverrides,
  });
  runner = created;
  const account = setup.account ? seedAccount(store, setup.account) : null;
  const secret = setup.secret;
  if (account && secret !== undefined) {
    keychain.write(accountSecretRef(account.id), secret);
    state.write((ctx) => recordAccountSecret(ctx, account.id, secretFingerprint(secret)));
  }
  const seeded = seedProject(store, {
    ...(account ? { accountId: account.id } : {}),
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
    bus,
    inbox,
    runner: created,
    adapter,
    clock,
    project: seeded,
    repoPath: repo.path,
    dataDir: data.path,
    accounts,
    moves,
    keychain,
    rateLimited,
    usageReports,
    startGate,
    prepared,
    sessionsEnded,
    addTask(title, areas = ['api'], dependsOn = [], plan, batchId) {
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
        : state.write((ctx) =>
            insertWorkstream(ctx, task.id, {
              first: { model: 'claude-sonnet-5-5', effort: 'medium' },
              batchId: batchId ?? null,
            }),
          );
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
    retry: (id, note) => retryWorkstream(state, id, note),
    async close() {
      moveBack.stop();
      await created.stopAll('shutdown');
      server.close();
      close();
      repo.cleanup();
      data.cleanup();
    },
  };
  return engine;
}
