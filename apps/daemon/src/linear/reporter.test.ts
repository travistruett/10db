import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  AccountKind,
  ConversationOwnerKind,
  ExternalKind,
  LinearEventKind,
  LinearPostState,
  LinearVia,
  Provider,
  type LinearPostId,
  type ProjectDto,
  type TaskDto,
} from '@10db/contracts';
import {
  createTestStore,
  enqueueLinearPost,
  insertTask,
  listLinearPosts,
  seedProject,
  setAppSetting,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createExploreEngine, type ExploreEngine } from '../conversation';
import { createEventBus, createLiveFrames, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { silentLogger } from '../log';
import { createMcpHandler, mintSessionToken } from '../mcp';
import { FakeAdapter, type FakeScriptBook } from '../sessions';
import { createLinearReporter, REPORTER_STARTER, type LinearReporter } from './reporter';
import { reporterConversations } from './reporter-conversation';
import { reporterHooks } from './reporter-owner';

// The reporter on the real pipeline: the store, the explore engine with the fake adapter, the daemon's own
// MCP endpoint and a manual clock. Only the agent is scripted.

type FakeStep = FakeScriptBook[string][number][number];

const ISSUE = 'issue-uuid-1';
const PREFIX = 'mcp__linear__';
const KEY = `Chat: ${REPORTER_STARTER}`;

let store: Store;
let closeStore: () => void;
let state: StateStore;
let project: ProjectDto;
let task: TaskDto;
let clock: ManualClock;
let engine: ExploreEngine;
let adapter: FakeAdapter;
let book: FakeScriptBook;
let mcpUrl: string;
let server: ReturnType<typeof serve>;
let reporter: LinearReporter;
let repo: { path: string; cleanup(): void };
/** Makes the next launch throw, as an account with no model to run would. */
let launchError: Error | null = null;

function recordingScript(postId: LinearPostId): FakeStep[] {
  return [
    {
      do: 'tool',
      toolName: `${PREFIX}save_comment`,
      input: { issueId: ISSUE, body: 'Run started.' },
      result: JSON.stringify({ id: 'comment-1' }),
    },
    // The team key repeats across workspaces, so Linear's own id is the only one accepted.
    { do: 'tool', toolName: `${PREFIX}save_comment`, input: { issueId: 'AMP-1', body: 'x' } },
    {
      do: 'mcp',
      tool: 'report_linear_post',
      args: {
        postIds: [postId],
        outcome: {
          state: 'recorded',
          commentIds: ['comment-1'],
          statusSet: null,
          attachmentUrl: null,
        },
      },
    },
    { do: 'turn_complete' },
  ];
}

/** A reporter over the world's store and engine, registered as the Reporter conversation's owner. */
function makeReporter(): LinearReporter {
  const made = createLinearReporter({
    state,
    clock,
    log: silentLogger,
    engine,
    conversations: reporterConversations(state),
    signIns: {
      list: () =>
        Promise.resolve({
          rows: [
            {
              accountId: project.accountId,
              accountLabel: 'Claude plan',
              via: LinearVia.Server,
              signedIn: null,
              note: null,
              unchecked: false,
            },
          ],
        }),
    },
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
  });
  engine.register(
    ConversationOwnerKind.Reporter,
    reporterHooks({
      state,
      log: silentLogger,
      mcp: { url: mcpUrl },
      runs: made,
      signIns: {
        list: () =>
          Promise.resolve({
            rows: [
              {
                accountId: project.accountId,
                accountLabel: 'Claude plan',
                via: LinearVia.Server,
                signedIn: null,
                note: null,
                unchecked: false,
              },
            ],
          }),
      },
      launch: () => {
        if (launchError !== null) throw launchError;
        return {
          cwd: repo.path,
          model: 'claude-sonnet-5-5',
          modelId: 'claude-sonnet-5-5',
          effort: 'low',
          env: {},
          account: {
            accountId: project.accountId,
            label: 'Claude plan',
            kind: AccountKind.ClaudeSubscription,
            harness: Provider.Claude,
            identity: null,
          },
        };
      },
      prepare: () =>
        Promise.resolve({
          sandbox: null,
          yourMcpServers: {
            linear: {
              connect: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: null },
              claudeOAuth: null,
              codex: {
                enabledTools: null,
                disabledTools: [],
                startupTimeoutSec: null,
                toolTimeoutSec: null,
              },
            },
          },
          credentialsExpireAt: null,
          track: () => undefined,
          release: () => Promise.resolve(),
        }),
    }),
  );
  return made;
}

beforeEach(async () => {
  launchError = null;
  ({ store, close: closeStore } = createTestStore());
  repo = tempDir('reporter');
  const bus = createEventBus();
  state = createStateStore(store, bus);
  clock = new ManualClock();
  book = {};
  adapter = new FakeAdapter(book);
  project = seedProject(store, { name: 'alpha', repoPath: repo.path });
  task = store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Add search',
      acceptanceCriteria: ['search works'],
      areas: ['api'],
      external: {
        kind: ExternalKind.Linear,
        id: 'AMP-1',
        issueId: ISSUE,
        url: 'https://linear.app/ampsio/issue/AMP-1',
      },
    }),
  ).value;
  store.write((ctx) => {
    setAppSetting(ctx, `linear-reporter.${project.id}`, { on: true, note: '' });
  });
  engine = createExploreEngine({
    state,
    adapter,
    clock,
    log: silentLogger,
    dataDir: repo.path,
    frames: createLiveFrames(),
    bus,
    mintToken: mintSessionToken,
    accountBlocked: () => null,
    defaultPauseMs: 30 * 60_000,
    withdrawCard: () => undefined,
  });
  server = serve({
    fetch: createMcpHandler({
      protectedPaths: [],
      state,
      inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
      git: createGit(),
      log: silentLogger,
      waitObserverFor: () => undefined,
      sessionSignal: () => undefined,
      askedToHandOff: () => undefined,
      // Reads the reporter at call time: a test swaps it for a new one over the same store.
      reporter: {
        reportPost: (id, input) => reporter.reportPost(id, input),
      },
    }),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  // serve() on a TCP port reports an AddressInfo once listening.
  mcpUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  reporter = makeReporter();
});

afterEach(async () => {
  await reporter.stop();
  await engine.close();
  server.close();
  repo.cleanup();
  closeStore();
});

const oweOne = (): LinearPostId => {
  const row = store.write((ctx) =>
    enqueueLinearPost(ctx, {
      taskId: task.id,
      projectId: project.id,
      event: LinearEventKind.RunStarted,
      dedupeKey: 'run_started:1:0',
      attempt: 1,
      detail: {},
      dueAt: new Date(clock.now().getTime() + 30_000).toISOString(),
    }),
  ).value;
  if (row === null) throw new Error('the row was not made');
  reporter.poke(task.id);
  return row.id;
};

const rows = () => listLinearPosts(store.db, task.id);

describe('the Linear reporter', () => {
  it('runs a pending row on a linked task after 30 s and records what the session wrote', async () => {
    const id = oweOne();
    book[KEY] = [recordingScript(id)];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    expect(rows()[0]?.commentIds).toEqual(['comment-1']);
    expect(rows()[0]?.sessionId).not.toBeNull();
    // The write by the team key was refused by the guard; the one by Linear's own id went through.
    const guarded = adapter.observations.filter((o) => o.kind === 'denied_by_guard');
    expect(guarded).toHaveLength(1);
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(1);
    // A reporter's run never holds an update drain.
    expect(engine.busy()).toEqual([]);
  });

  it('keeps a row whose session ended without recording pending, and runs it again at its backoff', async () => {
    const id = oweOne();
    book[KEY] = [[{ do: 'turn_complete' }], recordingScript(id)];
    const first = clock.now().getTime() + 30_000;
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.tries, { timeout: 10_000 }).toBe(1);
    expect(rows()[0]).toMatchObject({
      state: LinearPostState.Pending,
      dueAt: new Date(first + 5 * 60_000).toISOString(),
    });
    // A new daemon: its reporter arms the pending row from the store.
    await reporter.stop();
    reporter = makeReporter();
    reporter.start();
    clock.advance(5 * 60_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
  });

  it('fails the rows of a run whose session cannot be made, and does not run again before the backoff', async () => {
    oweOne();
    launchError = new Error('no model to run');
    const first = clock.now().getTime() + 30_000;
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.tries, { timeout: 10_000 }).toBe(1);
    expect(rows()[0]).toMatchObject({
      state: LinearPostState.Pending,
      lastError: 'no model to run',
      dueAt: new Date(first + 5 * 60_000).toISOString(),
    });
    // The settle's retire and re-arm run on the clock; the row is not due, so nothing starts again.
    clock.advance(0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(rows()[0]?.tries).toBe(1);
  });
});
