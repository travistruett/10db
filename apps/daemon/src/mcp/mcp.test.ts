import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  acquireClaims,
  acquireLease,
  activeClaims,
  clearLease,
  createTestStore,
  endSession,
  getPostedNotice,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertKind,
  insertSession,
  insertTask,
  insertWorkstream,
  listInbox,
  pageActivity,
  patchWorkstream,
  releaseClaim,
  releaseClaims,
  seedProject,
  setRuleAsking,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import {
  ConflictError,
  DecisionRule,
  InboxState,
  WorkstreamState,
  type BatchId,
  type ProjectDto,
  type WorkstreamId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempRepo, isolatedGitEnv, seedWorkstream, waitFor } from '../../test/fixtures';
import { claimedChanges, handOverEdits } from '../runner';
import type { DependencyChanges, MigrationsBase } from '../delivery';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { protectedPaths } from '../guard';
import { createActivityActions, createInboxService, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { AwayLane } from '../trust';
import { buildContextPack, compactionReinjection, LaneBrief } from '../briefing';
import { readPair, takenFrom } from './claim-deadlock-pairs';
import { DEADLOCK_YIELD_AFTER_MS } from './claim-deadlock-rule';
import {
  ClaimWaits,
  createClaimDeadlockAnswers,
  createMcpHandler,
  dropPair,
  forgetEndedYields,
  mintSessionToken,
} from './index';

const GUARDED = protectedPaths({
  dataDir: join(tmpdir(), 'mcp-test-data'),
  home: homedir(),
  loginConfigDir: null,
});

let repo: { path: string; cleanup(): void };
let close: () => void;
let base: Store;
let state: StateStore;
let inbox: InboxService;
let server: ReturnType<typeof serve>;
let url: string;
const git = createGit();
/** The branch each test's workstream was pinned to at its first session, as the runner records it. */
let workstreamBranch: string | null = 'main';
/** The signal every session's waits listen to; a test aborts it to end the session. */
let sessionAbort = new AbortController();
/** One session's own stop, beside `sessionAbort`; a test aborts it to end only that session. */
const sessionStops = new Map<string, AbortController>();
/** The sessions of lanes nobody watches, with the recorder their questions are kept by. */
const awaySessions = new Map<string, AwayLane>();
/** How long one request_claim call waits before answering "still waiting"; a test shortens it. */
let claimWaitSliceMs = 60_000;
/** The handler's claim waits, which the daemon also hands the scheduler. */
let claimWaits: ClaimWaits;
/** Ends the daemon's subscription that drops a finished task's pending yield. */
let stopForgetting: () => void;
/** What an answer to a flag card does; the daemon wires the same into its inbox. */
let answerDeadlock: ReturnType<typeof createClaimDeadlockAnswers>;
/** The workstreams the builder's answers cancelled, in order. */
let cancelled: WorkstreamId[] = [];
/** What bringing the base in before the migrations hazard answers; a test replaces it. */
let takeMigrationsBase: MigrationsBase['take'];
/** The workstreams the base was brought in for, in order. */
let migrationsBaseTaken: WorkstreamId[] = [];
/** What installing a lane's dependency change answers; a test replaces it. */
let installDependencies: DependencyChanges['install'];
/** The batches a dependency change was installed for, in order. */
let dependencyInstalls: BatchId[] = [];
/** Holders the update drain has parked, as far as the claim waits are told. */
let parkedHolders = new Set<WorkstreamId>();
/** The clock a claim wait reads for a deadlock's age; a test moves it on. */
let nowMs = 0;

interface LogEntry {
  readonly obj: object;
  readonly msg: string | undefined;
}
const logged: LogEntry[] = [];
const capturingLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (obj, msg) => {
    logged.push({ obj, msg });
  },
  child: () => capturingLogger,
};

const ToolContent = z.array(z.object({ type: z.string(), text: z.string() }));
const JsonObject = z.record(z.string(), z.unknown());

beforeEach(async () => {
  logged.length = 0;
  sessionAbort = new AbortController();
  sessionStops.clear();
  claimWaitSliceMs = 60_000;
  nowMs = 0;
  workstreamBranch = 'main';
  repo = createTempRepo();
  const test = createTestStore();
  close = test.close;
  base = test.store;
  const bus = createEventBus();
  state = createStateStore(test.store, bus);
  // The kinds a proposal names are the builder's: the ones seeded for the words risk tags used to be.
  state.write((ctx) => {
    for (const key of ['security', 'auth', 'migration', 'dependency'])
      insertKind(ctx, { key, label: key, toInbox: true });
  });
  cancelled = [];
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onFlagAnswer: (item, answer) => {
      answerDeadlock(item, answer);
    },
  });
  answerDeadlock = createClaimDeadlockAnswers({
    state,
    // The runner's cancel ends the task and frees what it holds.
    cancel: (id) => {
      cancelled.push(id);
      state.write((ctx) => releaseClaims(ctx, id));
      return Promise.resolve();
    },
    get waits() {
      return claimWaits;
    },
    log: capturingLogger,
  });
  migrationsBaseTaken = [];
  takeMigrationsBase = () => Promise.resolve({ kind: 'ready' });
  dependencyInstalls = [];
  installDependencies = () => Promise.resolve({ kind: 'installed', changed: [], logPath: 'x.log' });
  parkedHolders = new Set();
  claimWaits = new ClaimWaits({
    onWait: () => undefined,
    parked: (id) => parkedHolders.has(id),
  });
  stopForgetting = forgetEndedYields(bus, claimWaits);
  const handler = createMcpHandler({
    protectedPaths: GUARDED,
    state,
    inbox,
    git,
    log: capturingLogger,
    waitObserverFor: () => undefined,
    askedToHandOff: () => undefined,
    awayFor: (id) => awaySessions.get(id),
    sessionSignal: (id) => {
      const own = sessionStops.get(id);
      return own ? AbortSignal.any([sessionAbort.signal, own.signal]) : sessionAbort.signal;
    },
    claimWaits,
    handOverClaim: (handover) => handOverEdits({ state, git }, handover),
    claimPollMs: 5,
    now: () => nowMs,
    get claimWaitSliceMs() {
      return claimWaitSliceMs;
    },
    migrationsBase: {
      take: (id, signal) => {
        migrationsBaseTaken.push(id);
        return takeMigrationsBase(id, signal);
      },
    },
    dependencyChanges: {
      install: (batchId, signal) => {
        dependencyInstalls.push(batchId);
        return installDependencies(batchId, signal);
      },
    },
  });
  server = serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  // `serve` returns a generic server; a bound TCP server's address is an AddressInfo.
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});
afterEach(() => {
  stopForgetting();
  server.close();
  close();
  repo.cleanup();
});

/** A workstream in a batch whose worktree is `worktree`, on the branch git made it with. */
function seedWorktreeWorkstream(
  worktree: string,
  branch: string,
  areas: string[],
  existing?: ProjectDto,
) {
  const project = existing ?? seedProject(base, { repoPath: repo.path });
  const batch = state.write((ctx) => {
    const inserted = insertBatch(ctx, {
      projectId: project.id,
      title: 'Greetings',
      baseBranch: 'main',
      worktreePath: worktree,
    });
    return transitionBatch(ctx, inserted.id, { to: 'OPEN', patch: { branch, baseSha: 'x' } });
  });
  const task = state.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Alpha', acceptanceCriteria: ['it works'], areas }),
  );
  const workstream = state.write((ctx) =>
    insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      batchId: batch.id,
    }),
  );
  return { project, task, workstream, areaScope: batch.id };
}

async function seedSession(
  areas = ['api'],
  worktree?: { path: string; branch: string; project?: ProjectDto },
  shared?: { project: ProjectDto; title: string },
) {
  const seeded = worktree
    ? seedWorktreeWorkstream(worktree.path, worktree.branch, areas, worktree.project)
    : {
        ...seedWorkstream(base, shared ? { ...shared, areas } : { repoPath: repo.path, areas }),
        areaScope: undefined,
      };
  const head = execFileSync('git', ['-C', worktree?.path ?? repo.path, 'rev-parse', 'HEAD'], {
    env: isolatedGitEnv(),
  })
    .toString()
    .trim();
  state.write((ctx) => {
    acquireClaims(ctx, {
      projectId: seeded.project.id,
      workstreamId: seeded.workstream.id,
      requests: areas.map((name) => ({ kind: 'area' as const, name })),
      leaseExpiresAt: ctx.now,
      ...(seeded.areaScope ? { areaScope: seeded.areaScope } : {}),
    });
    patchWorkstream(ctx, seeded.workstream.id, null, {
      baseHead: head,
      ...(workstreamBranch === null || worktree ? {} : { branch: workstreamBranch }),
    });
  });
  return { ...seeded, ...(await connectSession(seeded.workstream.id)) };
}

/** Opens a new session, with its own token and client, on a workstream that already exists. */
async function connectSession(workstreamId: WorkstreamId) {
  const { token, hash } = mintSessionToken();
  const session = state.write((ctx) =>
    insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: hash,
    }),
  );
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const stop = new AbortController();
  sessionStops.set(session.id, stop);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = ToolContent.parse(result.content)
      .map((c) => c.text)
      .join('');
    return {
      isError: result.isError === true,
      text,
      json: result.isError === true ? null : JsonObject.parse(JSON.parse(text)),
    };
  };
  /** Ends this session only, as a lane stop or handoff does. */
  const stopSession = (): void => {
    stop.abort();
  };
  return { session, token, client, call, stopSession };
}

describe('MCP auth', () => {
  it('rejects a missing token and an ended session', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const s = await seedSession();
    state.write((ctx) => {
      endSession(ctx, s.session.id, 'test');
    });
    const after = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
  });
});

describe('edits left behind in a shared checkout', () => {
  it('does not charge the task a yield hands a claim to with the yielder’s uncommitted edits', async () => {
    const yielder = await seedSession(['api']);
    const taker = await seedSession(['ui'], undefined, {
      project: yielder.project,
      title: 'Beta',
    });
    mkdirSync(join(repo.path, 'src/api'), { recursive: true });
    writeFileSync(join(repo.path, 'src/api/half.ts'), 'half done\n');
    state.write((ctx) => {
      setRuleAsking(ctx, yielder.project.id, DecisionRule.ClaimDeadlock, true);
    });
    const yielderAsks = yielder.call('request_claim', {
      opId: 'yielder-ui',
      kind: 'area',
      name: 'ui',
      reason: 'needs ui',
    });
    await waitFor(() => claimWaits.holdersAwaitedBy(yielder.workstream.id).length > 0);
    const takerAsks = taker.call('request_claim', {
      opId: 'taker-api',
      kind: 'area',
      name: 'api',
      reason: 'needs api',
    });
    const card = await waitFor(() =>
      listInbox(state.db, { states: [InboxState.Open] }).find((i) =>
        i.title.startsWith('Claim deadlock:'),
      ),
    );
    const yieldOption = card.options.find(
      (o) => o.label.endsWith(' Waits') && o.description.includes(yielder.workstream.id),
    );
    expect(yieldOption?.description).toContain('remain its own');
    inbox.answer(card.id, { choice: yieldOption?.label ?? '' });
    expect((await yielderAsks).json).toMatchObject({ granted: false });
    const granted = (await takerAsks).json;
    expect(granted).toMatchObject({ granted: true });
    expect(String(granted?.['instruction'])).toContain('src/api/half.ts');
    const takerRow = getWorkstreamRow(state.db, taker.workstream.id);
    expect(await claimedChanges(state.db, git, takerRow)).toEqual([]);
    writeFileSync(join(repo.path, 'src/api/half.ts'), 'finished by the taker\n');
    expect(await claimedChanges(state.db, git, takerRow)).toEqual(['src/api/half.ts']);
  });

  it('the later asker yields after 2 minutes, keeping its uncommitted edits', async () => {
    const project = seedProject(base, {
      repoPath: repo.path,
      areas: ['api', 'ui', 'docs', 'web'].map((name) => ({ name, globs: [`src/${name}/**`] })),
    });
    const alpha = await seedSession(['api', 'docs', 'web'], undefined, { project, title: 'Alpha' });
    const beta = await seedSession(['ui'], undefined, { project: alpha.project, title: 'Beta' });
    // Alpha's lane is running: a claim is never taken from a task that holds a lease.
    const alphaFence = state.write((ctx) => {
      const fence = acquireLease(ctx, alpha.workstream.id, 'test', ctx.now);
      transitionWorkstream(ctx, alpha.workstream.id, { to: WorkstreamState.Starting, fence });
      transitionWorkstream(ctx, alpha.workstream.id, { to: WorkstreamState.Running, fence });
      return fence;
    });
    mkdirSync(join(repo.path, 'src/api'), { recursive: true });
    writeFileSync(join(repo.path, 'src/api/half.ts'), 'half done\n');
    const betaAsks = beta.call('request_claim', {
      opId: 'beta-api',
      kind: 'area',
      name: 'api',
      reason: 'needs api',
    });
    await waitFor(() => claimWaits.holdersAwaitedBy(beta.workstream.id).length > 0);
    const alphaAsks = alpha.call('request_claim', {
      opId: 'alpha-ui',
      kind: 'area',
      name: 'ui',
      reason: 'needs ui',
    });
    await waitFor(() =>
      getWorkstreamRow(state.db, alpha.workstream.id).notice?.line.includes(
        'waits for a claim this one holds',
      ),
    );
    const deadlockCards = () =>
      listInbox(state.db, { states: [InboxState.Open] }).filter((i) =>
        i.title.startsWith('Claim deadlock:'),
      );
    expect(deadlockCards()).toEqual([]);
    expect(activeClaims(state.db, alpha.workstream.id).map((c) => c.name)).toContain('api');

    nowMs = DEADLOCK_YIELD_AFTER_MS;
    const refused = (await alphaAsks).json;
    expect(refused).toMatchObject({ granted: false });
    expect(String(refused?.['instruction'])).toContain('each waited for a claim the other holds');
    expect(String(refused?.['instruction'])).toContain('"Beta"');
    const granted = (await betaAsks).json;
    expect(granted).toMatchObject({ granted: true });
    expect(String(granted?.['instruction'])).toContain('src/api/half.ts');
    const betaRow = getWorkstreamRow(state.db, beta.workstream.id);
    expect(await claimedChanges(state.db, git, betaRow)).toEqual([]);
    expect(deadlockCards()).toEqual([]);
    const rows = pageActivity(state.db, { project: alpha.project.id, pageSize: 50 }).rows.filter(
      (r) => r.key.startsWith('claim-deadlock:'),
    );
    expect(rows).toHaveLength(1);
    const seq = rows[0]?.seq ?? 0;
    expect(getPostedNotice(state.db, seq)?.data.decision?.undo.state).toBe('undoable');
    expect(readPair(state.db, alpha.workstream.id, beta.workstream.id)?.breaks).toBe(1);

    // A second deadlock between the two also queues the later asker behind the other.
    const betaDocs = beta.call('request_claim', {
      opId: 'beta-docs',
      kind: 'area',
      name: 'docs',
      reason: 'needs docs',
    });
    await waitFor(() => claimWaits.holdersAwaitedBy(beta.workstream.id).length > 0);
    const alphaAgain = alpha.call('request_claim', {
      opId: 'alpha-api',
      kind: 'area',
      name: 'api',
      reason: 'needs api again',
    });
    await waitFor(() =>
      getWorkstreamRow(state.db, alpha.workstream.id).notice?.line.includes(
        'waits for a claim this one holds',
      ),
    );
    nowMs += DEADLOCK_YIELD_AFTER_MS;
    const queued = String((await alphaAgain).json?.['instruction']);
    expect(queued).toContain('You gave up area docs to task "Beta" and are queued behind it.');
    expect(readPair(state.db, alpha.workstream.id, beta.workstream.id)?.queued).toEqual({
      yielder: alpha.workstream.id,
      behind: beta.workstream.id,
    });
    expect((await betaDocs).json).toMatchObject({ granted: true });
    // A queued task's ask is answered at once, without a wait.
    const asksQueued = await alpha.call('request_claim', {
      opId: 'alpha-ui-queued',
      kind: 'area',
      name: 'ui',
      reason: 'needs ui',
    });
    expect(String(asksQueued.json?.['instruction'])).toContain('are queued behind it');

    // The other task's ask for a claim the queued task holds waits while that task holds a lease,
    // and takes it once the task is queued with none.
    const betaWeb = beta.call('request_claim', {
      opId: 'beta-web',
      kind: 'area',
      name: 'web',
      reason: 'needs web',
    });
    await waitFor(() => claimWaits.holdersAwaitedBy(beta.workstream.id).length > 0);
    expect(activeClaims(state.db, alpha.workstream.id).map((c) => c.name)).toContain('web');
    state.write((ctx) => {
      transitionWorkstream(ctx, alpha.workstream.id, {
        to: WorkstreamState.PausedLimit,
        fence: alphaFence,
      });
      transitionWorkstream(ctx, alpha.workstream.id, {
        to: WorkstreamState.Queued,
        fence: alphaFence,
      });
      clearLease(ctx, alpha.workstream.id);
    });
    expect((await betaWeb).json).toMatchObject({ granted: true });
    const tookLine = 'While you were queued, task "Beta" took area web.';
    const briefOfAlpha = (): string =>
      compactionReinjection(
        buildContextPack(state.db, getWorkstream(state.db, alpha.workstream.id)),
        [],
        undefined,
        LaneBrief.Full,
        takenFrom(state.db, alpha.workstream.id).map((record) => ({
          title: getTask(state.db, getWorkstream(state.db, record.to).taskId).title,
          claims: record.claims,
        })),
      );
    expect(takenFrom(state.db, alpha.workstream.id)).toEqual([
      {
        from: alpha.workstream.id,
        to: beta.workstream.id,
        claims: [{ kind: 'area', name: 'web' }],
      },
    ]);
    expect(briefOfAlpha()).toContain(tookLine);

    const actions = createActivityActions({
      state,
      moves: {
        moveProject: () => undefined,
        forgetClaimDeadlock: (a, b) => {
          const found = state.write((ctx) => dropPair(ctx, a, b));
          if (!found) throw new ConflictError('This claim deadlock has no record any more');
        },
      },
    });
    // Undo on the queue's row ends the queue and keeps the record of the claim taken.
    const queueSeq = Math.max(
      ...pageActivity(state.db, { project: alpha.project.id, pageSize: 50 })
        .rows.filter((r) => r.key.startsWith('claim-deadlock:'))
        .map((r) => r.seq),
    );
    expect(queueSeq).toBeGreaterThan(seq);
    actions.undo(queueSeq);
    expect(readPair(state.db, alpha.workstream.id, beta.workstream.id)).toBeNull();
    expect(takenFrom(state.db, alpha.workstream.id)).toHaveLength(1);
    expect(briefOfAlpha()).toContain(tookLine);

    // Granted the claim again, the queued task is told of the take no more.
    state.write((ctx) => {
      const web = activeClaims(ctx.tx, beta.workstream.id).find((c) => c.name === 'web');
      if (web) releaseClaim(ctx, web.id);
      acquireClaims(ctx, {
        projectId: alpha.project.id,
        workstreamId: alpha.workstream.id,
        requests: [{ kind: 'area', name: 'web' }],
        leaseExpiresAt: ctx.now,
      });
    });
    expect(takenFrom(state.db, alpha.workstream.id)).toEqual([]);
    expect(briefOfAlpha()).not.toContain('While you were queued');
    expect(() => {
      actions.undo(queueSeq);
    }).toThrow(ConflictError);
  });

  it('leaves named paths in a copy another task shares, and says why it leaves none alone', async () => {
    const copy = createTempRepo();
    try {
      const s = await seedSession(['api'], { path: copy.path, branch: 'copy' });
      const alone = await s.call('report_deviation', {
        opId: 'leave-alone',
        cause: 'not mine',
        severity: 'info',
        reason: 'someone else wrote it',
        leaveUncommitted: ['src/api/x.ts'],
      });
      expect(alone.json).toMatchObject({ leftUncommitted: [] });
      expect(String(alone.json?.['instruction'])).toContain('this task');
      const batchId = getWorkstreamRow(state.db, s.workstream.id).batchId;
      state.write((ctx) => {
        const sibling = insertTask(ctx, s.project.id, {
          title: 'Sibling',
          acceptanceCriteria: ['it works'],
          areas: ['ui'],
        });
        insertWorkstream(ctx, sibling.id, {
          first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          ...(batchId ? { batchId } : {}),
        });
      });
      const shared = await s.call('report_deviation', {
        opId: 'leave-shared',
        cause: 'not mine',
        severity: 'info',
        reason: 'the sibling wrote it',
        leaveUncommitted: ['src/api/x.ts'],
      });
      expect(shared.json).toMatchObject({ leftUncommitted: ['src/api/x.ts'], instruction: null });
    } finally {
      copy.cleanup();
    }
  });
});
