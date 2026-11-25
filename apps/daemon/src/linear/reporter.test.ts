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
  findOpenByFoldKey,
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
import {
  createLinearReporter,
  HOLD_RETRY_MS,
  REPORTER_STARTER,
  type LinearReporter,
} from './reporter';
import { reporterConversations } from './reporter-conversation';
import { linearReporterFoldKey } from './reporter-inbox';
import { reporterHooks } from './reporter-owner';
import { SNAPSHOT_FIRST_LINE, SNAPSHOT_STARTER } from './snapshot';

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
/** The headers of the account's Linear entry: an Authorization one lets 10db write the comments itself. */
let linearHeaders: Record<string, string> | null = null;
/** The comments 10db wrote through its own writer, and the refusal its next write gets. */
let written: { issueId: string; body: string }[] = [];
let writeError: string | null = null;

const BODY = 'The run started on this task.';

/** Hands 10db the body, writes the comment 10db built, and names its id in the closing message. */
function recordingScript(postId: LinearPostId, closing = `${postId}: comment-1`): FakeStep[] {
  return [
    { do: 'mcp', tool: 'report_linear_post', args: { postId, body: BODY } },
    // The team key repeats across workspaces, so Linear's own id is the only one accepted.
    { do: 'tool', toolName: `${PREFIX}save_comment`, input: { issueId: 'AMP-1', body: 'x' } },
    {
      do: 'tool',
      toolName: `${PREFIX}save_comment`,
      input: { issueId: ISSUE, body: '$comment.body' },
      result: JSON.stringify({ id: 'comment-1' }),
    },
    { do: 'say', text: closing },
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
              serverKey: null,
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
                serverKey: null,
              },
            ],
          }),
      },
      commentWriter: () => ({
        postComment: (comment) => {
          written.push(comment);
          return writeError === null
            ? Promise.resolve('direct-1')
            : Promise.reject(new Error(writeError));
        },
      }),
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
              connect: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: linearHeaders },
              claudeName: null,
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
  linearHeaders = null;
  written = [];
  writeError = null;
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
        uploadPicture: (id, input) => reporter.uploadPicture(id, input),
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

const oweOne = (dedupeKey = 'run_started:1:0'): LinearPostId => {
  const row = store.write((ctx) =>
    enqueueLinearPost(ctx, {
      taskId: task.id,
      projectId: project.id,
      event: LinearEventKind.RunStarted,
      dedupeKey,
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
    book[KEY] = [
      [
        // The session reached Linear, so its failure to record spends a try.
        { do: 'tool', toolName: `${PREFIX}get_issue`, input: { id: ISSUE }, result: '{}' },
        { do: 'turn_complete' },
      ],
      recordingScript(id),
    ];
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

  it('holds the rows of a run that reached no Linear, names the account on the card, and posts them once woken', async () => {
    const id = oweOne();
    book[KEY] = [[{ do: 'turn_complete' }], recordingScript(id)];
    const first = clock.now().getTime() + 30_000;
    clock.advance(30_000);
    await expect
      .poll(() => rows()[0]?.lastError ?? null, { timeout: 10_000 })
      .toContain("Claude plan isn't signed in to Linear");
    // A hold spends no try and is due again at the hold's retry.
    expect(rows()[0]).toMatchObject({
      state: LinearPostState.Pending,
      tries: 0,
      dueAt: new Date(first + HOLD_RETRY_MS).toISOString(),
    });
    const card = () => findOpenByFoldKey(store.db, project.id, linearReporterFoldKey(project.id));
    expect(card()?.body).toContain("Claude plan isn't signed in to Linear");
    expect(card()?.body).toContain('Settings › Integrations');
    // A sign-in, a move or Linear switched on wakes the project: the held row goes out without waiting the
    // hold out. Only zero-delay timers fire here (the settle's retire, the woken arm), never the hold's retry.
    reporter.wake(project.id);
    await expect
      .poll(
        () => {
          clock.advance(0);
          return rows()[0]?.state;
        },
        { timeout: 10_000 },
      )
      .toBe(LinearPostState.Recorded);
    expect(card()).toBeUndefined();
  });

  it('does not take the account as signed out when a run that made no Linear call left nothing to hold', async () => {
    const first = oweOne();
    // The run records its row without a call the guard counts as Linear's, so nothing is left to hold.
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: first, nothingToReport: true },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    // A later update still gets a session of its own, instead of being held for a sign-in nobody lacks.
    const second = oweOne('run_started:2:0');
    book[KEY].push(recordingScript(second));
    clock.advance(30_000);
    await expect
      .poll(
        () => {
          clock.advance(0);
          return rows().find((r) => r.id === second)?.state;
        },
        { timeout: 10_000 },
      )
      .toBe(LinearPostState.Recorded);
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

  it('records a comment before Linear gets it, so a run that dies after the write never posts it twice', async () => {
    const id = oweOne();
    // The write goes out and the run ends without naming the comment's id.
    book[KEY] = [recordingScript(id, 'Done.')];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    expect(rows()[0]?.commentIds).toEqual([]);
    // Nothing is owed any more: a new daemon arms no run for it.
    await reporter.stop();
    reporter = makeReporter();
    reporter.start();
    clock.advance(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(1);
  });

  it('owes an update again when Linear refused its write, with the reason on the row', async () => {
    const id = oweOne();
    book[KEY] = [recordingScript(id, `${id}: failed: Issue not found`), recordingScript(id)];
    const first = clock.now().getTime() + 30_000;
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.tries, { timeout: 10_000 }).toBe(1);
    expect(rows()[0]).toMatchObject({
      state: LinearPostState.Pending,
      lastError: 'Issue not found',
      dueAt: new Date(first + 5 * 60_000).toISOString(),
    });
    clock.advance(5 * 60_000);
    await expect
      .poll(
        () => {
          clock.advance(0);
          return rows()[0]?.state;
        },
        { timeout: 10_000 },
      )
      .toBe(LinearPostState.Recorded);
    expect(rows()[0]?.commentIds).toEqual(['comment-1']);
  });

  it('withholds a body that carries a key, and refuses one that says nothing, with no write', async () => {
    const id = oweOne();
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'placeholder' },
        },
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'The key is sk-ant-abcdefghijklmnopqrstuvwx' },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Withheld);
    // 10db named the pattern itself, and the too-short body was refused with its reason.
    expect(rows()[0]?.withheldPattern).toBe('anthropic_key');
    const answers = adapter.observations.filter((o) => o.kind === 'mcp_result');
    expect(answers[0]?.detail).toMatchObject({ isError: true });
    expect(JSON.stringify(answers[0]?.detail)).toContain('write what the update says');
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(0);
  });

  it('writes the comment itself when the account has a Linear sign-in 10db can use, and the agent writes nothing', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    const id = oweOne();
    book[KEY] = [
      [
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY } },
        // The agent's own write is refused: 10db has made it.
        {
          do: 'tool',
          toolName: `${PREFIX}save_comment`,
          input: { issueId: ISSUE, body: BODY },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    await expect.poll(() => rows()[0]?.commentIds, { timeout: 10_000 }).toEqual(['direct-1']);
    expect(written).toHaveLength(1);
    expect(written[0]?.issueId).toBe(ISSUE);
    expect(written[0]?.body).toContain(BODY);
    expect(written[0]?.body).toContain(`10db · run_started · attempt 1 · ${id}`);
    expect(adapter.observations.filter((o) => o.kind === 'denied_by_guard')).toHaveLength(1);
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(0);
  });

  it('owes an update again when its own write is refused, and does not hold it for a sign-in', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    writeError = 'Issue not found';
    const id = oweOne();
    book[KEY] = [
      [
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY } },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.tries, { timeout: 10_000 }).toBe(1);
    expect(rows()[0]).toMatchObject({
      state: LinearPostState.Pending,
      lastError: 'Issue not found',
    });
  });

  it('reads the linked issue for a lane without writing, and says why when it cannot', async () => {
    book[`Chat: ${SNAPSHOT_STARTER}`] = [
      [
        { do: 'tool', toolName: `${PREFIX}get_issue`, input: { id: ISSUE }, result: '{}' },
        // A write is refused by the read-only guard.
        { do: 'tool', toolName: `${PREFIX}save_comment`, input: { issueId: ISSUE, body: 'x' } },
        {
          do: 'say',
          text: `${SNAPSHOT_FIRST_LINE}\nAMP-1: Add search. Blocked by AMP-2 (Backlog).`,
        },
        { do: 'turn_complete' },
      ],
      [{ do: 'turn_complete' }],
    ];
    await expect(reporter.snapshot(task.id)).resolves.toEqual({
      kind: 'read',
      text: 'AMP-1: Add search. Blocked by AMP-2 (Backlog).',
    });
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(1);
    expect(adapter.observations.filter((o) => o.kind === 'denied_by_guard')).toHaveLength(1);
    // A run that answers nothing is a missing snapshot, never a lane that waits.
    // The first run's conversation retires on the clock; the second snapshot waits for it.
    const second = reporter.snapshot(task.id);
    clock.advance(0);
    await expect(second).resolves.toEqual({
      kind: 'missing',
      reason: 'the session answered with nothing',
    });
  });
});
