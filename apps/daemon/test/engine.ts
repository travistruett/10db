import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  InboxItemId,
  mintId,
  QuestionCategory,
  Rigor,
  RoutedBy,
  StepRole,
  TaskKindSource,
} from '@10db/contracts';
import type {
  AccountId,
  BatchId,
  AccountInput,
  InboxAnswer,
  InboxItemDto,
  ProjectDto,
  ProjectId,
  ProjectInput,
  TaskDto,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  createTestStore,
  getProject,
  getInboxItem,
  getTask,
  getWorkstreamRow,
  insertPerson,
  insertTask,
  insertWorkstream,
  patchAccount,
  accountSecretRef,
  recordAccountSecret,
  seedAccount,
  seedProject,
  setRoutingRules,
  transitionWorkstream,
  type Store,
  setPlaybook,
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
import {
  createEventBus,
  createLiveFrames,
  createStateStore,
  type EventBus,
  type LiveFrames,
  type StateStore,
} from '../src/events';
import { createLiveRegistry, type LiveRegistry } from '../src/conversation';
import { applySkippedChoice, createDeliveryJobs, skipFollowUpStarter } from '../src/delivery';
import { createGit, resolveGit } from '../src/git';
import { resolveGh } from '../src/github';
import { startSignOff } from '../src/pass';
import { createJudge, type Judge } from '../src/judge';
import type { AnswerWriter } from '../src/stakeholders';
import {
  createReplyWatches,
  createSlackConnections,
  createStakeholderSends,
  createTimerWatch,
  boundTeam,
  createTriage,
  draftOnOpen,
  projectSlack,
  routedAway,
  saveSlackWorkspace,
  setProjectSlack,
  type ReplyWatches,
  type SlackClients,
  type StakeholderSends,
  type TimerWatch,
} from '../src/stakeholders';
import type { SlackClient } from '../src/slack';
import {
  createInboxService,
  createParkAnswers,
  leftWithBuilder,
  type InboxService,
} from '../src/inbox';
import { silentLogger } from '../src/log';
import { protectedPaths } from '../src/guard';
import { createMcpHandler } from '../src/mcp';
import {
  applyCheckAnswer,
  applyPlanAnswer,
  RunnerNotStartedError,
  createLiveSessions,
  type LiveSessions,
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

/**
 * A triage judge that answers nothing until its timeout on the engine's clock, which then routes by
 * the rules. A lane nobody watches waits live only on a card triage has yet to route, so a row about
 * a live wait or a live answer asks one of those.
 */
export function triageHeld(): { readonly openRouter: { readonly fetch: typeof fetch } } {
  return {
    openRouter: {
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('triage was stopped'));
          });
        }),
    },
  };
}

/**
 * Routes every category of the project's questions to a stakeholder with Slack. A lane nobody watches
 * answers a question left with the builder at once; one routed to a person who has Slack still waits on
 * them, parked, so a row about parking and answers asks one of those.
 */
export function routeQuestionsAway(engine: Pick<TestEngine, 'state' | 'project'>): void {
  engine.state.write((ctx) => {
    const person = insertPerson(ctx, {
      handle: 'stakeholder',
      name: 'Stakeholder',
      slack: [{ teamId: 'T1', userId: 'U9', sendMode: 'review', dailyLimit: 10 }],
    });
    setRoutingRules(ctx, engine.project.id, {
      rules: Object.values(QuestionCategory).map((category) => ({
        category,
        area: null,
        personId: person.id,
      })),
    });
  });
}

export interface TestEngine {
  readonly store: Store;
  readonly state: StateStore;
  /** Every event the engine's writes push, as the daemon's listeners get them. */
  readonly bus: EventBus;
  readonly inbox: InboxService;
  /** The running sessions' wait observers and signals, as the MCP side reads them. */
  readonly live: LiveSessions;
  /** The live frames a task conversation's session sends, as the event socket gets them. */
  readonly frames: LiveFrames;
  /** What each task conversation streams now, as `GET /conversations/:id/live` reads it. */
  readonly laneLive: LiveRegistry;
  /** The stakeholder sends, over the fake Slack the engine was given (none: every draft stays). */
  readonly sends: StakeholderSends;
  readonly replyWatches: ReplyWatches;
  readonly timerWatch: TimerWatch;
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
    /** `riskTags` shape the steps a scripted `full` flow runs; `kinds` are the keys the task is filed with. */
    plan?: {
      flow: string;
      riskTags?: string[];
      kinds?: string[];
      criteria?: number;
      /** A scripted `full` flow runs without the builder's plan approval unless it asks for it. */
      approvesPlan?: boolean;
    },
    batchId?: BatchId,
  ): { task: TaskDto; workstream: WorkstreamDto };
  /** Does what the scheduler does: claims, lease, STARTING, then launch. */
  launch(id: WorkstreamId): void;
  /** Retries a failed workstream the way the API does. */
  retry(id: WorkstreamId, note?: string): WorkstreamDto;
  close(): Promise<void>;
}

/** The rigor a test's old flow name stands for. */
function rigorOfFlow(flow: string): Rigor {
  switch (flow) {
    case 'quick':
      return Rigor.Light;
    case 'standard':
      return Rigor.Standard;
    case 'careful':
      return Rigor.Careful;
    case 'full':
      return Rigor.Critical;
    default:
      throw new Error(`no rigor stands for the flow ${flow}`);
  }
}

/** What the old full flow ran: a plan and QA for more than three criteria, a plan review for risky ones. */
function fullFlowSteps(riskTags: readonly string[], criteria: number): StepRole[] {
  const long = criteria > 3;
  return [
    ...(long ? [StepRole.Plan] : []),
    ...(long && riskTags.some((t) => ['security', 'auth', 'migration'].includes(t))
      ? [StepRole.PlanReview]
      : []),
    StepRole.Implement,
    StepRole.Review,
    ...(long ? [StepRole.Qa] : []),
  ];
}

/** The workspace the engine's fake Slack stands for; people with a contact in it are reachable. */
const FAKE_TEAM = 'T1';

/** A judge that is off: every decision keeps today's rule. */
/** An answer writer that always declines: the reply watch sends every question to the builder. */
export const decliningWriter: AnswerWriter = () =>
  Promise.resolve({ kind: 'declined', reason: 'no_account' });

export const offJudge: Judge = {
  off: true,
  ready: () => Promise.resolve(false),
  choose: () =>
    Promise.resolve({
      kind: 'fallback',
      reason: 'off',
      detail: 'off',
      callId: mintId('JudgeCall'),
    }),
  assess: () =>
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
    /**
     * A fake OpenRouter: with it the engine triages questions through a real judge on this `fetch`, as
     * the daemon does. Without it the judge is off and the lane's tags decide at insert.
     */
    readonly openRouter?: { readonly fetch: typeof fetch; readonly key?: string };
    /** A fake Slack: with it routed questions are drafted and sent through it, as the daemon does. */
    readonly slack?: SlackClient;
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
  const triageJudge: Judge = setup.openRouter
    ? createJudge({
        state,
        clock,
        fetch: setup.openRouter.fetch,
        readCredential: () =>
          Promise.resolve({
            kind: 'openrouter',
            key: setup.openRouter?.key ?? 'test-key-0123456789',
          }),
        // Triage asks TypeSafe's models, which never need OpenRouter's decision list.
        decisionModelIds: () => null,
        off: false,
        logger: silentLogger,
      })
    : offJudge;
  // The fake Slack is the one workspace, T1, which the engine's project is bound to.
  const fakeClients: SlackClients | null = setup.slack
    ? { clientFor: (teamId) => (teamId === FAKE_TEAM ? (setup.slack ?? null) : null) }
    : null;
  const sends = createStakeholderSends({
    state,
    slack: fakeClients,
    clock,
    log: silentLogger,
    slackFor: (projectId) => projectSlack(state.db, projectId).teamId,
    boundTo: (projectId) => boundTeam(state.db, projectId),
    parkFor: (id) => {
      runner?.parkFor(id);
    },
  });
  const draftOpts = {
    afterDraft: (id: InboxItemId): void => {
      sends.afterDraft(id).catch(() => undefined);
    },
    log: silentLogger,
  };
  const triage = createTriage({
    state,
    judge: triageJudge,
    log: silentLogger,
    afterRouted: (id) => {
      const after = state.write((ctx) => draftOnOpen(ctx, getInboxItem(ctx.tx, id), draftOpts));
      // Read after the draft, which hands a person's card back to the builder for want of Slack. A
      // card that now goes to someone else parks its sessions; one left with the builder waits live,
      // except in a lane nobody watches, which answers at once.
      const routed = getInboxItem(state.db, id);
      if (routedAway(routed)) runner?.parkFor(id);
      else if (leftWithBuilder(routed))
        inbox.answerAwayWaits(id, (sessionId) => live.get(sessionId)?.away !== undefined);
      after?.();
    },
  });
  bus.subscribe((event) => {
    if (event.type !== 'inbox.changed') return;
    const id = InboxItemId.safeParse(event.entityId);
    if (id.success) sends.onCardChanged(getInboxItem(state.db, id.data)).catch(() => undefined);
  });
  // Run these now's follow-up starts as the Board's Start does; the engine has no batch starter.
  const startFollowUps = skipFollowUpStarter({
    state,
    log: silentLogger,
    starts: {
      join: () => {
        throw new Error('the test engine starts no batch');
      },
      base: (taskId) => {
        startTaskWithPlan(state, taskId);
      },
    },
  });
  const inbox = createInboxService({
    state,
    judgeOff: triageJudge.off,
    onFlagAnswerInWrite: (ctx, item, answer) =>
      applySkippedChoice(ctx, item, answer) ? startFollowUps : undefined,
    parkWaiting: (id) => {
      runner?.parkFor(id);
    },
    onQuestionOpened: (ctx, item) =>
      item.routedBy === RoutedBy.TriagePending
        ? () => {
            void triage.run(item.id);
          }
        : draftOnOpen(ctx, item, draftOpts),
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
            // The test engine has no pull request to push a commit to.
            committed: () => undefined,
            stopLane: (id) => ready.stopPassLane(id),
          },
          taskId,
        );
      });
    },
    onPlanAnswer: (ctx, item, answer) => {
      const ready = runner;
      if (!ready) throw new RunnerNotStartedError('plan');
      return applyPlanAnswer(ready, ctx, item, answer);
    },
    onFlagAnswer: (item, answer) => {
      runner?.retryTurn(item, answer);
      answerAccountCard?.(item, answer);
    },
  });
  const slackConnections = createSlackConnections({ state, off: !setup.slack });
  const replyWatches = createReplyWatches({
    state,
    slack: fakeClients,
    inbox,
    judge: triageJudge,
    sends,
    clock,
    log: silentLogger,
    connections: slackConnections,
    answerWriter: decliningWriter,
  });
  const timerWatch = createTimerWatch({ state, clock, log: silentLogger });
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
      awayFor: (id) => live.get(id)?.away,
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
  const frames = createLiveFrames();
  const laneLive = createLiveRegistry();
  const created = createRunner({
    judge: triageJudge,
    // The daemon's own git and gh, as `startDaemon` resolves them.
    gitTools: { git: await resolveGit(), gh: resolveGh() },
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
    clock,
    logger: silentLogger,
    // No test declares an AWS profile; one that did would have no CLI to ask.
    exportAwsCredentials: () => Promise.reject(new AwsCredentialsError('no AWS CLI in this test')),
    dataDir: data.path,
    frames,
    laneLive,
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
  // Bound with or without a fake client: a routed question is drafted for people with a contact in T1.
  state.write((ctx) => {
    saveSlackWorkspace(ctx, { teamId: FAKE_TEAM, teamName: 'Fake' });
    setProjectSlack(ctx, seeded.id, FAKE_TEAM);
  });
  const engine: TestEngine = {
    store,
    state,
    bus,
    inbox,
    live,
    frames,
    laneLive,
    sends,
    replyWatches,
    timerWatch,
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
      const rigor = plan ? rigorOfFlow(plan.flow) : null;
      // The old full flow's steps, as a project override of Critical's row, for the tests that script them.
      if (plan?.flow === 'full')
        state.write((ctx) =>
          setPlaybook(ctx, seeded.id, {
            rows: [
              {
                rigor: Rigor.Critical,
                steps: fullFlowSteps(plan.riskTags ?? [], criteria.length),
                approvesPlan: plan.approvesPlan ?? false,
              },
            ],
          }),
        );
      const task = state.write((ctx) =>
        insertTask(ctx, seeded.id, {
          title,
          acceptanceCriteria: criteria,
          areas,
          dependsOn,
          rigor,
          kinds: (plan?.kinds ?? []).map((key) => ({ key, source: TaskKindSource.Builder })),
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
