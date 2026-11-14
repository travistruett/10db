import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  acquireClaims,
  activeClaims,
  confirmPrinciple,
  createTestStore,
  endSession,
  getInboxItem,
  getTask,
  getPrinciple,
  getWorkstream,
  insertBatch,
  insertDecision,
  insertEvidence,
  insertKind,
  insertPrinciple,
  insertSession,
  insertShape,
  insertSource,
  insertTask,
  insertWorkstream,
  listBoardColumns,
  listInbox,
  listTasks,
  listToolOpResults,
  patchTask,
  patchWorkstream,
  releaseClaims,
  schema,
  searchPrinciples,
  seedProject,
  setSmallProposalLimit,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import {
  EventType,
  filedFollowUpLines,
  MAX_FOLLOW_UPS,
  MAX_STEP_SUMMARY,
  mintId,
  parseFindings,
  PrincipleId,
  type BatchId,
  type NextAction,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTempRepo, isolatedGitEnv, seedWorkstream, tempDir } from '../../test/fixtures';
import type { DependencyChanges, MigrationsBase, MigrationsBaseTake } from '../delivery';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import {
  advanceSteps,
  commitCoveredByRevert,
  commitAfterResolution,
  commitGotThroughGate,
  commitResolvedMarkers,
  revertCommitLine,
} from '../team';
import { protectedPaths } from '../guard';
import { createInboxService, type InboxService } from '../inbox';
import type { Logger } from '../log';
import {
  ClaimWaits,
  createClaimDeadlockAnswers,
  createMcpHandler,
  forgetEndedYields,
  mintSessionToken,
  withdrawStaleClaimWaits,
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
/** How many times a wait started and asked the scheduler to look again. */
let waitsStarted = 0;
/** Holders the update drain has parked, as far as the claim waits are told. */
let parkedHolders = new Set<WorkstreamId>();

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
  waitsStarted = 0;
  migrationsBaseTaken = [];
  takeMigrationsBase = () => Promise.resolve({ kind: 'ready' });
  dependencyInstalls = [];
  installDependencies = () => Promise.resolve({ kind: 'installed', changed: [], logPath: 'x.log' });
  parkedHolders = new Set();
  claimWaits = new ClaimWaits({
    onWait: () => {
      waitsStarted += 1;
    },
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
    sessionSignal: (id) => {
      const own = sessionStops.get(id);
      return own ? AbortSignal.any([sessionAbort.signal, own.signal]) : sessionAbort.signal;
    },
    claimWaits,
    claimPollMs: 5,
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

const writeRepoFile = (rel: string, text: string) => {
  mkdirSync(join(repo.path, rel, '..'), { recursive: true });
  writeFileSync(join(repo.path, rel), text);
};
const commitCount = () =>
  Number(
    execFileSync('git', ['-C', repo.path, 'rev-list', '--count', 'HEAD'], {
      env: isolatedGitEnv(),
    })
      .toString()
      .trim(),
  );

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

  it("refuses a Shape session's token: it has no lane, so no lane tools", async () => {
    const project = seedProject(base, { repoPath: repo.path });
    const shape = state.write((ctx) =>
      insertShape(ctx, project.id, { title: 'Density', origin: 'app' }),
    );
    const { token, hash } = mintSessionToken();
    state.write((ctx) =>
      insertSession(ctx, {
        shapeId: shape.id,
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        mode: 'managed',
        mcpTokenHash: hash,
      }),
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('MCP tools in a worktree batch', () => {
  let outside: { path: string; cleanup(): void };
  let worktree: string;
  beforeEach(() => {
    outside = tempDir('mcp-worktree');
    worktree = join(outside.path, 'wt');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', 'batch/one', worktree], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    worktree = realpathSync(worktree);
  });
  afterEach(() => {
    outside.cleanup();
  });
  const worktreeCount = () =>
    Number(
      execFileSync('git', ['-C', worktree, 'rev-list', '--count', 'HEAD'], {
        env: isolatedGitEnv(),
      })
        .toString()
        .trim(),
    );

  it('commit commits on its branch in the worktree and leaves the main checkout alone', async () => {
    const s = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    const mainState = () => ({
      head: execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { env: isolatedGitEnv() })
        .toString()
        .trim(),
      status: execFileSync('git', ['-C', repo.path, 'status', '--porcelain'], {
        env: isolatedGitEnv(),
      }).toString(),
    });
    const before = mainState();
    mkdirSync(join(worktree, 'src/api'), { recursive: true });
    writeFileSync(join(worktree, 'src/api/a.ts'), 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-wt-commit-1',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    expect(result.isError).toBe(false);
    expect(worktreeCount()).toBe(2);
    expect(commitCount()).toBe(1);
    expect(mainState()).toEqual(before);
    const branches = execFileSync('git', ['-C', repo.path, 'branch', '--list', 'batch/one'], {
      env: isolatedGitEnv(),
    }).toString();
    expect(branches).toContain('batch/one');
  });

  it('write_handoff reads changes from the worktree', async () => {
    const s = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    mkdirSync(join(worktree, 'src/api'), { recursive: true });
    writeFileSync(join(worktree, 'src/api/c.ts'), 'export {}\n');
    await s.call('commit', { opId: 'op-wt-commit-2', paths: ['src/api/c.ts'], message: 'Add c' });
    const handoff = {
      objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
      progress: { done: ['c'], notDone: ['d'], nextAction: 'Write d' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    await s.call('write_handoff', { opId: 'op-wt-handoff-1', ...handoff });
    const ctx = await s.call('get_context', {});
    expect(ctx.json).toMatchObject({ handoff: { gitChangedFiles: ['src/api/c.ts'] } });
  });

  const claimRows: { name: string; claim: string; secondGranted: boolean }[] = [
    { name: 'an area is exclusive only within its batch', claim: 'ui', secondGranted: true },
    { name: 'AGENTS.md is held per copy', claim: 'harness', secondGranted: true },
    { name: 'the lockfile is held per copy', claim: 'deps', secondGranted: true },
    {
      name: 'migrations stay exclusive across batches, so the second waits',
      claim: 'migrations',
      secondGranted: false,
    },
  ];

  it.each(claimRows)('request_claim: $name', async ({ claim, secondGranted }) => {
    const other = join(outside.path, 'wt2');
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', '-q', '-b', 'batch/two', other], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const a = await seedSession(['api'], { path: worktree, branch: 'batch/one' });
    const b = await seedSession(['api'], {
      path: realpathSync(other),
      branch: 'batch/two',
      project: a.project,
    });
    const first = await a.call('request_claim', {
      opId: 'op-wt-claim-a',
      kind: 'area',
      name: claim,
      reason: 'shared badge',
    });
    expect(first.json).toMatchObject({ granted: true });
    const second = b.call('request_claim', {
      opId: 'op-wt-claim-b',
      kind: 'area',
      name: claim,
      reason: 'shared badge',
    });
    if (secondGranted) {
      expect((await second).json).toMatchObject({ granted: true });
      expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
      return;
    }
    await vi.waitFor(() => {
      expect(getWorkstream(state.db, b.workstream.id).notice?.line).toContain(
        `Waiting for hazard ${claim}`,
      );
    });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
    state.write((ctx) => releaseClaims(ctx, a.workstream.id));
    expect((await second).json).toMatchObject({ granted: true });
  });
});

describe('MCP tools', () => {
  it('lists exactly the eighteen tools', async () => {
    const s = await seedSession();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_human',
      'commit',
      'complete_step',
      'file_follow_up',
      'find_knowledge',
      'find_plan_entries',
      'get_context',
      'get_plan_entry',
      'get_plan_section',
      'install_dependencies',
      'propose',
      'record_decision',
      'record_evidence',
      'report_deviation',
      'report_pages',
      'request_claim',
      'resize_task',
      'write_handoff',
    ]);
  });

  describe('propose', () => {
    const openCards = () => listInbox(state.db, { states: ['OPEN'] });
    const small = { kind: 'new_task', title: 'Reword the criterion', body: 'It is unclear.' };

    it('files a small proposal with no kind that asks for a card to the Icebox, with no card, naming the lane’s task', async () => {
      const s = await seedSession();
      const { json } = await s.call('propose', { opId: 'op-prop-0001', ...small });
      const filed = listTasks(state.db, s.project.id).find((t) => t.title === small.title);
      const icebox = listBoardColumns(state.db, s.project.id).find((c) => c.name === 'Icebox');
      expect(filed).toBeDefined();
      expect(filed?.boardColumnId).toBe(icebox?.id);
      expect(json).toMatchObject({ taskId: filed?.id });
      expect(filed?.description).toContain('Filed by 10db');
      expect(filed?.description).toContain(s.task.title);
      expect(filed?.description).toContain(s.task.id);
      expect(filed?.description).toContain('It is unclear.');
      expect(openCards()).toEqual([]);
      const proposal = state.db.select().from(schema.proposals).all()[0];
      expect(proposal).toMatchObject({ status: 'accepted' });
    });

    it.each([
      ['a kind that asks for a card', { kinds: ['dependency'] }],
      ['a risk named in its text', { title: 'Bump the zod dependency' }],
      ['joining a running batch', { joinsRunningBatch: true }],
      ['a size over the limit', { body: 'x'.repeat(1300) }],
      ['a change to a task', { kind: 'change_task' }],
    ])('still raises a card for a proposal with %s', async (_name, over) => {
      const s = await seedSession();
      const { json } = await s.call('propose', { opId: 'op-prop-0002', ...small, ...over });
      expect(openCards()).toHaveLength(1);
      expect(openCards()[0]).toMatchObject({ kind: 'proposal' });
      expect(json).toMatchObject({ taskId: null });
      expect(listTasks(state.db, s.project.id).filter((t) => t.title === small.title)).toEqual([]);
      expect(state.db.select().from(schema.proposals).all()[0]).toMatchObject({
        status: 'pending',
      });
    });

    it.each([
      ['a kind', { kinds: ['dependency'] }, 'it carries the dependency kind'],
      [
        'a risk named in its text',
        { title: 'Bump the zod dependency' },
        'it names the dependency risk',
      ],
      ['joining a running batch', { joinsRunningBatch: true }, 'it asks to join a running batch'],
      ['a size over the limit', { body: 'x'.repeat(1300) }, 'it is over the limit'],
      ['a change to a task', { kind: 'change_task' }, 'it is not a new task'],
    ])('says on the card why a proposal with %s was raised', async (_name, over, reason) => {
      const s = await seedSession();
      await s.call('propose', { opId: 'op-prop-0005', ...small, ...over });
      expect(openCards()[0]?.body).toContain(`Raised as a card because ${reason}`);
    });

    it.each([
      ['kinds', { kinds: ['security', 'auth'] }],
      ['kinds named twice, once each', { kinds: ['security', 'auth', 'security'] }],
      ['risk tags, the name an older lane still calls them', { riskTags: ['security', 'auth'] }],
    ])(
      'keeps the declared %s on the card, and the task filed from it has them',
      async (_n, over) => {
        const s = await seedSession();
        await s.call('propose', { opId: 'op-prop-0006', ...small, ...over });
        const card = openCards()[0];
        if (!card) throw new Error('no card opened');
        expect(card.body).toContain(small.body);
        expect(card.detail).toMatchObject({ kinds: ['security', 'auth'] });
        inbox.answer(card.id, { choice: 'accept' });
        expect(
          listTasks(state.db, s.project.id).find((t) => t.title === small.title),
        ).toMatchObject({
          kinds: [
            { key: 'security', source: 'agent' },
            { key: 'auth', source: 'agent' },
          ],
        });
      },
    );

    it('ignores a declared key no kind has, and files a small proposal of kinds that ask for no card', async () => {
      const s = await seedSession();
      state.write((ctx) => {
        insertKind(ctx, { key: 'ui', label: 'UI' });
      });
      await s.call('propose', { opId: 'op-prop-0009', ...small, kinds: ['ui', 'nonsense'] });
      expect(openCards()).toEqual([]);
      expect(listTasks(state.db, s.project.id).find((t) => t.title === small.title)).toMatchObject({
        kinds: [{ key: 'ui', source: 'agent' }],
      });
    });

    it('states each risk once on the card of a tagged proposal when the limit is zero', async () => {
      const s = await seedSession();
      state.write((ctx) => {
        setSmallProposalLimit(ctx, s.project.id, 0);
      });
      await s.call('propose', {
        opId: 'op-prop-0007',
        ...small,
        title: 'Tighten the security and auth checks',
        kinds: ['security'],
      });
      expect(openCards()).toHaveLength(1);
      expect(openCards()[0]?.body).toMatch(
        /\n\nRaised as a card because it carries the security kind, and filing small proposals by itself is off for this project, and it names the auth risk\.$/,
      );
    });

    it('states each risk once on the card of a tagged change_task proposal', async () => {
      const s = await seedSession();
      await s.call('propose', {
        opId: 'op-prop-0008',
        ...small,
        kind: 'change_task',
        title: 'Tighten the security and auth checks',
        kinds: ['security'],
      });
      expect(openCards()).toHaveLength(1);
      expect(openCards()[0]?.body).toMatch(
        /\n\nRaised as a card because it carries the security kind, and it is not a new task, and it names the auth risk\.$/,
      );
    });

    it('sends every proposal to the Inbox when the project’s limit is zero', async () => {
      const s = await seedSession();
      state.write((ctx) => {
        setSmallProposalLimit(ctx, s.project.id, 0);
      });
      await s.call('propose', { opId: 'op-prop-0003', ...small });
      expect(openCards()).toHaveLength(1);
    });

    it('files a bigger proposal by itself once the limit is raised', async () => {
      const s = await seedSession();
      state.write((ctx) => {
        setSmallProposalLimit(ctx, s.project.id, 5000);
      });
      await s.call('propose', { opId: 'op-prop-0004', ...small, body: 'x'.repeat(1300) });
      expect(openCards()).toEqual([]);
      expect(listTasks(state.db, s.project.id).some((t) => t.title === small.title)).toBe(true);
    });

    const proposeSmall = (s: Pick<Awaited<ReturnType<typeof onStep>>, 'call'>, i: number) =>
      s.call('propose', {
        opId: `op-prop-cap-${String(i).padStart(2, '0')}`,
        ...small,
        title: `${small.title} ${String(i)}`,
      });

    it('raises a card instead of filing once a step has filed the cap by itself, and a replayed opId still answers', async () => {
      const s = await onStep('implement');
      for (let i = 0; i < MAX_FOLLOW_UPS; i += 1) {
        const ok = await proposeSmall(s, i);
        expect(typeof ok.json?.['taskId']).toBe('string');
      }
      expect(openCards()).toEqual([]);
      const over = await proposeSmall(s, MAX_FOLLOW_UPS);
      expect(over.isError).toBe(false);
      expect(over.json).toMatchObject({ taskId: null });
      expect(openCards()).toHaveLength(1);
      expect(openCards()[0]?.body).toContain('Raised as a card because');
      expect(openCards()[0]?.body).toContain('this step has already filed');
      expect(listTasks(state.db, s.project.id).filter((t) => t.id !== s.task.id)).toHaveLength(
        MAX_FOLLOW_UPS,
      );
      const replay = await proposeSmall(s, 0);
      expect(typeof replay.json?.['taskId']).toBe('string');
      // Accepting the card is still a person's call, and files the task.
      const card = openCards()[0];
      if (!card) throw new Error('no card opened');
      inbox.answer(card.id, { choice: 'accept' });
      expect(
        listTasks(state.db, s.project.id).some((t) =>
          t.title.endsWith(` ${String(MAX_FOLLOW_UPS)}`),
        ),
      ).toBe(true);
    });

    it('shares the cap with file_follow_up, in both directions', async () => {
      const filed = await onStep('implement');
      for (let i = 0; i < MAX_FOLLOW_UPS - 1; i += 1) await proposeSmall(filed, i);
      const follow = await filed.call('file_follow_up', {
        opId: 'op-prop-share-fu',
        title: 'Left over',
        description: 'Not done.',
        acceptanceCriteria: ['Done'],
      });
      expect(follow.isError).toBe(false);
      const over = await proposeSmall(filed, 99);
      expect(over.json).toMatchObject({ taskId: null });
      expect(openCards()).toHaveLength(1);
      const refused = await filed.call('file_follow_up', {
        opId: 'op-prop-share-fu2',
        title: 'Left over too',
        description: 'Not done.',
        acceptanceCriteria: ['Done'],
      });
      expect(refused.isError).toBe(true);
    });

    it('counts the cap across the sessions of a step, and a later step starts again', async () => {
      const s = await onStep('implement');
      for (let i = 0; i < MAX_FOLLOW_UPS; i += 1) await proposeSmall(s, i);
      await proposeSmall(s, 50);
      const next = await connectSession(s.workstream.id);
      expect((await proposeSmall(next, 51)).json).toMatchObject({ taskId: null });
      state.write((ctx) => {
        patchWorkstream(ctx, s.workstream.id, null, {
          steps: [
            { ...stepAt('implement'), status: 'done' },
            { ...stepAt('review'), sessionFloor: 2 },
          ],
          stepIndex: 1,
        });
      });
      const third = await connectSession(s.workstream.id);
      expect(typeof (await proposeSmall(third, 52)).json?.['taskId']).toBe('string');
    });
  });

  describe('install_dependencies', () => {
    it('installs for the task’s batch and tells the lane what to commit', async () => {
      const s = await seedSession(['api'], { path: repo.path, branch: 'batch/one' });
      installDependencies = () =>
        Promise.resolve({
          kind: 'installed',
          changed: ['package.json', 'pnpm-lock.yaml'],
          logPath: 'install.log',
        });
      const { json } = await s.call('install_dependencies', { opId: 'op-deps-0001' });
      expect(json).toMatchObject({
        installed: true,
        changed: ['package.json', 'pnpm-lock.yaml'],
        logPath: 'install.log',
      });
      expect(JSON.stringify(json)).toContain('commit');
      expect(dependencyInstalls).toEqual([getWorkstream(state.db, s.workstream.id).batchId]);
      // The same opId replays the answer without installing again.
      await s.call('install_dependencies', { opId: 'op-deps-0001' });
      expect(dependencyInstalls).toHaveLength(1);
    });

    it('relays a refusal as the instruction, with nothing installed', async () => {
      const s = await seedSession(['api'], { path: repo.path, branch: 'batch/one' });
      installDependencies = () =>
        Promise.resolve({ kind: 'refused', reason: 'Dependencies are pinned exactly.' });
      const { json } = await s.call('install_dependencies', { opId: 'op-deps-0002' });
      expect(json).toMatchObject({
        installed: false,
        instruction: 'Dependencies are pinned exactly.',
      });
    });

    it('relays a failed install with its log and says never to run pnpm', async () => {
      const s = await seedSession(['api'], { path: repo.path, branch: 'batch/one' });
      installDependencies = () =>
        Promise.resolve({
          kind: 'failed',
          summary: 'The install failed (exit 1): ERR_PNPM_NO_MATCHING_VERSION',
          logPath: 'install.log',
        });
      const { json } = await s.call('install_dependencies', { opId: 'op-deps-0003' });
      expect(json).toMatchObject({ installed: false, logPath: 'install.log' });
      expect(JSON.stringify(json)).toContain('ERR_PNPM_NO_MATCHING_VERSION');
      expect(JSON.stringify(json)).toContain('Do not run pnpm yourself');
    });

    it('is refused for a task with no batch of its own', async () => {
      const s = await seedSession();
      const { text } = await s.call('install_dependencies', { opId: 'op-deps-0004' });
      expect(text).toContain('no copy of its own');
      expect(dependencyInstalls).toEqual([]);
    });
  });

  it('returns the context pack for the calling session', async () => {
    const s = await seedSession();
    const { json } = await s.call('get_context', {});
    expect(json).toMatchObject({
      task: { title: 'Alpha' },
      claims: [{ kind: 'area', name: 'api' }],
    });
  });

  it('reads a recorded decision back through find_knowledge', async () => {
    const s = await seedSession();
    await s.call('record_decision', {
      opId: 'op-decision-01',
      question: 'Which date library?',
      choice: 'dayjs',
      rationale: 'small',
      scope: 'project',
    });
    const { json } = await s.call('find_knowledge', { query: 'date library' });
    expect(json).toMatchObject({ empty: false, results: [{ choice: 'dayjs' }] });
    const question = await s.call('find_knowledge', { query: 'which date library should we use' });
    expect(question.json).toMatchObject({ empty: false, results: [{ choice: 'dayjs' }] });
  });

  it.each([
    { name: 'area scope without an area', scope: 'area', area: undefined, error: 'area' },
    { name: 'project scope with an area', scope: 'project', area: 'api', error: 'area' },
    { name: 'an area the project lacks', scope: 'area', area: 'billing', error: 'billing' },
  ])('rejects record_decision with $name', async ({ scope, area, error }) => {
    const s = await seedSession();
    const result = await s.call('record_decision', {
      opId: 'op-decision-bad',
      question: 'q?',
      choice: 'c',
      rationale: 'r',
      scope,
      ...(area ? { area } : {}),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(error);
  });

  it('records an area-scoped decision with its area', async () => {
    const s = await seedSession();
    const result = await s.call('record_decision', {
      opId: 'op-decision-ar',
      question: 'Which router?',
      choice: 'hono',
      rationale: 'small',
      scope: 'area',
      area: 'api',
    });
    expect(result.isError).toBe(false);
    const found = await s.call('find_knowledge', { query: 'router' });
    expect(found.json).toMatchObject({ results: [{ choice: 'hono' }] });
  });

  it('commits inside claims once per opId', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/a.ts', 'export {}\n');
    const first = await s.call('commit', {
      opId: 'op-commit-001',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    const retry = await s.call('commit', {
      opId: 'op-commit-001',
      paths: ['src/api/a.ts'],
      message: 'Add a',
    });
    expect(first.json).toMatchObject({ alreadyCommitted: false });
    expect(retry.json).toEqual(first.json);
    expect(commitCount()).toBe(2);
  });

  describe('a commit that resolves conflict markers', () => {
    const MARKED = '<<<<<<< HEAD\nours\n||||||| base\n=======\ntheirs\n>>>>>>> origin/main\n';
    /** The branch as the base merge leaves it: markers committed in src/api/a.ts. */
    async function markersOnTheBranch(s: Awaited<ReturnType<typeof seedSession>>): Promise<void> {
      writeRepoFile('src/api/a.ts', MARKED);
      await s.call('commit', {
        opId: 'op-commit-marked',
        paths: ['src/api/a.ts'],
        message: 'Stands in for the merge commit',
      });
    }
    const recorded = (s: Awaited<ReturnType<typeof seedSession>>) =>
      listToolOpResults(state.db, s.workstream.id, 'commit').map(commitResolvedMarkers);

    it.each<[string, NextAction]>([
      ['the first merge session', { kind: 'merge', base: 'origin/main', paths: ['src/api/a.ts'] }],
      [
        'a session the builder answered',
        { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
      ],
      [
        'a session the usage limit paused',
        { kind: 'resume', providerSessionId: 'p', reason: 'usage limit' },
      ],
      [
        'a session after a handoff',
        { kind: 'continue_from_handoff', handoffId: mintId('Handoff') },
      ],
      ['a session that left it uncommitted', { kind: 'uncommitted', paths: ['src/api/a.ts'] }],
    ])('is recorded when %s commits it', async (_name, nextAction) => {
      const s = await seedSession();
      await markersOnTheBranch(s);
      state.write((ctx) => {
        patchWorkstream(ctx, s.workstream.id, null, { nextAction });
      });
      writeRepoFile('src/api/a.ts', 'ours\ntheirs\n');
      await s.call('commit', { opId: 'op-commit-resolve', paths: ['src/api/a.ts'], message: 'R' });
      expect(recorded(s)).toEqual([false, true]);
    });

    it('does not mark work committed under a merge next action once the markers are resolved', async () => {
      const s = await seedSession();
      await markersOnTheBranch(s);
      state.write((ctx) => {
        patchWorkstream(ctx, s.workstream.id, null, {
          nextAction: { kind: 'merge', base: 'origin/main', paths: ['src/api/a.ts'] },
        });
      });
      writeRepoFile('src/api/a.ts', 'ours\ntheirs\n');
      await s.call('commit', { opId: 'op-commit-resolve', paths: ['src/api/a.ts'], message: 'R' });
      writeRepoFile('src/api/b.ts', 'export {}\n');
      await s.call('commit', { opId: 'op-commit-work', paths: ['src/api/b.ts'], message: 'Work' });
      expect(recorded(s)).toEqual([false, true, false]);
    });

    it('does not mark a commit that leaves the marked file alone, though markers remain', async () => {
      const s = await seedSession();
      await markersOnTheBranch(s);
      writeRepoFile('src/api/b.ts', 'export {}\n');
      await s.call('commit', { opId: 'op-commit-work', paths: ['src/api/b.ts'], message: 'Work' });
      expect(recorded(s)).toEqual([false, false]);
    });

    it('marks a resolution committed together with an adapted caller', async () => {
      const s = await seedSession();
      await markersOnTheBranch(s);
      writeRepoFile('src/api/a.ts', 'ours\ntheirs\n');
      writeRepoFile('src/api/caller.ts', 'export {}\n');
      await s.call('commit', {
        opId: 'op-commit-resolve',
        paths: ['src/api/a.ts', 'src/api/caller.ts'],
        message: 'R',
      });
      expect(recorded(s)).toEqual([false, true]);
    });

    it('marks a resolution the tool recovers after a crash, and answers the session as usual', async () => {
      const s = await seedSession();
      await markersOnTheBranch(s);
      writeRepoFile('src/api/a.ts', 'ours\ntheirs\n');
      const direct = await git.commit({
        repo: repo.path,
        paths: ['src/api/a.ts'],
        message: 'R',
        opId: 'op-crashed-02',
        branch: 'main',
      });
      const viaTool = await s.call('commit', {
        opId: 'op-crashed-02',
        paths: ['src/api/a.ts'],
        message: 'R',
      });
      expect(viaTool.json).toEqual({ sha: direct.sha, alreadyCommitted: true });
      expect(recorded(s)).toEqual([false, true]);
      const replay = await s.call('commit', {
        opId: 'op-crashed-02',
        paths: ['src/api/a.ts'],
        message: 'R',
      });
      expect(replay.json).toEqual(viaTool.json);
    });
  });

  describe('a commit result that made no new commit under a revert', () => {
    const headOf = () =>
      execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD'], { env: isolatedGitEnv() })
        .toString()
        .trim();
    /** Tells the run of a revert at `revert`, as a Retry or a joined start does. */
    const toldOf = (s: Awaited<ReturnType<typeof seedSession>>, revert: string) =>
      state.write((ctx) =>
        insertEvidence(ctx, {
          workstreamId: s.workstream.id,
          kind: 'builder',
          command: null,
          exitCode: null,
          summary: `Your commits were reverted.\n\n${revertCommitLine(revert)}`,
          logPath: null,
          commitShas: [],
        }),
      );
    const covered = (s: Awaited<ReturnType<typeof seedSession>>) =>
      listToolOpResults(state.db, s.workstream.id, 'commit').map(commitCoveredByRevert);

    it('is recorded when the sha is in the revert the run was told of', async () => {
      const s = await seedSession();
      writeRepoFile('src/api/b.ts', 'export {}\n');
      const direct = await git.commit({
        repo: repo.path,
        paths: ['src/api/b.ts'],
        message: 'Add b',
        opId: 'op-reused-01',
        branch: 'main',
      });
      toldOf(s, headOf());
      const viaTool = await s.call('commit', {
        opId: 'op-reused-01',
        paths: ['src/api/b.ts'],
        message: 'Add b',
      });
      expect(viaTool.json).toEqual({ sha: direct.sha, alreadyCommitted: true });
      expect(covered(s)).toEqual([true]);
    });

    it('is not recorded for a commit the revert does not cover', async () => {
      const s = await seedSession();
      toldOf(s, headOf());
      writeRepoFile('src/api/b.ts', 'export {}\n');
      await git.commit({
        repo: repo.path,
        paths: ['src/api/b.ts'],
        message: 'Add b',
        opId: 'op-after-01',
        branch: 'main',
      });
      const viaTool = await s.call('commit', {
        opId: 'op-after-01',
        paths: ['src/api/b.ts'],
        message: 'Add b',
      });
      expect(viaTool.json).toMatchObject({ alreadyCommitted: true });
      expect(covered(s)).toEqual([false]);
    });

    it('is not recorded for a new commit', async () => {
      const s = await seedSession();
      toldOf(s, headOf());
      writeRepoFile('src/api/b.ts', 'export {}\n');
      await s.call('commit', { opId: 'op-new-01', paths: ['src/api/b.ts'], message: 'Add b' });
      expect(covered(s)).toEqual([false]);
    });
  });

  describe('a commit made while the run is fixing a failed gate', () => {
    const evidenceOf = (
      s: Awaited<ReturnType<typeof seedSession>>,
      kind: 'gate' | 'builder',
      exitCode: number | null,
    ) =>
      state.write((ctx) =>
        insertEvidence(
          ctx,
          kind === 'gate'
            ? {
                workstreamId: s.workstream.id,
                kind,
                command: 'make gate',
                exitCode: exitCode ?? 0,
                summary: 'The gate failed',
                logPath: null,
                commitShas: [],
              }
            : {
                workstreamId: s.workstream.id,
                kind,
                command: null,
                exitCode: null,
                summary: 'Redo the work',
                logPath: null,
                commitShas: [],
              },
        ),
      );
    const throughGate = (s: Awaited<ReturnType<typeof seedSession>>) =>
      listToolOpResults(state.db, s.workstream.id, 'commit').map(commitGotThroughGate);
    const commitWork = async (s: Awaited<ReturnType<typeof seedSession>>, opId: string) => {
      writeRepoFile('src/api/b.ts', `export const op = '${opId}';\n`);
      await s.call('commit', { opId, paths: ['src/api/b.ts'], message: 'Work' });
    };

    it('is recorded when the latest gate run failed', async () => {
      const s = await seedSession();
      evidenceOf(s, 'gate', 1);
      await commitWork(s, 'op-gate-fix-1');
      expect(throughGate(s)).toEqual([true]);
    });

    it('is recorded after a session the builder answered continues the fix', async () => {
      const s = await seedSession();
      evidenceOf(s, 'gate', 1);
      state.write((ctx) => {
        patchWorkstream(ctx, s.workstream.id, null, {
          nextAction: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null },
        });
      });
      await commitWork(s, 'op-gate-fix-2');
      expect(throughGate(s)).toEqual([true]);
    });

    it('is not recorded when no gate has run', async () => {
      const s = await seedSession();
      await commitWork(s, 'op-no-gate');
      expect(throughGate(s)).toEqual([false]);
    });

    it('is not recorded when the latest gate run passed', async () => {
      const s = await seedSession();
      evidenceOf(s, 'gate', 1);
      evidenceOf(s, 'gate', 0);
      await commitWork(s, 'op-gate-passed');
      expect(throughGate(s)).toEqual([false]);
    });

    it('is not recorded when the builder’s note came after the failed gate run', async () => {
      const s = await seedSession();
      evidenceOf(s, 'gate', 1);
      evidenceOf(s, 'builder', null);
      await commitWork(s, 'op-note-after');
      expect(throughGate(s)).toEqual([false]);
    });
  });

  describe('a commit made after a resolution of conflict markers, before the next gate run', () => {
    const MARKED = '<<<<<<< HEAD\nours\n||||||| base\n=======\ntheirs\n>>>>>>> origin/main\n';
    const evidenceOf = (
      s: Awaited<ReturnType<typeof seedSession>>,
      kind: 'gate' | 'builder',
      exitCode: number,
    ) =>
      state.write((ctx) =>
        insertEvidence(
          ctx,
          kind === 'gate'
            ? {
                workstreamId: s.workstream.id,
                kind,
                command: 'make gate',
                exitCode,
                summary: 'The gate ran',
                logPath: null,
                commitShas: [],
              }
            : {
                workstreamId: s.workstream.id,
                kind,
                command: null,
                exitCode: null,
                summary: 'Redo the work',
                logPath: null,
                commitShas: [],
              },
        ),
      );
    const afterResolution = (s: Awaited<ReturnType<typeof seedSession>>) =>
      listToolOpResults(state.db, s.workstream.id, 'commit').map(commitAfterResolution);
    const commitFile = async (
      s: Awaited<ReturnType<typeof seedSession>>,
      opId: string,
      path: string,
      content: string,
    ) => {
      writeRepoFile(path, content);
      await s.call('commit', { opId, paths: [path], message: opId });
    };
    /** The branch as the base merge leaves it, then the session's resolution of it. */
    const resolved = async (s: Awaited<ReturnType<typeof seedSession>>) => {
      await commitFile(s, 'op-marked', 'src/api/a.ts', MARKED);
      await commitFile(s, 'op-resolve', 'src/api/a.ts', 'ours\ntheirs\n');
    };

    it('is recorded on a caller adapted after the resolution, and not on the resolution', async () => {
      const s = await seedSession();
      await resolved(s);
      await commitFile(s, 'op-caller', 'src/api/caller.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false, false, true]);
    });

    it('is recorded on every commit until a gate run', async () => {
      const s = await seedSession();
      await resolved(s);
      await commitFile(s, 'op-caller-1', 'src/api/c1.ts', 'export {}\n');
      await commitFile(s, 'op-caller-2', 'src/api/c2.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false, false, true, true]);
    });

    it('is not recorded once a gate run came after the resolution', async () => {
      const s = await seedSession();
      await resolved(s);
      evidenceOf(s, 'gate', 0);
      await commitFile(s, 'op-later', 'src/api/later.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false, false, false]);
    });

    it('is not recorded once a builder note came after the resolution', async () => {
      const s = await seedSession();
      await resolved(s);
      evidenceOf(s, 'builder', 0);
      await commitFile(s, 'op-redo-01', 'src/api/redo.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false, false, false]);
    });

    it('is recorded when the gate and the note came before the resolution', async () => {
      const s = await seedSession();
      evidenceOf(s, 'builder', 0);
      evidenceOf(s, 'gate', 1);
      await resolved(s);
      await commitFile(s, 'op-caller', 'src/api/caller.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false, false, true]);
    });

    it('is not recorded when no commit resolved markers', async () => {
      const s = await seedSession();
      await commitFile(s, 'op-work-01', 'src/api/work.ts', 'export {}\n');
      expect(afterResolution(s)).toEqual([false]);
    });
  });

  it('recovers a commit made before a crash that never recorded its op', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/b.ts', 'export {}\n');
    const direct = await git.commit({
      repo: repo.path,
      paths: ['src/api/b.ts'],
      message: 'Add b',
      opId: 'op-crashed-01',
      branch: 'main',
    });
    const viaTool = await s.call('commit', {
      opId: 'op-crashed-01',
      paths: ['src/api/b.ts'],
      message: 'Add b',
    });
    expect(viaTool.json).toEqual({ sha: direct.sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it("refuses a commit once the checkout left the session's branch, and tells the lane why", async () => {
    const s = await seedSession();
    execFileSync('git', ['-C', repo.path, 'switch', '-q', '-c', 'elsewhere'], {
      env: isolatedGitEnv(),
    });
    writeRepoFile('src/api/e.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-moved',
      paths: ['src/api/e.ts'],
      message: 'e',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("the checkout is on elsewhere, the lane's branch is main");
    expect(commitCount()).toBe(1);
  });

  it('refuses a commit for work pinned to no branch, its first session having found HEAD detached', async () => {
    workstreamBranch = null;
    const s = await seedSession();
    writeRepoFile('src/api/f.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-nobr',
      paths: ['src/api/f.ts'],
      message: 'f',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('detached');
    expect(commitCount()).toBe(1);
  });

  it('refuses to commit a path outside the claims', async () => {
    const s = await seedSession();
    writeRepoFile('src/ui/x.ts', 'export {}\n');
    const result = await s.call('commit', {
      opId: 'op-commit-ui1',
      paths: ['src/ui/x.ts'],
      message: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('request_claim');
    expect(commitCount()).toBe(1);
  });

  it('records a handoff with git-derived facts', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/c.ts', 'export {}\n');
    await s.call('commit', { opId: 'op-commit-c01', paths: ['src/api/c.ts'], message: 'Add c' });
    const handoff = {
      objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
      progress: { done: ['c'], notDone: ['d'], nextAction: 'Write d' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    const { json } = await s.call('write_handoff', { opId: 'op-handoff-01', ...handoff });
    expect(String(json?.['instruction'])).toContain('End your turn');
    const ctx = await s.call('get_context', {});
    expect(ctx.json).toMatchObject({
      handoff: {
        gitChangedFiles: ['src/api/c.ts'],
        content: { progress: { nextAction: 'Write d' } },
      },
    });
  });

  it('grants a free claim', async () => {
    const a = await seedSession(['api']);
    const granted = await a.call('request_claim', {
      opId: 'op-claim-ui-1',
      kind: 'area',
      name: 'ui',
      reason: 'shared badge',
    });
    expect(granted.json).toMatchObject({ granted: true });
  });

  const holdClaim = (
    project: ProjectDto,
    holder: ReturnType<typeof seedWorkstream>,
    claim: { kind: 'area' | 'hazard'; name: string },
  ) =>
    state.write((ctx) =>
      acquireClaims(ctx, {
        projectId: project.id,
        workstreamId: holder.workstream.id,
        requests: [claim],
        leaseExpiresAt: ctx.now,
      }),
    );
  const openCards = () => listInbox(state.db, { states: ['OPEN'] });
  /** What the session's task shows while it waits for a claim. */
  const noticeOf = (s: { workstream: { id: WorkstreamId } }) =>
    getWorkstream(state.db, s.workstream.id).notice;
  const releaseHolder = (holder: ReturnType<typeof seedWorkstream>) =>
    state.write((ctx) => releaseClaims(ctx, holder.workstream.id));

  it('waits for a claim another workstream holds, with a notice on its task naming the holder and no Inbox card, and gets it when it frees', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    let settled = false;
    const pending = a
      .call('request_claim', {
        opId: 'op-claim-ui-3',
        kind: 'area',
        name: 'ui',
        reason: 'need the badge',
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    expect(noticeOf(a)).toMatchObject({
      key: 'claim-wait:area:ui',
      tone: 'info',
      line: 'Waiting for area ui: task "Beta" holds it',
    });
    expect(noticeOf(a)?.body).toContain('"Beta" holds area ui');
    expect(noticeOf(a)?.body).toContain('"Alpha" is waiting for it');
    expect(noticeOf(a)?.body).toContain('need the badge');
    expect(openCards()).toEqual([]);
    // Several poll intervals pass, and the call is still waiting.
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).not.toContain('ui');

    releaseHolder(other);
    const granted = await pending;
    expect(granted.json).toMatchObject({ granted: true });
    expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).toContain('ui');
    expect(openCards()).toEqual([]);
    expect(noticeOf(a)).toBeNull();
  });

  it('shows the new holder when the claim changes hands, and nothing in the Inbox', async () => {
    const a = await seedSession(['api']);
    const first = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    const second = seedWorkstream(base, { project: a.project, title: 'Gamma', areas: ['ui'] });
    holdClaim(a.project, first, { kind: 'area', name: 'ui' });
    const pending = a.call('request_claim', {
      opId: 'op-claim-hands',
      kind: 'area',
      name: 'ui',
      reason: 'badge',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)?.line).toContain('"Beta"');
    });
    state.write((ctx) => {
      releaseClaims(ctx, first.workstream.id);
      acquireClaims(ctx, {
        projectId: a.project.id,
        workstreamId: second.workstream.id,
        requests: [{ kind: 'area', name: 'ui' }],
        leaseExpiresAt: ctx.now,
      });
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)?.line).toBe('Waiting for area ui: task "Gamma" holds it');
    });
    expect(openCards()).toEqual([]);
    releaseHolder(second);
    expect((await pending).json).toMatchObject({ granted: true });
    expect(noticeOf(a)).toBeNull();
  });

  it('names the holder it waits on to the scheduler, and asks it to look again, until the wait ends', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    expect(claimWaits.awaitedHolders()).toEqual(new Set());
    const pending = a.call('request_claim', {
      opId: 'op-awaited',
      kind: 'area',
      name: 'ui',
      reason: 'badge',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    expect(claimWaits.awaitedHolders()).toEqual(new Set([other.workstream.id]));
    expect(waitsStarted).toBe(1);
    releaseHolder(other);
    expect((await pending).json).toMatchObject({ granted: true });
    expect(claimWaits.awaitedHolders()).toEqual(new Set());
  });

  describe('a holder the update drain has parked', () => {
    it('ends the wait with a refusal telling the agent to hand off, whether the holder was parked before the ask or during the wait', async () => {
      const a = await seedSession(['api']);
      const beta = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
      holdClaim(a.project, beta, { kind: 'area', name: 'ui' });

      // Parked during the wait: the call waits, then is refused once the drain parks Beta.
      const during = a.call('request_claim', {
        opId: 'op-parked-during',
        kind: 'area',
        name: 'ui',
        reason: 'badge',
      });
      await vi.waitFor(() => {
        expect(noticeOf(a)).not.toBeNull();
      });
      parkedHolders.add(beta.workstream.id);
      const refused = await during;
      expect(refused.json).toMatchObject({
        granted: false,
        waiting: false,
        heldBy: beta.workstream.id,
        inboxId: null,
      });
      const { instruction } = refused.json as { instruction: string };
      // Ending the turn alone would finish the step and send half-done work to the gate.
      expect(instruction).toContain('write_handoff');
      expect(instruction).toContain('end your turn');
      expect(instruction).toContain('update');
      expect(noticeOf(a)).toBeNull();
      expect(claimWaits.awaitedHolders()).toEqual(new Set());

      // Parked before the ask: refused at once, with no wait left behind.
      const before = await a.call('request_claim', {
        opId: 'op-parked-before',
        kind: 'area',
        name: 'ui',
        reason: 'badge again',
      });
      expect(before.json).toMatchObject({ granted: false, waiting: false });
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).not.toContain('ui');
      expect(noticeOf(a)).toBeNull();
      expect(openCards()).toEqual([]);
    });

    it('records no refusal, so a retry with the same opId asks again once the drain is over', async () => {
      const a = await seedSession(['api']);
      const beta = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
      holdClaim(a.project, beta, { kind: 'area', name: 'ui' });
      parkedHolders.add(beta.workstream.id);
      const ask = {
        opId: 'op-parked-retry',
        kind: 'area',
        name: 'ui',
        reason: 'badge',
      };
      expect((await a.call('request_claim', ask)).json).toMatchObject({ granted: false });

      parkedHolders.clear();
      releaseHolder(beta);
      expect((await a.call('request_claim', ask)).json).toMatchObject({ granted: true });
    });

    it('keeps waiting for a holder that is not parked, and takes the claim when it frees', async () => {
      const a = await seedSession(['api']);
      const beta = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
      holdClaim(a.project, beta, { kind: 'area', name: 'ui' });
      const pending = a.call('request_claim', {
        opId: 'op-not-parked',
        kind: 'area',
        name: 'ui',
        reason: 'badge',
      });
      await vi.waitFor(() => {
        expect(noticeOf(a)).not.toBeNull();
      });
      await new Promise((r) => setTimeout(r, 40));
      releaseHolder(beta);
      expect((await pending).json).toMatchObject({ granted: true });
    });
  });

  it('keeps one deadlock card per claim, and withdraws it once a later wait for the claim needs none', async () => {
    const a = await seedSession(['api']);
    const b = await seedSession(['ui'], undefined, { project: a.project, title: 'Beta' });
    const waiting = a.call('request_claim', {
      opId: 'op-dfold-a',
      kind: 'area',
      name: 'ui',
      reason: 'x',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    claimWaitSliceMs = 50;
    for (const opId of ['op-dfold-b1', 'op-dfold-b2'])
      expect(
        (await b.call('request_claim', { opId, kind: 'area', name: 'api', reason: 'x' })).json,
      ).toMatchObject({ granted: false, waiting: true });
    expect(openCards().filter((c) => c.title === 'Claim deadlock: area api')).toHaveLength(1);
    // Beta lets ui go, so Alpha gets it and waits for nothing; Beta's wait goes on as a plain one.
    state.write((ctx) => releaseClaims(ctx, b.workstream.id));
    claimWaitSliceMs = 60_000;
    expect((await waiting).json).toMatchObject({ granted: true });
    const again = b.call('request_claim', {
      opId: 'op-dfold-b2',
      kind: 'area',
      name: 'api',
      reason: 'x',
    });
    await vi.waitFor(() => {
      expect(noticeOf(b)?.line).toBe('Waiting for area api: task "Alpha" holds it');
    });
    expect(openCards()).toEqual([]);
    sessionAbort.abort();
    await again;
  });

  it('answers a retry of a finished wait from the recorded result', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    const args = { opId: 'op-claim-ui-4', kind: 'area', name: 'ui', reason: 'badge' };
    const pending = a.call('request_claim', args);
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    releaseHolder(other);
    const first = await pending;
    const again = await a.call('request_claim', args);
    expect(again.json).toEqual(first.json);
  });

  it('stops waiting, and clears the notice, when the session ends', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    const pending = a.call('request_claim', {
      opId: 'op-claim-ui-5',
      kind: 'area',
      name: 'ui',
      reason: 'badge',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    sessionAbort.abort();
    const ended = await pending;
    expect(ended.isError).toBe(true);
    expect(ended.text).toContain('stopped waiting');
    expect(openCards()).toEqual([]);
    expect(noticeOf(a)).toBeNull();
    expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).not.toContain('ui');
  });

  it('answers "still waiting" before the tool call would time out, and a retry with the same opId joins the one wait', async () => {
    claimWaitSliceMs = 30;
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    const args = { opId: 'op-claim-slice', kind: 'area', name: 'ui', reason: 'badge' };
    const first = await a.call('request_claim', args);
    expect(first.isError).toBe(false);
    expect(first.json).toMatchObject({
      granted: false,
      waiting: true,
      heldBy: other.workstream.id,
    });
    expect(String(first.json?.['instruction'])).toContain('same opId');
    expect(first.json?.['inboxId']).toBeNull();
    expect(noticeOf(a)?.line).toContain('"Beta"');
    // Two retries at once, with the same opId, share the wait: one notice, no error, one result. Their
    // slice outlasts the test, so a slow machine can't end it before the holder lets go.
    claimWaitSliceMs = 60_000;
    const retries = [a.call('request_claim', args), a.call('request_claim', args)];
    await new Promise((r) => setTimeout(r, 10));
    expect(noticeOf(a)).not.toBeNull();
    expect(openCards()).toEqual([]);
    releaseHolder(other);
    const settled = await Promise.all(retries);
    for (const r of settled) {
      expect(r.isError).toBe(false);
      expect(r.json).toMatchObject({ granted: true });
    }
    expect(settled[0]?.json).toEqual(settled[1]?.json);
    expect(activeClaims(state.db, a.workstream.id).filter((c) => c.name === 'ui')).toHaveLength(1);
    expect(openCards()).toEqual([]);
    expect((await a.call('request_claim', args)).json).toEqual(settled[0]?.json);
  });

  describe('the migrations hazard', () => {
    const migrations = { kind: 'hazard', name: 'migrations', reason: 'add a column' };
    const holdsMigrations = (id: WorkstreamId) =>
      activeClaims(state.db, id).some((c) => c.kind === 'hazard' && c.name === 'migrations');

    it("is granted once the base is in the task's branch, and no other claim waits for that", async () => {
      const a = await seedSession(['api']);
      const ui = await a.call('request_claim', {
        opId: 'op-mig-ui',
        kind: 'area',
        name: 'ui',
        reason: 'x',
      });
      expect(ui.json).toMatchObject({ granted: true });
      expect(migrationsBaseTaken).toEqual([]);
      const granted = await a.call('request_claim', { opId: 'op-mig-1', ...migrations });
      expect(granted.json).toMatchObject({ granted: true });
      expect(migrationsBaseTaken).toEqual([a.workstream.id]);
      expect(holdsMigrations(a.workstream.id)).toBe(true);
    });

    it("is held back while the branch can't take its base, with what to do, and a retry with the same opId asks again", async () => {
      const a = await seedSession(['api']);
      const instruction = 'origin/main conflicts with this branch in README.md, so 10db…';
      takeMigrationsBase = () => Promise.resolve({ kind: 'held', instruction });
      const args = { opId: 'op-mig-held', ...migrations };
      const held = await a.call('request_claim', args);
      expect(held.json).toEqual({
        granted: false,
        waiting: false,
        heldBy: null,
        inboxId: null,
        instruction,
      });
      expect(holdsMigrations(a.workstream.id)).toBe(false);
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).toEqual(['api']);

      // The builder resolves the conflict; the same call now gets the hazard.
      takeMigrationsBase = () => Promise.resolve({ kind: 'ready' });
      expect((await a.call('request_claim', args)).json).toMatchObject({ granted: true });
      expect(migrationsBaseTaken).toEqual([a.workstream.id, a.workstream.id]);
      expect(holdsMigrations(a.workstream.id)).toBe(true);
    });

    it('is held back with no card when the agent can clear the cause itself', async () => {
      const a = await seedSession(['api']);
      takeMigrationsBase = () =>
        Promise.resolve({ kind: 'held', instruction: 'Commit README.md first.' });
      const held = await a.call('request_claim', { opId: 'op-mig-self', ...migrations });
      expect(held.json).toMatchObject({
        granted: false,
        inboxId: null,
        instruction: 'Commit README.md first.',
      });
      expect(holdsMigrations(a.workstream.id)).toBe(false);
    });

    it('answers "still waiting" while the base is still coming in, and a retry with the same opId joins it', async () => {
      claimWaitSliceMs = 30;
      const a = await seedSession(['api']);
      let finish: (taken: MigrationsBaseTake) => void = () => undefined;
      const merging = new Promise<MigrationsBaseTake>((resolve) => {
        finish = resolve;
      });
      takeMigrationsBase = () => merging;
      const args = { opId: 'op-mig-slow', ...migrations };
      const first = await a.call('request_claim', args);
      expect(first.json).toMatchObject({
        granted: false,
        waiting: true,
        heldBy: null,
        inboxId: null,
      });
      expect(String(first.json?.['instruction'])).toContain(
        "Don't generate or write a migration yet",
      );
      expect(String(first.json?.['instruction'])).toContain('same opId');
      claimWaitSliceMs = 60_000;
      const retry = a.call('request_claim', args);
      await new Promise((r) => setTimeout(r, 10));
      finish({ kind: 'ready' });
      expect((await retry).json).toMatchObject({ granted: true });
      expect(holdsMigrations(a.workstream.id)).toBe(true);
    });
  });

  it('a call with a new opId for a claim already waited for joins that wait', async () => {
    claimWaitSliceMs = 30;
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    await a.call('request_claim', { opId: 'op-join-1', kind: 'area', name: 'ui', reason: 'x' });
    claimWaitSliceMs = 60_000;
    const second = a.call('request_claim', {
      opId: 'op-join-2',
      kind: 'area',
      name: 'ui',
      reason: 'x',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(noticeOf(a)).not.toBeNull();
    releaseHolder(other);
    expect((await second).json).toMatchObject({ granted: true });
    expect(openCards()).toEqual([]);
  });

  describe('a claim deadlock card', () => {
    /**
     * Alpha holds api and waits for ui; Beta holds ui and asks for api, which raises the card. Beta's
     * call waits on the card.
     */
    async function deadlocked() {
      const a = await seedSession(['api']);
      const b = await seedSession(['ui'], undefined, { project: a.project, title: 'Beta' });
      const alpha = a.call('request_claim', {
        opId: 'op-deadlock-a',
        kind: 'area',
        name: 'ui',
        reason: 'x',
      });
      await vi.waitFor(() => {
        expect(noticeOf(a)).not.toBeNull();
      });
      const beta = b.call('request_claim', {
        opId: 'op-deadlock-b',
        kind: 'area',
        name: 'api',
        reason: 'badge',
      });
      const card = await vi.waitFor(() => {
        const found = openCards().find((c) => c.title === 'Claim deadlock: area api');
        if (!found) throw new Error('no deadlock card');
        return found;
      });
      return { a, b, alpha, beta, card };
    }

    it('offers each task yielding its claim and cancelling each task', async () => {
      const { alpha, beta, card } = await deadlocked();
      expect(card.options.map((o) => o.label)).toEqual([
        'Beta yields area ui',
        'Alpha yields area api',
        'Cancel Beta',
        'Cancel Alpha',
      ]);
      expect(card.options.every((o) => o.description.length > 0)).toBe(true);
      sessionAbort.abort();
      await Promise.all([alpha, beta]);
    });

    it('shows the new holder in its title, answers and detail when the claim changes hands and the deadlock comes back', async () => {
      const { a, b, alpha, beta, card } = await deadlocked();
      const g = await seedSession(['migrations'], undefined, {
        project: a.project,
        title: 'Gamma',
      });
      const gamma = g.call('request_claim', {
        opId: 'op-deadlock-g',
        kind: 'area',
        name: 'ui',
        reason: 'x',
      });
      await vi.waitFor(() => {
        expect(noticeOf(g)).not.toBeNull();
      });
      // Gamma takes api from Alpha in one write, before Beta's wait looks again.
      state.write((ctx) => {
        releaseClaims(ctx, a.workstream.id);
        acquireClaims(ctx, {
          projectId: a.project.id,
          workstreamId: g.workstream.id,
          requests: [{ kind: 'area', name: 'api' }],
          leaseExpiresAt: ctx.now,
        });
      });
      const refreshed = await vi.waitFor(() => {
        const found = getInboxItem(state.db, card.id);
        if (!found.options.some((o) => o.label === 'Gamma yields area api'))
          throw new Error('card not refreshed');
        return found;
      });
      expect(openCards().filter((c) => c.title === 'Claim deadlock: area api')).toHaveLength(1);
      const labels = refreshed.options.map((o) => o.label);
      expect(labels).toEqual(
        expect.arrayContaining(['Gamma yields area api', 'Cancel Beta', 'Cancel Gamma']),
      );
      expect(labels.filter((l) => l.includes('Alpha'))).toEqual([]);
      expect(refreshed.detail?.['heldBy']).toBe(g.workstream.id);
      expect(refreshed.body).toContain('Task "Gamma" holds area api');
      expect(b.workstream.id).not.toBe(g.workstream.id);
      sessionAbort.abort();
      await Promise.all([alpha, beta, gamma]);
    });

    it('lists each yielded claim once when a third task also waits for it', async () => {
      const { a, alpha, beta, card } = await deadlocked();
      const g = await seedSession(['migrations'], undefined, {
        project: a.project,
        title: 'Gamma',
      });
      const gamma = g.call('request_claim', {
        opId: 'op-deadlock-g',
        kind: 'area',
        name: 'ui',
        reason: 'x',
      });
      await vi.waitFor(() => {
        expect(noticeOf(g)).not.toBeNull();
      });
      state.write((ctx) => {
        releaseClaims(ctx, a.workstream.id);
        acquireClaims(ctx, {
          projectId: a.project.id,
          workstreamId: g.workstream.id,
          requests: [{ kind: 'area', name: 'api' }],
          leaseExpiresAt: ctx.now,
        });
      });
      const refreshed = await vi.waitFor(() => {
        const found = getInboxItem(state.db, card.id);
        if (!found.options.some((o) => o.label === 'Gamma yields area api'))
          throw new Error('card not refreshed');
        return found;
      });
      expect(refreshed.options.map((o) => o.label)).toEqual([
        'Beta yields area ui',
        'Gamma yields area api',
        'Cancel Beta',
        'Cancel Gamma',
      ]);
      sessionAbort.abort();
      await Promise.all([alpha, beta, gamma]);
    });

    it('keeps the refused call waiting on the card, and says so when a slice ends', async () => {
      claimWaitSliceMs = 50;
      const { a, alpha, beta, card } = await deadlocked();
      const answered = (await beta).json;
      expect(answered).toMatchObject({
        granted: false,
        waiting: true,
        heldBy: a.workstream.id,
        inboxId: card.id,
      });
      expect(String(answered?.['instruction'])).toContain('same opId');
      sessionAbort.abort();
      await alpha;
    });

    it('frees the waiting task when the asker yields its claim, and tells the asker what it gave up', async () => {
      const { a, b, alpha, beta, card } = await deadlocked();
      inbox.answer(card.id, { choice: 'Beta yields area ui' });
      expect((await alpha).json).toMatchObject({ granted: true });
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).toContain('ui');
      expect(activeClaims(state.db, b.workstream.id)).toEqual([]);
      expect(getInboxItem(state.db, card.id).state).toBe('RESOLVED');
      const told = (await beta).json;
      expect(told).toMatchObject({ granted: false, waiting: false });
      expect(String(told?.['instruction'])).toContain('area ui');
      // Beta asks again: Alpha waits for nothing, so this is a plain wait, with no card.
      const again = b.call('request_claim', {
        opId: 'op-deadlock-b2',
        kind: 'area',
        name: 'api',
        reason: 'badge',
      });
      await vi.waitFor(() => {
        expect(noticeOf(b)?.line).toBe('Waiting for area api: task "Alpha" holds it');
      });
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
      await again;
    });

    it('gives the asker the claim in its pending call when the holder yields it, and tells the holder', async () => {
      const { a, b, alpha, beta, card } = await deadlocked();
      inbox.answer(card.id, { choice: 'Alpha yields area api' });
      expect((await beta).json).toMatchObject({ granted: true });
      expect(activeClaims(state.db, b.workstream.id).map((c) => c.name)).toContain('api');
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).not.toContain('api');
      // Alpha's own wait ends with what it gave up, before it edits there again.
      const told = (await alpha).json;
      expect(told).toMatchObject({ granted: false, waiting: false });
      expect(String(told?.['instruction'])).toContain('area api');
      expect(String(told?.['instruction'])).toContain('request_claim');
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
    });

    it('tells the yielding task at its next ask when its wait ended between calls', async () => {
      claimWaitSliceMs = 50;
      const { a, b, alpha, beta, card } = await deadlocked();
      // Both calls answer "still waiting", and neither agent has called again yet.
      expect((await alpha).json).toMatchObject({ granted: false, waiting: true });
      expect((await beta).json).toMatchObject({ granted: false, waiting: true });
      inbox.answer(card.id, { choice: 'Alpha yields area api' });
      await vi.waitFor(() => {
        expect(activeClaims(state.db, b.workstream.id).map((c) => c.name)).toContain('api');
        expect(claimWaits.holdersAwaitedBy(a.workstream.id)).toEqual([]);
      });
      claimWaitSliceMs = 60_000;
      const told = (
        await a.call('request_claim', {
          opId: 'op-deadlock-a',
          kind: 'area',
          name: 'ui',
          reason: 'x',
        })
      ).json;
      expect(told).toMatchObject({ granted: false, waiting: false });
      expect(String(told?.['instruction'])).toContain('area api');
      sessionAbort.abort();
    });

    it.each(['CANCELLED', 'FAILED', 'DONE'] as const)(
      'drops a yield its agent never heard about once the task is %s',
      async (to) => {
        claimWaitSliceMs = 50;
        const { a, b, alpha, beta, card } = await deadlocked();
        expect((await alpha).json).toMatchObject({ waiting: true });
        expect((await beta).json).toMatchObject({ waiting: true });
        inbox.answer(card.id, { choice: 'Alpha yields area api' });
        await vi.waitFor(() => {
          expect(activeClaims(state.db, b.workstream.id).map((c) => c.name)).toContain('api');
          expect(claimWaits.holdersAwaitedBy(a.workstream.id)).toEqual([]);
        });
        expect(claimWaits.pendingYield(a.workstream.id)).toBeDefined();
        // The task goes on to a state it cannot ask from, and the entry would outlive it.
        state.write((ctx) => {
          if (to === 'CANCELLED') transitionWorkstream(ctx, a.workstream.id, { to, fence: null });
          // The fixture's task sits in QUEUED, which cannot reach these two; only the event matters.
          else
            ctx.emit({
              type: EventType.WorkstreamChanged,
              entityType: 'workstream',
              entityId: a.workstream.id,
              data: { from: 'RUNNING', to, reason: null },
            });
        });
        expect(claimWaits.pendingYield(a.workstream.id)).toBeUndefined();
        sessionAbort.abort();
      },
    );

    it('keeps a yield while its task is still going', async () => {
      claimWaitSliceMs = 50;
      const { a, b, alpha, beta, card } = await deadlocked();
      expect((await alpha).json).toMatchObject({ waiting: true });
      expect((await beta).json).toMatchObject({ waiting: true });
      inbox.answer(card.id, { choice: 'Alpha yields area api' });
      await vi.waitFor(() => {
        expect(activeClaims(state.db, b.workstream.id).map((c) => c.name)).toContain('api');
      });
      state.write((ctx) => {
        ctx.emit({
          type: EventType.WorkstreamChanged,
          entityType: 'workstream',
          entityId: a.workstream.id,
          data: { from: 'RUNNING', to: 'WAITING_HUMAN', reason: null },
        });
      });
      expect(claimWaits.pendingYield(a.workstream.id)).toBeDefined();
      sessionAbort.abort();
    });

    it('cancels the chosen task, which frees what it held', async () => {
      const { a, b, alpha, beta, card } = await deadlocked();
      inbox.answer(card.id, { choice: 'Cancel Beta' });
      expect(cancelled).toEqual([b.workstream.id]);
      expect((await alpha).json).toMatchObject({ granted: true });
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).toContain('ui');
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
      await beta;
    });

    it('gives the asker the claim in its pending call when the holder is cancelled', async () => {
      const { a, alpha, beta, card } = await deadlocked();
      inbox.answer(card.id, { choice: 'Cancel Alpha' });
      expect(cancelled).toEqual([a.workstream.id]);
      expect((await beta).json).toMatchObject({ granted: true });
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
      await alpha;
    });

    it('withdraws the card when the wait that raised it ends without the claim', async () => {
      const { b, alpha, beta, card } = await deadlocked();
      b.stopSession();
      expect((await beta).isError).toBe(true);
      expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
      await alpha;
    });

    it('withdraws the card when the other task’s wait ends, though nobody asks again', async () => {
      const { a, alpha, beta, card } = await deadlocked();
      a.stopSession();
      expect((await alpha).isError).toBe(true);
      await vi.waitFor(() => {
        expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
      });
      // Beta's wait goes on as a plain one: Alpha waits for nothing now.
      expect(openCards()).toEqual([]);
      sessionAbort.abort();
      await beta;
    });

    it.each([
      ['the task that holds the claim', 'a'],
      ['the task that raised the card', 'b'],
    ] as const)(
      'withdraws the card when %s reaches a terminal state while its wait is still live',
      async (_who, which) => {
        const { a, b, alpha, beta, card } = await deadlocked();
        const ended = which === 'a' ? a : b;
        state.write((ctx) => {
          transitionWorkstream(ctx, ended.workstream.id, { to: 'CANCELLED', fence: null });
        });
        await vi.waitFor(() => {
          expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
        });
        expect(openCards()).toEqual([]);
        sessionAbort.abort();
        await Promise.all([alpha, beta]);
      },
    );

    it('refuses and withdraws an answer once no wait waits on the card', async () => {
      const { a, b, alpha, beta, card } = await deadlocked();
      // The daemon restarted: its waits are gone, and the card is still open.
      const live = claimWaits;
      claimWaits = new ClaimWaits();
      expect(() => {
        inbox.answer(card.id, { choice: 'Beta yields area ui' });
      }).toThrow(/already ended/);
      expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
      expect(activeClaims(state.db, b.workstream.id).map((c) => c.name)).toContain('ui');
      expect(activeClaims(state.db, a.workstream.id).map((c) => c.name)).toContain('api');
      claimWaits = live;
      sessionAbort.abort();
      await Promise.all([alpha, beta]);
    });

    it('refuses a cancel once no wait waits on the card', async () => {
      const { alpha, beta, card } = await deadlocked();
      const live = claimWaits;
      claimWaits = new ClaimWaits();
      expect(() => {
        inbox.answer(card.id, { choice: 'Cancel Alpha' });
      }).toThrow(/already ended/);
      expect(cancelled).toEqual([]);
      expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
      claimWaits = live;
      sessionAbort.abort();
      await Promise.all([alpha, beta]);
    });

    it('is withdrawn at startup, since the waits it belongs to ended with the daemon', async () => {
      const { alpha, beta, card } = await deadlocked();
      withdrawStaleClaimWaits(state, inbox);
      expect(getInboxItem(state.db, card.id).state).toBe('CANCELLED');
      sessionAbort.abort();
      await Promise.all([alpha, beta]);
    });

    it.each(['CANCELLED', 'FAILED', 'DONE'] as const)(
      'stores no yield for a task that is already %s, whose wait has not noticed yet',
      async (to) => {
        const { a, alpha, beta, card } = await deadlocked();
        // The task ended while its request_claim wait still runs; its terminal event has passed.
        state.write((ctx) => {
          // The fixture's task sits in QUEUED; DONE and FAILED are reached through VERIFYING.
          const path = to === 'CANCELLED' ? [to] : (['STARTING', 'VERIFYING', to] as const);
          for (const step of path)
            transitionWorkstream(ctx, a.workstream.id, { to: step, fence: null });
        });
        inbox.answer(card.id, { choice: 'Alpha yields area api' });
        expect(claimWaits.pendingYield(a.workstream.id)).toBeUndefined();
        sessionAbort.abort();
        await Promise.all([alpha, beta]);
      },
    );

    it('does not cancel a task that has already ended', async () => {
      const { a, alpha, beta, card } = await deadlocked();
      state.write((ctx) => {
        transitionWorkstream(ctx, a.workstream.id, { to: 'CANCELLED', fence: null });
      });
      inbox.answer(card.id, { choice: 'Cancel Alpha' });
      expect(cancelled).toEqual([]);
      sessionAbort.abort();
      await Promise.all([alpha, beta]);
    });
  });

  it('raises a card naming both tasks, and no wait notice, when waiting would deadlock', async () => {
    const a = await seedSession(['api']);
    const b = await seedSession(['ui'], undefined, { project: a.project, title: 'Beta' });
    // Alpha waits for ui, which Beta holds.
    const waiting = a.call('request_claim', {
      opId: 'op-dlock-a',
      kind: 'area',
      name: 'ui',
      reason: 'x',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    const refused = b.call('request_claim', {
      opId: 'op-dlock-b',
      kind: 'area',
      name: 'api',
      reason: 'badge',
    });
    await vi.waitFor(() => {
      expect(openCards().map((c) => c.title)).toEqual(['Claim deadlock: area api']);
    });
    expect(openCards()[0]?.body).toContain('"Alpha"');
    expect(openCards()[0]?.body).toContain('"Beta"');
    expect(noticeOf(b)).toBeNull();
    sessionAbort.abort();
    await Promise.all([waiting, refused]);
  });

  it('raises a card for a wait whose new holder turns out to wait for this task', async () => {
    const a = await seedSession(['api']);
    const b = await seedSession(['ui'], undefined, { project: a.project, title: 'Beta' });
    const other = seedWorkstream(base, {
      project: a.project,
      title: 'Gamma',
      areas: ['migrations'],
    });
    holdClaim(a.project, other, { kind: 'hazard', name: 'migrations' });
    const alpha = a.call('request_claim', {
      opId: 'op-hchg-a',
      kind: 'hazard',
      name: 'migrations',
      reason: 'x',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)).not.toBeNull();
    });
    // Beta waits for api, which Alpha holds; Alpha waits on Gamma, so that is no deadlock yet.
    const beta = b.call('request_claim', {
      opId: 'op-hchg-b',
      kind: 'area',
      name: 'api',
      reason: 'x',
    });
    await vi.waitFor(() => {
      expect(noticeOf(b)).not.toBeNull();
    });
    // Gamma hands migrations to Beta in one write, before Alpha looks again.
    state.write((ctx) => {
      releaseClaims(ctx, other.workstream.id);
      acquireClaims(ctx, {
        projectId: a.project.id,
        workstreamId: b.workstream.id,
        requests: [{ kind: 'hazard', name: 'migrations' }],
        leaseExpiresAt: ctx.now,
      });
    });
    await vi.waitFor(() => {
      expect(openCards().map((c) => c.title)).toEqual(['Claim deadlock: hazard migrations']);
    });
    expect(noticeOf(a)).toBeNull();
    sessionAbort.abort();
    await Promise.all([alpha, beta]);
  });

  it('a wait left by a crashed daemon causes no refusal, and startup clears its notice and withdraws its old card', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    holdClaim(a.project, other, { kind: 'area', name: 'ui' });
    const stale = inbox.flag({
      projectId: a.project.id,
      workstreamId: other.workstream.id,
      title: 'Waiting for area api',
      body: 'x',
      detail: { waitingFor: { kind: 'area', name: 'api' }, heldBy: a.workstream.id },
    });
    const waiting = a.call('request_claim', {
      opId: 'op-stale',
      kind: 'area',
      name: 'ui',
      reason: 'x',
    });
    state.write((ctx) =>
      setWorkstreamNotice(ctx, other.workstream.id, {
        key: 'claim-wait:area:api',
        tone: 'info',
        line: 'Waiting for area api: task "Alpha" holds it',
        body: 'x',
      }),
    );
    await vi.waitFor(() => {
      expect(noticeOf(a)?.line).toBe('Waiting for area ui: task "Beta" holds it');
    });
    releaseHolder(other);
    expect((await waiting).json).toMatchObject({ granted: true });
    withdrawStaleClaimWaits(state, inbox);
    expect(getInboxItem(state.db, stale.id).state).toBe('CANCELLED');
    expect(noticeOf(other)).toBeNull();
  });

  it('treats a project hazard name as a hazard claim whatever kind the agent sends', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, {
      project: a.project,
      title: 'Beta',
      areas: ['migrations'],
    });
    holdClaim(a.project, other, { kind: 'hazard', name: 'migrations' });
    const waiting = a.call('request_claim', {
      opId: 'op-claim-haz-1',
      kind: 'area',
      name: 'migrations',
      reason: 'need a table',
    });
    await vi.waitFor(() => {
      expect(noticeOf(a)?.line).toBe('Waiting for hazard migrations: task "Beta" holds it');
    });
    expect(openCards()).toEqual([]);
    releaseHolder(other);
    expect((await waiting).json).toMatchObject({ granted: true });
    const free = await a.call('request_claim', {
      opId: 'op-claim-haz-2',
      kind: 'area',
      name: 'deps',
      reason: 'need a package',
    });
    expect(free.json).toMatchObject({ granted: true });
    const pack = await a.call('get_context', {});
    const claims = z
      .array(z.object({ kind: z.string(), name: z.string() }))
      .parse(pack.json?.['claims']);
    expect(claims).toContainEqual({ kind: 'hazard', name: 'deps' });
  });

  it('rejects a claim for a name that is neither an area nor a hazard', async () => {
    const a = await seedSession(['api']);
    const result = await a.call('request_claim', {
      opId: 'op-claim-bad-1',
      kind: 'area',
      name: 'nowhere',
      reason: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('nowhere');
  });

  it('names a nonexistent path when commit cannot stage it', async () => {
    const s = await seedSession();
    const result = await s.call('commit', {
      opId: 'op-commit-typo',
      paths: ['src/api/typo.ts'],
      message: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('src/api/typo.ts');
    expect(result.text).not.toContain('Internal error');
    expect(commitCount()).toBe(1);
  });

  it('reports malformed input from the schema as a readable tool error', async () => {
    const s = await seedSession();
    const result = await s.call('record_evidence', {
      opId: 'x',
      command: 'pnpm test',
      exitCode: 0,
      summary: 'ok',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('opId');
  });

  it('logs an unexpected error and does not promise a retry will work', async () => {
    const failing = createMcpHandler({
      protectedPaths: GUARDED,
      state,
      inbox,
      git: { ...git, commit: () => Promise.reject(new Error('disk exploded')) },
      log: capturingLogger,
      waitObserverFor: () => undefined,
      askedToHandOff: () => undefined,
      sessionSignal: () => undefined,
    });
    const failingServer = serve({ fetch: failing, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => failingServer.once('listening', r));
    try {
      // See the beforeEach cast.
      url = `http://127.0.0.1:${String((failingServer.address() as AddressInfo).port)}/mcp`;
      const s = await seedSession();
      writeRepoFile('src/api/d.ts', 'export {}\n');
      const result = await s.call('commit', {
        opId: 'op-commit-boom',
        paths: ['src/api/d.ts'],
        message: 'd',
      });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('retry the call with the same opId');
      expect(result.text).toContain('commit');
      expect(logged).toHaveLength(1);
      expect(logged[0]?.obj).toMatchObject({ tool: 'commit', opId: 'op-commit-boom' });
    } finally {
      failingServer.close();
    }
  });

  it('rejects an opId reused for a different tool', async () => {
    const s = await seedSession();
    await s.call('record_decision', {
      opId: 'op-shared-001',
      question: 'q?',
      choice: 'c',
      rationale: 'r',
      scope: 'project',
    });
    const reused = await s.call('report_deviation', {
      opId: 'op-shared-001',
      cause: 'x',
      severity: 'info',
      reason: 'y',
    });
    expect(reused.isError).toBe(true);
    expect(reused.text).toContain('already used for record_decision');
    expect(state.db.select().from(schema.deviations).all()).toHaveLength(0);
  });

  it('waits on ask_human until the builder answers', async () => {
    const s = await seedSession();
    const pending = s.call('ask_human', {
      opId: 'op-ask-00001',
      category: 'design',
      question: 'Teal or red?',
      options: [
        { label: 'Teal', description: '' },
        { label: 'Red', description: '' },
      ],
    });
    let card;
    for (let i = 0; i < 50 && !card; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      card = listInbox(state.db, { states: ['OPEN'] })[0];
    }
    if (!card) throw new Error('no card opened');
    inbox.answer(card.id, { choice: 'Teal' });
    expect((await pending).json).toMatchObject({ answer: 'Teal' });
  });

  it('tells a parked ask_human not to ask again', async () => {
    const abort = new AbortController();
    const parkedHandler = createMcpHandler({
      protectedPaths: GUARDED,
      state,
      inbox,
      git,
      log: capturingLogger,
      waitObserverFor: () => undefined,
      askedToHandOff: () => undefined,
      sessionSignal: () => abort.signal,
    });
    const parkedServer = serve({ fetch: parkedHandler, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => parkedServer.once('listening', r));
    try {
      // See the beforeEach cast.
      url = `http://127.0.0.1:${String((parkedServer.address() as AddressInfo).port)}/mcp`;
      const s = await seedSession();
      const pending = s.call('ask_human', {
        opId: 'op-ask-parked',
        category: 'design',
        question: 'Round or square?',
        options: [
          { label: 'Round', description: '' },
          { label: 'Square', description: '' },
        ],
      });
      for (let i = 0; i < 50 && listInbox(state.db, { states: ['OPEN'] }).length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      abort.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Do not ask again');
    } finally {
      parkedServer.close();
    }
  });
});

describe('MCP idempotence by opId', () => {
  const rows = {
    decisions: () => state.db.select().from(schema.decisions).all().length,
    proposals: () => state.db.select().from(schema.proposals).all().length,
    deviations: () => state.db.select().from(schema.deviations).all().length,
    evidence: () => state.db.select().from(schema.evidence).all().length,
    handoffs: () => state.db.select().from(schema.handoffs).all().length,
    claims: () => state.db.select().from(schema.claims).all().length,
    inbox: () => listInbox(state.db, {}).length,
  };
  const handoff = {
    objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
    progress: { done: [], notDone: [], nextAction: 'Write d' },
    codeState: { uncommittedSummary: '' },
    reasoning: { decisions: [], tradeOffs: [], rejected: [] },
    validation: { checks: [], environmentProblems: [] },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  };
  const table: {
    name: string;
    tool: string;
    args: Record<string, unknown>;
    // Rows that exist after the call, keyed by what each call must have created.
    created: Partial<Record<keyof typeof rows, number>>;
  }[] = [
    {
      name: 'record_decision',
      tool: 'record_decision',
      args: { opId: 'op-idem-0001', question: 'q?', choice: 'c', rationale: 'r', scope: 'project' },
      created: { decisions: 1 },
    },
    {
      name: 'propose (one proposal and one card)',
      tool: 'propose',
      args: {
        opId: 'op-idem-0002',
        kind: 'new_task',
        title: 'Add x',
        body: 'because',
        kinds: ['security'],
      },
      created: { proposals: 1, inbox: 1 },
    },
    {
      name: 'report_deviation',
      tool: 'report_deviation',
      args: { opId: 'op-idem-0003', cause: 'x', severity: 'info', reason: 'y' },
      created: { deviations: 1 },
    },
    {
      name: 'record_evidence',
      tool: 'record_evidence',
      args: { opId: 'op-idem-0004', command: 'pnpm test', exitCode: 0, summary: 'ok' },
      created: { evidence: 1 },
    },
    {
      name: 'write_handoff',
      tool: 'write_handoff',
      args: { opId: 'op-idem-0005', ...handoff },
      created: { handoffs: 1 },
    },
    {
      name: 'request_claim (granted)',
      tool: 'request_claim',
      args: { opId: 'op-idem-0006', kind: 'area', name: 'ui', reason: 'badge' },
      // The session's own api claim plus the granted ui claim.
      created: { claims: 2 },
    },
  ];

  it.each(table)('$name runs once for a repeated opId', async ({ tool, args, created }) => {
    const s = await seedSession();
    const first = await s.call(tool, args);
    const second = await s.call(tool, args);
    expect(first.isError).toBe(false);
    expect(second.json).toEqual(first.json);
    for (const [key, expected] of Object.entries(created)) {
      expect(rows[key as keyof typeof rows](), key).toBe(expected);
    }
  });

  it('answers a repeated ask_human from the recorded result without a second card', async () => {
    const s = await seedSession();
    const args = {
      opId: 'op-idem-0007',
      category: 'design',
      question: 'Teal or red?',
      options: [
        { label: 'Teal', description: '' },
        { label: 'Red', description: '' },
      ],
    };
    const pending = s.call('ask_human', args);
    let card;
    for (let i = 0; i < 50 && !card; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      card = listInbox(state.db, { states: ['OPEN'] })[0];
    }
    if (!card) throw new Error('no card opened');
    inbox.answer(card.id, { choice: 'Teal' });
    const first = await pending;
    const second = await s.call('ask_human', args);
    expect(second.json).toEqual(first.json);
    expect(rows.inbox()).toBe(1);
  });
});

const stepAt = (role: 'implement' | 'review' | 'plan'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: 'running',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  setting: null,
});

async function onStep(role: 'implement' | 'review' | 'plan') {
  const s = await seedSession();
  state.write((ctx) => {
    patchWorkstream(ctx, s.workstream.id, null, {
      steps: [stepAt('implement'), stepAt(role)],
      stepIndex: 1,
    });
  });
  return s;
}

describe('resize_task', () => {
  const why = 'It touches two areas and a migration';
  const cards = () =>
    listInbox(state.db, { states: ['OPEN'] }).filter((c) => c.title.includes('resized'));
  const taskOf = (s: { task: { id: TaskId } }) => getTask(state.db, s.task.id);

  it.each([
    { role: 'implement' as const, by: 'The build session' },
    { role: 'plan' as const, by: 'Plan session' },
  ])(
    'resizes the task from a $role step, pinning it as the agent’s with the reason, and tells the builder once',
    async ({ role, by }) => {
      const s = await onStep(role);
      const result = await s.call('resize_task', { opId: 'op-resize-01', rigor: 'careful', why });
      expect(result.json).toMatchObject({ resized: true });
      expect(taskOf(s)).toMatchObject({
        rigor: 'careful',
        rigorSource: 'agent',
        rigorReason: why,
        effectiveRigor: 'careful',
        effectiveRigorSource: 'agent',
      });
      expect(cards()).toHaveLength(1);
      expect(cards()[0]).toMatchObject({
        title: expect.stringContaining('Alpha') as string,
        body: expect.stringContaining(`${by} resized Alpha to Careful: ${why}`) as string,
        options: [{ label: 'Got it', description: '' }],
      });
    },
  );

  it('answers a replayed opId with the first result and raises no second notice', async () => {
    const s = await onStep('implement');
    const first = await s.call('resize_task', { opId: 'op-resize-02', rigor: 'light', why });
    const replay = await s.call('resize_task', { opId: 'op-resize-02', rigor: 'light', why });
    expect(replay.json).toEqual(first.json);
    expect(cards()).toHaveLength(1);
  });

  it('folds a later resize of the task into the one open notice', async () => {
    const s = await onStep('implement');
    await s.call('resize_task', {
      opId: 'op-resize-03',
      rigor: 'light',
      why: 'Smaller than it read',
    });
    await s.call('resize_task', {
      opId: 'op-resize-04',
      rigor: 'critical',
      why: 'Bigger after all',
    });
    expect(taskOf(s).rigor).toBe('critical');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.body).toContain('Critical: Bigger after all');
  });

  it.each([
    {
      name: 'a review step',
      step: 'review' as const,
      setup: () => undefined,
      says: 'Only a plan or build session can resize its task',
    },
    {
      name: 'a rigor the builder set',
      step: 'implement' as const,
      setup: (id: TaskId) => state.write((ctx) => patchTask(ctx, id, { rigor: 'light' })),
      says: "The builder set this task's rigor; carry on at Light",
    },
    {
      name: 'a rigor below the kinds’ minimum',
      step: 'implement' as const,
      setup: (id: TaskId) => {
        state.write((ctx) => {
          insertKind(ctx, { key: 'floor', label: 'Floor', minimumRigor: 'careful' });
          patchTask(ctx, id, { kinds: [{ key: 'floor', source: 'builder' }] });
        });
      },
      says: 'Floor work is at least Careful',
    },
  ])(
    'refuses $name as a result the agent reads, changing nothing',
    async ({ step, setup, says }) => {
      const s = await onStep(step);
      setup(s.task.id);
      const before = taskOf(s);
      const result = await s.call('resize_task', { opId: 'op-resize-05', rigor: 'standard', why });
      expect(result.isError).toBe(false);
      expect(result.json).toMatchObject({
        resized: false,
        message: expect.stringContaining(says) as string,
      });
      expect(taskOf(s)).toEqual(before);
      expect(cards()).toEqual([]);
    },
  );

  it('may go up from the kinds’ minimum, and not below', async () => {
    const s = await onStep('implement');
    state.write((ctx) => {
      insertKind(ctx, { key: 'floor', label: 'Floor', minimumRigor: 'careful' });
      patchTask(ctx, s.task.id, { kinds: [{ key: 'floor', source: 'builder' }] });
    });
    expect(
      (await s.call('resize_task', { opId: 'op-resize-06', rigor: 'light', why })).json,
    ).toMatchObject({ resized: false });
    expect(
      (await s.call('resize_task', { opId: 'op-resize-07', rigor: 'critical', why })).json,
    ).toMatchObject({ resized: true });
    expect(taskOf(s).rigor).toBe('critical');
  });
});

describe('file_follow_up', () => {
  const args = {
    title: 'Write the CI section of the design',
    description: 'The design stops at 300 lines; the CI section is left.',
    acceptanceCriteria: ['The CI section is written'],
  };

  it('files an Icebox task in the same project on the same landing, naming the task being worked on, once per opId', async () => {
    const s = await onStep('implement');
    const first = await s.call('file_follow_up', { opId: 'op-follow-0001', ...args });
    const retry = await s.call('file_follow_up', { opId: 'op-follow-0001', ...args });
    expect(first.isError).toBe(false);
    expect(retry.json).toEqual(first.json);
    const filed = listTasks(base.db, s.project.id).filter((t) => t.id !== s.task.id);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      title: args.title,
      status: 'open',
      boardColumnId: listBoardColumns(base.db, s.project.id)[0]?.id,
      landing: s.task.landing,
      acceptanceCriteria: args.acceptanceCriteria,
    });
    expect(filed[0]?.description).toContain(s.task.title);
    expect(filed[0]?.description).toContain(s.task.id);
    expect(filed[0]?.description).toContain('Work left from the task');
    expect(filed[0]?.description).not.toContain('Found while checking');
    expect(first.json).toEqual({ taskId: filed[0]?.id, title: args.title });
  });

  it.each(['implement', 'review'] as const)(
    'refuses a filing past the cap in one %s step, and a replayed opId still answers',
    async (role) => {
      const s = await onStep(role);
      for (let i = 0; i < MAX_FOLLOW_UPS; i += 1) {
        const ok = await s.call('file_follow_up', {
          ...args,
          opId: `op-follow-cap-${String(i).padStart(2, '0')}`,
          title: `${args.title} ${String(i)}`,
        });
        expect(ok.isError).toBe(false);
      }
      const over = await s.call('file_follow_up', { ...args, opId: 'op-follow-cap-over' });
      expect(over.isError).toBe(true);
      expect(over.text).toContain(`${String(MAX_FOLLOW_UPS)} follow-up tasks`);
      const replay = await s.call('file_follow_up', {
        ...args,
        opId: 'op-follow-cap-00',
        title: `${args.title} 0`,
      });
      expect(replay.isError).toBe(false);
      expect(listTasks(base.db, s.project.id).filter((t) => t.id !== s.task.id)).toHaveLength(
        MAX_FOLLOW_UPS,
      );
    },
  );

  const fillCap = async (s: Pick<Awaited<ReturnType<typeof connectSession>>, 'call'>) => {
    for (let i = 0; i < MAX_FOLLOW_UPS; i += 1)
      await s.call('file_follow_up', {
        ...args,
        opId: `op-follow-step-${String(i).padStart(2, '0')}`,
      });
  };

  it('counts filings per step: a second session of the same step, after a handoff, is still refused', async () => {
    const s = await onStep('implement');
    await fillCap(s);
    const next = await connectSession(s.workstream.id);
    const result = await next.call('file_follow_up', { ...args, opId: 'op-follow-step-next' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${String(MAX_FOLLOW_UPS)} follow-up tasks`);
  });

  it('counts filings per step: a session in a later step starts again', async () => {
    const s = await seedSession();
    state.write((ctx) => {
      patchWorkstream(ctx, s.workstream.id, null, {
        steps: [stepAt('implement'), stepAt('review')],
        stepIndex: 0,
      });
    });
    await fillCap(s);
    // The runner moves to the next step with its floor at the sessions so far.
    state.write((ctx) => {
      patchWorkstream(ctx, s.workstream.id, null, {
        steps: [
          { ...stepAt('implement'), status: 'done' },
          { ...stepAt('review'), sessionFloor: 1 },
        ],
        stepIndex: 1,
      });
    });
    const next = await connectSession(s.workstream.id);
    const result = await next.call('file_follow_up', { ...args, opId: 'op-follow-step-next' });
    expect(result.isError).toBe(false);
  });
});

describe('complete_step', () => {
  it('records a review verdict, and the session that gave it, on the current step once per opId', async () => {
    const s = await onStep('review');
    const first = await s.call('complete_step', {
      opId: 'op-step-0001',
      summary: 'Looks right.',
      verdict: 'approve',
    });
    const retry = await s.call('complete_step', {
      opId: 'op-step-0001',
      summary: 'Looks right.',
      verdict: 'approve',
    });
    expect(first.isError).toBe(false);
    expect(retry.json).toEqual(first.json);
    expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result).toMatchObject({
      summary: 'Looks right.',
      verdict: 'approve',
      sessionId: s.session.id,
    });
  });

  it.each([
    {
      name: 'an implement step',
      role: 'implement',
      args: { summary: 'Done.', verdict: null },
      says: 'ends by ending your turn',
    },
    {
      name: 'a review with no verdict',
      role: 'review',
      args: { summary: 'Hmm.', verdict: null },
      says: 'needs a verdict',
    },
  ] as const)('refuses $name', async ({ role, args, says }) => {
    const s = await onStep(role);
    const result = await s.call('complete_step', { opId: 'op-step-0002', ...args });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(says);
  });

  it('emits step.changed once, and not again on an opId replay', async () => {
    const s = await onStep('review');
    const args = { opId: 'op-step-0004', summary: 'Fine.', verdict: 'approve' };
    const count = () =>
      base.db
        .select()
        .from(schema.events)
        .all()
        .filter((e) => e.type === 'step.changed').length;
    const before = count();
    await s.call('complete_step', args);
    await s.call('complete_step', args);
    expect(count() - before).toBe(1);
  });

  it('stores no verdict for a plan step even when one is sent', async () => {
    const s = await onStep('plan');
    await s.call('complete_step', {
      opId: 'op-step-0005',
      summary: '1. Do it.',
      verdict: 'approve',
    });
    expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result?.verdict).toBeNull();
  });

  describe('follow-ups', () => {
    const followUps = [
      {
        title: 'Make errors name the file',
        description: 'The upload error says nothing about which file failed.',
        acceptanceCriteria: ['The error names the file'],
      },
      { title: 'Cover the empty badge', description: 'No test renders it empty.' },
    ];
    const tasksOf = (projectId: ProjectDto['id']) => listTasks(base.db, projectId);

    it('files each one as an Icebox task in the same project on the same landing, and names them in the result', async () => {
      const s = await onStep('review');
      const first = await s.call('complete_step', {
        opId: 'op-step-0010',
        summary: 'Fixed as asked.',
        verdict: 'approve',
        followUps,
      });
      expect(first.isError).toBe(false);
      const filed = tasksOf(s.project.id).filter((t) => t.id !== s.task.id);
      expect(filed.map((t) => t.title)).toEqual(followUps.map((f) => f.title));
      const icebox = listBoardColumns(base.db, s.project.id)[0];
      for (const task of filed) {
        expect(task).toMatchObject({
          projectId: s.project.id,
          status: 'open',
          boardColumnId: icebox?.id,
          landing: s.task.landing,
        });
        expect(task.description).toContain(s.task.title);
        expect(task.description).toContain(s.task.id);
      }
      expect(filed[0]?.acceptanceCriteria).toEqual(['The error names the file']);
      expect(first.json).toMatchObject({
        followUps: filed.map((t) => ({ taskId: t.id, title: t.title })),
      });
      const result = getWorkstream(base.db, s.workstream.id).steps[1]?.result;
      expect(result?.summary.startsWith('Fixed as asked.')).toBe(true);
      expect(result?.summary).toContain('Follow-up tasks filed:');
      for (const task of filed) expect(result?.summary).toContain(`${task.id} ${task.title}`);
    });

    it('files them even after the step has filed the shared cap', async () => {
      const s = await onStep('review');
      for (let i = 0; i < MAX_FOLLOW_UPS; i += 1)
        await s.call('file_follow_up', {
          opId: `op-step-cap-${String(i).padStart(2, '0')}`,
          title: `Left over ${String(i)}`,
          description: 'Not done.',
        });
      const result = await s.call('complete_step', {
        opId: 'op-step-0016',
        summary: 'Fixed as asked.',
        verdict: 'approve',
        followUps,
      });
      expect(result.isError).toBe(false);
      expect(result.json).toMatchObject({ followUps: [{}, {}] });
      expect(tasksOf(s.project.id)).toHaveLength(1 + MAX_FOLLOW_UPS + followUps.length);
    });

    it('does not use up the shared cap: the step can still file all of it afterwards', async () => {
      const s = await onStep('review');
      await s.call('complete_step', {
        opId: 'op-step-0017',
        summary: 'Fixed as asked.',
        verdict: 'approve',
        followUps,
      });
      for (let i = 0; i < MAX_FOLLOW_UPS; i += 1) {
        const filed = await s.call('file_follow_up', {
          opId: `op-step-after-${String(i).padStart(2, '0')}`,
          title: `Left over ${String(i)}`,
          description: 'Not done.',
        });
        expect(filed.isError).toBe(false);
      }
      expect(tasksOf(s.project.id)).toHaveLength(1 + followUps.length + MAX_FOLLOW_UPS);
    });

    describe('across several complete_step calls in one step', () => {
      const more = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          title: `Later finding ${String(from + i)}`,
          description: 'Found on a later call.',
        }));
      const resultOf = (s: { workstream: { id: WorkstreamId } }) =>
        getWorkstream(base.db, s.workstream.id).steps[1]?.result;

      it("keeps the earlier call's follow-ups named when a second call files more", async () => {
        const s = await onStep('review');
        await s.call('complete_step', {
          opId: 'op-step-multi-a',
          summary: 'First notes.',
          verdict: 'approve',
          followUps,
        });
        const second = await s.call('complete_step', {
          opId: 'op-step-multi-b',
          summary: 'Second notes.',
          verdict: 'approve',
          followUps: more(0, 1),
        });
        expect(second.isError).toBe(false);
        const filed = tasksOf(s.project.id).filter((t) => t.id !== s.task.id);
        expect(filed).toHaveLength(3);
        const summary = resultOf(s)?.summary ?? '';
        expect(summary.startsWith('Second notes.')).toBe(true);
        expect(summary.match(/Follow-up tasks filed:/g)).toHaveLength(1);
        for (const task of filed) expect(summary).toContain(`${task.id} ${task.title}`);
      });

      it('refuses a call that would take the step past MAX_FOLLOW_UPS, files nothing and keeps the result', async () => {
        const s = await onStep('review');
        await s.call('complete_step', {
          opId: 'op-step-multi-c',
          summary: 'First notes.',
          verdict: 'approve',
          followUps: more(0, MAX_FOLLOW_UPS - 1),
        });
        const before = resultOf(s);
        const over = await s.call('complete_step', {
          opId: 'op-step-multi-d',
          summary: 'Second notes.',
          verdict: 'approve',
          followUps: more(100, 2),
        });
        expect(over.isError).toBe(true);
        expect(over.text).toContain(String(MAX_FOLLOW_UPS));
        expect(tasksOf(s.project.id)).toHaveLength(1 + MAX_FOLLOW_UPS - 1);
        expect(resultOf(s)).toEqual(before);
        // One more fits exactly, and a call with no follow-ups is never refused.
        const fits = await s.call('complete_step', {
          opId: 'op-step-multi-e',
          summary: 'Third notes.',
          verdict: 'approve',
          followUps: more(200, 1),
        });
        expect(fits.isError).toBe(false);
        const none = await s.call('complete_step', {
          opId: 'op-step-multi-f',
          summary: 'Fourth notes.',
          verdict: 'approve',
        });
        expect(none.isError).toBe(false);
        expect(tasksOf(s.project.id)).toHaveLength(1 + MAX_FOLLOW_UPS);
        const summary = resultOf(s)?.summary ?? '';
        for (const task of tasksOf(s.project.id).filter((t) => t.id !== s.task.id))
          expect(summary).toContain(`${task.id} ${task.title}`);
      });

      it('never refuses a call with no follow-ups for the bound, however many lines the result seems to list', async () => {
        const s = await onStep('review');
        const bullets = Array.from(
          { length: MAX_FOLLOW_UPS + 5 },
          (_, i) => `- pasted ${String(i)}`,
        );
        const notes = ['1. Fine.', '', 'Follow-up tasks filed:', ...bullets].join('\n');
        const first = await s.call('complete_step', {
          opId: 'op-step-multi-n',
          summary: notes,
          verdict: 'approve',
        });
        expect(first.isError).toBe(false);
        const second = await s.call('complete_step', {
          opId: 'op-step-multi-o',
          summary: 'Replacement notes.',
          verdict: 'reject',
        });
        expect(second.isError).toBe(false);
        expect(resultOf(s)?.summary.startsWith('Replacement notes.')).toBe(true);
        expect(resultOf(s)?.verdict).toBe('reject');
        expect(tasksOf(s.project.id)).toHaveLength(1);
        // A call that files something is still bounded by what the result seems to list.
        const files = await s.call('complete_step', {
          opId: 'op-step-multi-p',
          summary: 'Third notes.',
          verdict: 'approve',
          followUps: more(0, 1),
        });
        expect(files.isError).toBe(true);
      });

      it('counts what an earlier session of the step filed against the cap', async () => {
        const s = await onStep('review');
        await s.call('complete_step', {
          opId: 'op-step-multi-g',
          summary: 'First notes.',
          verdict: 'approve',
          followUps: more(0, MAX_FOLLOW_UPS),
        });
        const rerun = await connectSession(s.workstream.id);
        const again = await rerun.call('complete_step', {
          opId: 'op-step-multi-h',
          summary: 'Second notes.',
          verdict: 'approve',
          followUps: more(100, 1),
        });
        expect(again.isError).toBe(true);
        expect(tasksOf(s.project.id)).toHaveLength(1 + MAX_FOLLOW_UPS);
      });

      it('files no follow-up the earlier session already filed when a rerun reuses its opId', async () => {
        const s = await onStep('review');
        const first = await s.call('complete_step', {
          opId: 'op-step-multi-i',
          summary: 'First notes.',
          verdict: 'reject',
          followUps,
        });
        const filedBefore = tasksOf(s.project.id).filter((t) => t.id !== s.task.id);
        const rerun = await connectSession(s.workstream.id);
        const again = await rerun.call('complete_step', {
          opId: 'op-step-multi-i',
          summary: 'Rerun notes.',
          verdict: 'approve',
          followUps: [...followUps, ...more(0, 1)],
        });
        expect(again.isError).toBe(false);
        // The verdict is the new one, and only the one follow-up the first call did not file is new.
        const result = resultOf(s);
        expect(result?.verdict).toBe('approve');
        expect(result?.summary.startsWith('Rerun notes.')).toBe(true);
        const filed = tasksOf(s.project.id).filter((t) => t.id !== s.task.id);
        expect(filed).toHaveLength(followUps.length + 1);
        expect(filed.slice(0, followUps.length)).toEqual(filedBefore);
        // The result and the reply name each follow-up once.
        for (const task of filed)
          expect(result?.summary.split(`${task.id} ${task.title}`)).toHaveLength(2);
        expect(again.json).toMatchObject({
          followUps: filed.map((t) => ({ taskId: t.id, title: t.title })),
        });
        expect(first.json).toMatchObject({
          followUps: filedBefore.map((t) => ({ taskId: t.id, title: t.title })),
        });
      });

      it('files nothing twice and stays within the bound when the step runs again before its opId is reused', async () => {
        const s = await onStep('review');
        const opId = 'op-step-multi-j';
        const firstRound = more(0, 3);
        await s.call('complete_step', {
          opId,
          summary: 'First round.',
          verdict: 'reject',
          followUps: firstRound,
        });
        // The rework ran: the review is entered again, and its result moves to `earlier`.
        state.write((ctx) => {
          const { steps } = getWorkstream(ctx.tx, s.workstream.id);
          patchWorkstream(ctx, s.workstream.id, null, {
            steps: advanceSteps(steps, 0, 1, { now: ctx.now, sessions: 2 }),
          });
        });
        expect(resultOf(s)).toBeNull();

        const secondRound = await connectSession(s.workstream.id);
        const filedNew = await secondRound.call('complete_step', {
          opId,
          summary: 'Second round.',
          verdict: 'reject',
          followUps: more(100, MAX_FOLLOW_UPS),
        });
        expect(filedNew.isError).toBe(false);
        // The list is this attempt's, so it holds a full allowance and no more. The first round's stay
        // named in the result it moved to `earlier`.
        expect(filedFollowUpLines(resultOf(s)?.summary ?? '')).toHaveLength(MAX_FOLLOW_UPS);
        const step = getWorkstream(base.db, s.workstream.id).steps[1];
        expect(filedFollowUpLines(step?.earlier[0]?.summary ?? '')).toHaveLength(firstRound.length);

        // The same opId again, resending the first round's: nothing is filed, on a full list.
        const thirdSession = await connectSession(s.workstream.id);
        const resent = await thirdSession.call('complete_step', {
          opId,
          summary: 'Resent notes.',
          verdict: 'approve',
          followUps: firstRound,
        });
        expect(resent.isError).toBe(false);
        expect(resultOf(s)?.verdict).toBe('approve');
        expect(tasksOf(s.project.id)).toHaveLength(1 + firstRound.length + MAX_FOLLOW_UPS);

        // A later call that files nothing is not refused.
        const none = await thirdSession.call('complete_step', {
          opId: 'op-step-multi-k',
          summary: 'Final notes.',
          verdict: 'reject',
        });
        expect(none.isError).toBe(false);
        const result = resultOf(s);
        expect(result?.verdict).toBe('reject');
        expect(filedFollowUpLines(result?.summary ?? '')).toHaveLength(MAX_FOLLOW_UPS);
        expect(tasksOf(s.project.id)).toHaveLength(1 + firstRound.length + MAX_FOLLOW_UPS);
      });
    });

    it('files them once on an opId replay', async () => {
      const s = await onStep('review');
      const args = { opId: 'op-step-0011', summary: 'Fine.', verdict: 'approve', followUps };
      const first = await s.call('complete_step', args);
      const retry = await s.call('complete_step', args);
      expect(retry.json).toEqual(first.json);
      expect(tasksOf(s.project.id)).toHaveLength(1 + followUps.length);
    });

    it('keeps a rejection a rejection when it also files follow-ups', async () => {
      const s = await onStep('review');
      await s.call('complete_step', {
        opId: 'op-step-0012',
        summary: '1. BLOCKING a.ts:1 still broken.',
        verdict: 'reject',
        followUps: followUps.slice(0, 1),
      });
      const result = getWorkstream(base.db, s.workstream.id).steps[1]?.result;
      expect(result?.verdict).toBe('reject');
      expect(parseFindings(result?.summary ?? '')).toHaveLength(1);
    });

    it('files no follow-ups from a plan step, and says why', async () => {
      const s = await onStep('plan');
      const result = await s.call('complete_step', {
        opId: 'op-step-0013',
        summary: '1. Do it.',
        verdict: null,
        followUps,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('review');
      expect(tasksOf(s.project.id)).toHaveLength(1);
    });

    it('records nothing when the result with its follow-up list would be too long', async () => {
      const s = await onStep('review');
      const result = await s.call('complete_step', {
        opId: 'op-step-0014',
        summary: 'x'.repeat(MAX_STEP_SUMMARY),
        verdict: 'approve',
        followUps,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('shorter');
      expect(tasksOf(s.project.id)).toHaveLength(1);
      expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result).toBeNull();
    });

    it('leaves the result as written when there are none', async () => {
      const s = await onStep('review');
      const result = await s.call('complete_step', {
        opId: 'op-step-0015',
        summary: 'Looks right.',
        verdict: 'approve',
      });
      expect(result.json).toMatchObject({ followUps: [] });
      expect(getWorkstream(base.db, s.workstream.id).steps[1]?.result?.summary).toBe(
        'Looks right.',
      );
    });
  });

  it('accepts a plan with no verdict', async () => {
    const s = await onStep('plan');
    expect(
      (await s.call('complete_step', { opId: 'op-step-0003', summary: '1. Do it.', verdict: null }))
        .isError,
    ).toBe(false);
  });
});

describe('principle proposals', () => {
  const draft = {
    statement: 'Never sleep in tests',
    kind: 'policy',
    topicKey: 'testing.no-sleeps',
    quote: 'sleeping made the suite flaky',
  };

  it('proposes a principle as a proposed record with a scope-choice card, unseen by find_knowledge until confirmed', async () => {
    const s = await seedSession();
    const { json } = await s.call('propose', {
      opId: 'op-propose-p1',
      kind: 'principle',
      title: 'No sleeps in tests',
      body: 'Two flaky runs this week came from sleeps.',
      principle: draft,
    });
    const principleId = PrincipleId.parse(json?.['principleId']);
    expect(getPrinciple(base.db, principleId)).toMatchObject({
      state: 'proposed',
      scope: 'project',
      speaker: `agent:${s.session.id}`,
      sourceQuote: 'sleeping made the suite flaky',
    });
    const cards = listInbox(base.db, { states: ['OPEN'] }).filter((c) => c.kind === 'proposal');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.options.map((o) => o.label)).toEqual([
      'accept_project',
      'accept_you',
      'reject',
    ]);
    expect(cards[0]?.recommendation).toBe('accept_project');
    expect(cards[0]?.body).toContain('Never sleep in tests');
    expect((await s.call('find_knowledge', { query: 'sleep' })).json).toMatchObject({
      principles: [],
      empty: true,
    });

    state.write((ctx) =>
      confirmPrinciple(ctx, principleId, {
        target: { scope: 'project', projectId: s.project.id },
        confirmedBy: 'me',
      }),
    );
    const found = await s.call('find_knowledge', { query: 'sleep', kind: 'principle' });
    expect(found.json).toMatchObject({
      results: [],
      principles: [
        {
          kind: 'principle',
          principleKind: 'policy',
          topicKey: 'testing.no-sleeps',
          scope: 'project',
          area: null,
        },
      ],
      empty: false,
    });
  });

  it('offers the area verdict only for a draft that names an area', async () => {
    const s = await seedSession();
    await s.call('propose', {
      opId: 'op-propose-p2',
      kind: 'principle',
      title: 'Validate at the edge',
      body: 'b',
      principle: { statement: 'Validate every request body with zod', scope: 'area', area: 'api' },
    });
    const card = listInbox(base.db, { states: ['OPEN'] }).find((c) => c.kind === 'proposal');
    expect(card?.options.map((o) => o.label)).toEqual([
      'accept_project',
      'accept_you',
      'accept_area',
      'reject',
    ]);
    expect(card?.recommendation).toBe('accept_area');
  });

  it('uses the body as the statement when a principle proposal has no draft, and records it once per opId', async () => {
    const s = await seedSession();
    const args = {
      opId: 'op-propose-p3',
      kind: 'principle',
      title: 'Small PRs',
      body: 'Prefer small pull requests',
    };
    const first = await s.call('propose', args);
    const again = await s.call('propose', args);
    expect(again.json).toEqual(first.json);
    expect(
      listInbox(base.db, { states: ['OPEN'] }).filter((c) => c.kind === 'proposal'),
    ).toHaveLength(1);
    const principle = getPrinciple(base.db, PrincipleId.parse(first.json?.['principleId']));
    expect(principle).toMatchObject({
      statement: 'Prefer small pull requests',
      kind: 'heuristic',
      topicKey: 'prefer-small-pull-requests',
    });
    expect(searchPrinciples(base.db, s.project.id, 'pull', 5)).toEqual([]);
  });

  it('names every declared kind on a principle proposal’s card, after the card’s own text', async () => {
    const s = await seedSession();
    await s.call('propose', {
      opId: 'op-propose-p5',
      kind: 'principle',
      title: 'Never log tokens',
      body: 'One reached the logs last week.',
      principle: { statement: 'Never write a token to a log' },
      kinds: ['security', 'auth', 'security'],
    });
    const card = listInbox(base.db, { states: ['OPEN'] }).find((c) => c.kind === 'proposal');
    expect(card?.body).toContain('Never write a token to a log');
    expect(card?.body).toMatch(
      /One reached the logs last week\.\n\nRaised as a card because it carries the security and auth kinds\.$/,
    );
  });

  it('adds no reason to a principle proposal’s card when it declares no kind', async () => {
    const s = await seedSession();
    await s.call('propose', {
      opId: 'op-propose-p6',
      kind: 'principle',
      title: 'Small PRs',
      body: 'Prefer small pull requests',
      kinds: [],
    });
    const card = listInbox(base.db, { states: ['OPEN'] }).find((c) => c.kind === 'proposal');
    expect(card?.body).not.toContain('Raised as a card');
  });

  it.each([
    {
      name: 'a principle draft on a task proposal',
      args: { kind: 'new_task', principle: { statement: 'x' } },
      error: 'principle',
    },
    {
      name: 'an area the project lacks',
      args: { kind: 'principle', principle: { statement: 'x', scope: 'area', area: 'billing' } },
      error: 'billing',
    },
    {
      name: 'a body too long to be a statement',
      args: { kind: 'principle', body: 'x'.repeat(501) },
      error: 'principle field',
    },
  ])('refuses $name', async ({ args, error }) => {
    const s = await seedSession();
    const result = await s.call('propose', {
      opId: 'op-propose-bad',
      title: 't',
      body: 'b',
      ...args,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(error);
    expect(listInbox(base.db, { states: ['OPEN'] })).toEqual([]);
  });

  it('keeps answering a task proposal with a null principleId', async () => {
    const s = await seedSession();
    const { json } = await s.call('propose', {
      opId: 'op-propose-t1',
      kind: 'new_task',
      title: 'Cache',
      body: 'b',
    });
    expect(json).toMatchObject({ principleId: null });
  });
});

describe('find_knowledge', () => {
  function seedRecords(projectId: ProjectDto['id']) {
    state.write((ctx) => {
      for (const n of ['one', 'two', 'three']) {
        insertDecision(ctx, {
          projectId,
          question: `Which queue for job ${n}?`,
          choice: n,
          rationale: 'r',
          decidedBy: 'me',
          scope: 'project',
          area: null,
          sourceId: insertSource(ctx, 'builder', {}),
        });
        insertPrinciple(ctx, {
          target: { scope: 'project', projectId },
          statement: `Keep queue ${n} idempotent`,
          kind: 'policy',
          topicKey: `queue.${n}`,
          status: 'confirmed',
          sourceId: insertSource(ctx, 'builder', {}),
          sourceQuote: null,
          speaker: 'me',
          confirmedBy: 'me',
        });
      }
    });
  }

  it('applies the limit to each shelf: up to that many decisions and that many principles', async () => {
    const s = await seedSession();
    seedRecords(s.project.id);
    const { json } = await s.call('find_knowledge', { query: 'queue', limit: 2 });
    expect(json?.['results']).toHaveLength(2);
    expect(json?.['principles']).toHaveLength(2);
  });

  it.each([
    { kind: 'decision', decisions: 3, principles: 0 },
    { kind: 'principle', decisions: 0, principles: 3 },
    { kind: 'any', decisions: 3, principles: 3 },
  ])('limits the search to $kind', async ({ kind, decisions, principles }) => {
    const s = await seedSession();
    seedRecords(s.project.id);
    const { json } = await s.call('find_knowledge', { query: 'queue', kind });
    expect(json?.['results']).toHaveLength(decisions);
    expect(json?.['principles']).toHaveLength(principles);
  });

  it('labels each hit with its scope and area, including the builder’s own principles', async () => {
    const s = await seedSession();
    state.write((ctx) => {
      insertPrinciple(ctx, {
        target: { scope: 'you' },
        statement: 'Name every queue',
        kind: 'heuristic',
        topicKey: 'queue.names',
        status: 'confirmed',
        sourceId: insertSource(ctx, 'builder', {}),
        sourceQuote: null,
        speaker: 'me',
        confirmedBy: 'me',
      });
      insertDecision(ctx, {
        projectId: s.project.id,
        question: 'Which queue for the api?',
        choice: 'pg-boss',
        rationale: 'r',
        decidedBy: 'me',
        scope: 'area',
        area: 'ui',
        sourceId: insertSource(ctx, 'builder', {}),
      });
    });
    const { json } = await s.call('find_knowledge', { query: 'queue' });
    expect(json).toMatchObject({
      results: [{ kind: 'decision', scope: 'area', area: 'ui' }],
      principles: [{ kind: 'principle', scope: 'you', area: null }],
    });
  });

  it('reads an answer recorded in the inbox back, at the scope the builder chose', async () => {
    const s = await seedSession();
    const { item } = inbox.ask({
      projectId: s.project.id,
      workstreamId: s.workstream.id,
      sessionId: s.session.id,
      kind: 'question',
      title: 'Which cache layer?',
      body: '',
      options: [
        { label: 'redis', description: '' },
        { label: 'memory', description: '' },
      ],
      recommendation: null,
      category: 'other',
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    });
    inbox.answer(item.id, { choice: 'memory', record: { scope: 'area', area: 'api' } });
    const { json } = await s.call('find_knowledge', { query: 'cache layer' });
    expect(json).toMatchObject({ results: [{ choice: 'memory', scope: 'area', area: 'api' }] });
  });
});

it('refuses to commit from a read-only step', async () => {
  const s = await onStep('review');
  writeRepoFile('src/api/a.ts', 'export {}\n');
  const result = await s.call('commit', {
    opId: 'op-commit-ro1',
    paths: ['src/api/a.ts'],
    message: 'Sneak',
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('read-only');
  expect(commitCount()).toBe(1);
});
