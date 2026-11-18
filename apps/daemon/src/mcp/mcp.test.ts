import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  acquireClaims,
  createTestStore,
  endSession,
  insertBatch,
  insertKind,
  insertSession,
  insertTask,
  insertWorkstream,
  patchWorkstream,
  releaseClaims,
  seedProject,
  transitionBatch,
  type Store,
} from '@10db/db';
import type { BatchId, ProjectDto, WorkstreamId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTempRepo, isolatedGitEnv, seedWorkstream } from '../../test/fixtures';
import type { DependencyChanges, MigrationsBase } from '../delivery';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { protectedPaths } from '../guard';
import { createInboxService, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { AwayLane } from '../trust';
import {
  ClaimWaits,
  createClaimDeadlockAnswers,
  createMcpHandler,
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
