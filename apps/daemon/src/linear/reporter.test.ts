import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  AccountKind,
  ConversationOwnerKind,
  EventType,
  ExternalKind,
  LinearEventKind,
  LinearPostState,
  LinearVia,
  Provider,
  ScreenKind,
  type LinearPostId,
  type ProjectDto,
  type TaskDto,
} from '@10db/contracts';
import {
  createTestStore,
  enqueueLinearPost,
  findOpenByFoldKey,
  insertTask,
  insertTaskScreen,
  insertWorkstream,
  listLinearPosts,
  seedProject,
  setAppSetting,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createExploreEngine, type ExploreEngine } from '../conversation';
import {
  createEventBus,
  createLiveFrames,
  createStateStore,
  type EventBus,
  type StateStore,
} from '../events';
import { createGit } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import type { PicturesOutlook } from '../pictures';
import { createMcpHandler, mintSessionToken } from '../mcp';
import { FakeAdapter, type FakeScriptBook } from '../sessions';
import {
  createLinearReporter,
  HOLD_RETRY_MS,
  PICTURES_POLL_MS,
  PICTURES_WAIT_MS,
  REPORTER_STARTER,
  type LinearReporter,
} from './reporter';
import { reporterConversations } from './reporter-conversation';
import { REPORT_DELAY_MS, subscribeLinearEvents } from './reporter-events';
import { answerReporterCard, linearReporterFoldKey, ReporterChoice } from './reporter-inbox';
import { reporterHooks } from './reporter-owner';
import { LinearWriteError } from './reporter-writer';
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
let writeError: { message: string; refused: boolean; signedOut?: boolean } | null = null;
/** The pictures 10db asked Linear to prepare, and the files it sent to the signed address. */
let prepared: { filename: string; size: number }[] = [];
let sent: { url: string; method: string | undefined }[] = [];
/** What the pictures service says of the task's after picture; a test may change it as the capture goes on. */
let outlook: () => PicturesOutlook = () => ({ kind: 'none' });
let outlookCalls = 0;
let bus: EventBus;
/** The world's Inbox, wired as `daemon/start.ts` wires it: a Retry on the reporter's card wakes the reporter. */
let inbox: InboxService;

const BODY = 'The run started on this task.';

/**
 * A team's statuses as Linear's MCP server lists them: with ids, no positions, a review status before the one
 * a run starts in, and a type 10db never moves to or from.
 */
const TEAM_STATUSES = [
  { id: 'st-1', type: 'started', name: 'In Review' },
  { id: 'st-2', type: 'started', name: 'In Progress' },
  { id: 'st-3', type: 'backlog', name: 'Backlog' },
  { id: 'st-4', type: 'duplicate', name: 'Duplicate' },
  { id: 'st-5', type: 'unstarted', name: 'Todo' },
  { id: 'st-6', type: 'canceled', name: 'Canceled' },
  { id: 'st-7', type: 'completed', name: 'Done' },
];
/** What the agent read of the issue's statuses, for an update that moves one. */
const STATUS = { current: 'Backlog', statuses: TEAM_STATUSES };

/** An upload address as Linear signs it. */
const SIGNED_UPLOAD =
  'https://storage.googleapis.com/linear-uploads-c4/a/b?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=linear-server%40linear-1.iam.gserviceaccount.com%2F20261125%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Signature=ab';

/** Hands 10db the body, writes the comment 10db built, and names its id in the closing message. */
function recordingScript(postId: LinearPostId, closing = `${postId}: comment-1`): FakeStep[] {
  return [
    { do: 'mcp', tool: 'report_linear_post', args: { postId, body: BODY, status: STATUS } },
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
    inbox,
    picturesOutlook: () => {
      outlookCalls += 1;
      return outlook();
    },
    send: (url, init) => {
      sent.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        method: init?.method,
      });
      return Promise.resolve(new Response(null, { status: 200 }));
    },
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
        preparePicture: ({ filename, size }) => {
          prepared.push({ filename, size });
          return Promise.resolve({
            url: SIGNED_UPLOAD,
            headers: { 'Content-Type': 'image/png' },
            markdown: `![${filename}](https://uploads.linear.app/${filename})`,
            assetUrl: `https://uploads.linear.app/${filename}`,
          });
        },
        postComment: (comment) => {
          written.push(comment);
          return writeError === null
            ? Promise.resolve('direct-1')
            : Promise.reject(
                new LinearWriteError(writeError.message, writeError.refused, writeError.signedOut),
              );
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
  prepared = [];
  sent = [];
  outlook = () => ({ kind: 'none' });
  outlookCalls = 0;
  clock = new ManualClock();
  // The store writes on the world's clock, as the daemon's does.
  ({ store, close: closeStore } = createTestStore(() => clock.now()));
  repo = tempDir('reporter');
  bus = createEventBus();
  state = createStateStore(store, bus);
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onFlagAnswerInWrite: (ctx, item, answer) => {
      const retried = answerReporterCard(ctx, item, answer);
      return retried === null
        ? undefined
        : () => {
            reporter.wake(retried);
          };
    },
  });
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

const oweOne = (
  dedupeKey = 'run_started:1:0',
  event: LinearEventKind = LinearEventKind.RunStarted,
  {
    detail = {},
    dueInMs = 30_000,
  }: { detail?: Record<string, string | boolean | null>; dueInMs?: number } = {},
): LinearPostId => {
  const row = store.write((ctx) =>
    enqueueLinearPost(ctx, {
      taskId: task.id,
      projectId: project.id,
      event,
      dedupeKey,
      attempt: 1,
      detail,
      dueAt: new Date(clock.now().getTime() + dueInMs).toISOString(),
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

  it('moves a local landing to the review status from the statuses the agent read, and records it', async () => {
    const id = oweOne('landed:bat-1', LinearEventKind.Landed, {
      detail: { baseBranch: 'build', commit: 'a'.repeat(40), localCopy: true },
    });
    book[KEY] = [
      [
        { do: 'tool', toolName: `${PREFIX}get_issue`, input: { id: ISSUE }, result: '{}' },
        // The body alone, as an agent that skips the status reads hands it over: refused, so the move can't be skipped.
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY } },
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY, status: STATUS } },
        // The agent's own choice, not the pick: refused.
        {
          do: 'tool',
          toolName: `${PREFIX}save_issue`,
          input: { id: ISSUE, state: 'In Progress' },
        },
        {
          do: 'tool',
          toolName: `${PREFIX}save_comment`,
          input: { issueId: ISSUE, body: '$comment.body' },
          result: JSON.stringify({ id: 'comment-1' }),
        },
        {
          do: 'tool',
          toolName: `${PREFIX}save_issue`,
          input: { id: ISSUE, state: 'In Review' },
          result: '{}',
        },
        { do: 'say', text: `${id}: comment-1` },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    expect(rows()[0]?.statusSet).toBe('In Review');
    expect(rows()[0]?.commentIds).toEqual(['comment-1']);
    const results = adapter.observations.filter((o) => o.kind === 'mcp_result');
    expect(results.map((o) => o.detail['isError'])).toEqual([true, false]);
    expect(String(results[0]?.detail['text'])).toContain('list_issue_statuses');
    // 10db's answer names the comment, then the status it picked.
    expect(String(results[1]?.detail['text'])).toMatch(
      /save_comment[\s\S]*save_issue[\s\S]*In Review/,
    );
    expect(adapter.observations.filter((o) => o.kind === 'denied_by_guard')).toHaveLength(1);
  });

  it('ends a run that owes a start and a landing at the review status, from the one status read both carry', async () => {
    const started = oweOne();
    const landed = oweOne('landed:bat-1', LinearEventKind.Landed, {
      detail: { baseBranch: 'build', commit: 'a'.repeat(40), localCopy: true },
    });
    const write = (state: string): FakeStep[] => [
      {
        do: 'tool',
        toolName: `${PREFIX}save_comment`,
        input: { issueId: ISSUE, body: '$comment.body' },
        result: JSON.stringify({ id: 'comment-1' }),
      },
      {
        do: 'tool',
        toolName: `${PREFIX}save_issue`,
        input: { id: ISSUE, state },
        result: '{}',
      },
    ];
    book[KEY] = [
      [
        // The agent read the issue once, before either write: both updates say Backlog.
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: started, body: BODY, status: STATUS },
        },
        ...write('In Progress'),
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: landed, body: BODY, status: STATUS },
        },
        ...write('In Review'),
        // The run's earlier pick is behind the issue now: setting it again would move the issue backwards.
        { do: 'tool', toolName: `${PREFIX}save_issue`, input: { id: ISSUE, state: 'In Progress' } },
        { do: 'say', text: `${started}: comment-1\n${landed}: comment-1` },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    const set = () => Object.fromEntries(rows().map((r) => [r.event, r.statusSet]));
    await expect
      .poll(set, { timeout: 10_000 })
      .toEqual({ run_started: 'In Progress', landed: 'In Review' });
    expect(rows().map((r) => r.state)).toEqual([
      LinearPostState.Recorded,
      LinearPostState.Recorded,
    ]);
    const denied = adapter.observations.filter((o) => o.kind === 'denied_by_guard');
    expect(denied).toHaveLength(1);
    expect(String(denied[0]?.detail['reason'])).toContain('not a status 10db picked');
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

  it('withholds an update with nothing to report without a session, a hold or a card', async () => {
    oweOne('pr_opened:1', LinearEventKind.PrOpened, { detail: { prUrl: null } });
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Withheld);
    expect(rows()[0]).toMatchObject({
      withheldPattern: 'nothing to report',
      tries: 0,
      lastError: null,
    });
    expect(rows()[0]?.dismissedAt).not.toBeNull();
    expect(adapter.shapeSessions).toHaveLength(0);
    expect(
      findOpenByFoldKey(store.db, project.id, linearReporterFoldKey(project.id)),
    ).toBeUndefined();
  });

  it('spends a try on a run that made no Linear call after Linear answered in the conversation, and posts next time', async () => {
    book[`Chat: ${SNAPSHOT_STARTER}`] = [
      [
        { do: 'tool', toolName: `${PREFIX}get_issue`, input: { id: ISSUE }, result: '{}' },
        { do: 'say', text: `${SNAPSHOT_FIRST_LINE}\nAMP-1: Add search.` },
        { do: 'turn_complete' },
      ],
    ];
    await expect(reporter.snapshot(task.id)).resolves.toMatchObject({ kind: 'read' });
    const id = oweOne();
    // The posting turn right after the snapshot ends without a call, as the one on 2026-11-25 did.
    book[KEY] = [[{ do: 'turn_complete' }], recordingScript(id)];
    clock.advance(30_000);
    await expect
      .poll(
        () => {
          clock.advance(0);
          return rows()[0]?.tries;
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    expect(rows()[0]?.state).toBe(LinearPostState.Pending);
    expect(rows()[0]?.lastError).toContain('without calling Linear');
    expect(rows()[0]?.lastError).not.toContain("isn't signed in");
    // The account is not taken as signed out: the retry gets a session, and its write and report tools.
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
  });

  it('does not take the account as signed out when a run that made no Linear call left nothing to hold', async () => {
    const first = oweOne();
    // The run records its row without a call the guard counts as Linear's, so nothing is left to hold.
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: first, nothingToReport: true, status: STATUS },
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

  it('keeps the reason an agent gives for a failed write, and never writes that comment again', async () => {
    const id = oweOne();
    // The agent can't tell a refusal from a write Linear took but did not answer, so its word reopens nothing.
    book[KEY] = [recordingScript(id, `${id}: failed: Issue not found`), recordingScript(id)];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.lastError, { timeout: 10_000 }).toBe('Issue not found');
    expect(rows()[0]).toMatchObject({ state: LinearPostState.Recorded, tries: 0, commentIds: [] });
    clock.advance(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(1);
  });

  it('withholds a body that carries a key, and refuses one that says nothing, with no write', async () => {
    const id = oweOne();
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'placeholder', status: STATUS },
        },
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'The key is sk-ant-abcdefghijklmnopqrstuvwx', status: STATUS },
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
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY, status: STATUS } },
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
    expect(written[0]?.body).toContain('10db · run_started · attempt 1');
    expect(written[0]?.body).not.toContain(id);
    expect(adapter.observations.filter((o) => o.kind === 'denied_by_guard')).toHaveLength(1);
    expect(adapter.observations.filter((o) => o.kind === 'tool_allowed')).toHaveLength(0);
  });

  /** A kept picture of the task's home page, its file written as the pictures service writes one. */
  const keepPicture = (kind: ScreenKind, content: string): void => {
    const storedPath = join(repo.path, `${kind}.png`);
    writeFileSync(storedPath, content);
    store.write((ctx) =>
      insertTaskScreen(ctx, {
        taskId: task.id,
        turnId: null,
        kind,
        route: '/',
        viewport: { width: 1440, height: 900 },
        theme: 'default',
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
        width: 1440,
        height: 900,
        storedPath,
        keptSha: null,
      }),
    );
  };

  /** Hands 10db a body for the one owed row and lets its own write finish. */
  const endedComment = async (id: LinearPostId): Promise<string> => {
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'The run ended and its change landed.', status: STATUS },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    return written[0]?.body ?? '';
  };

  it('puts a finished task’s before and after pictures in its ended comment, uploaded by 10db, and names no pull request', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    keepPicture(ScreenKind.Before, 'before-bytes');
    keepPicture(ScreenKind.After, 'after-bytes');
    const body = await endedComment(oweOne('ended:1:0', LinearEventKind.Ended));
    expect(prepared.map((p) => p.filename)).toEqual(['1-home-before.png', '1-home-after.png']);
    expect(prepared.map((p) => p.size)).toEqual(['before-bytes'.length, 'after-bytes'.length]);
    expect(sent).toEqual([
      { url: SIGNED_UPLOAD, method: 'PUT' },
      { url: SIGNED_UPLOAD, method: 'PUT' },
    ]);
    expect(body).toContain('![1-home-before.png](https://uploads.linear.app/1-home-before.png)');
    expect(body).toContain('![1-home-after.png](https://uploads.linear.app/1-home-after.png)');
    expect(body).not.toMatch(/pull request/i);
    expect(rows()[0]?.attachmentUrl).toBe('https://uploads.linear.app/1-home-before.png');
  });

  it('says once, with the reason, that a finished task has no pictures, and never names a pull request', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    outlook = () => ({ kind: 'skipped', reason: 'The dev login command failed (exit 1)' });
    const body = await endedComment(oweOne('ended:1:0', LinearEventKind.Ended));
    expect(body).toContain(
      'No before and after pictures were taken. The dev login command failed (exit 1).',
    );
    expect(body.match(/dev login command failed/g)).toHaveLength(1);
    expect(body).not.toMatch(/pull request/i);
    expect(prepared).toEqual([]);
  });

  it('waits for a capture still running when the update comes due, and the comment carries the picture it kept', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    // The capture ends after the row first came due: its answer is "wait" once, and its after is kept as it ends.
    outlook = () => {
      if (outlookCalls > 1) return { kind: 'none' };
      keepPicture(ScreenKind.After, 'after-bytes');
      return { kind: 'wait' };
    };
    const id = oweOne('ended:1:0', LinearEventKind.Ended);
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'The run ended and its change landed.', status: STATUS },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => outlookCalls, { timeout: 10_000 }).toBeGreaterThan(0);
    // Nothing was written, and no try was spent.
    expect(written).toEqual([]);
    expect(rows()[0]).toMatchObject({ state: LinearPostState.Pending, tries: 0 });
    clock.advance(PICTURES_POLL_MS);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    expect(written[0]?.body).toContain('![1-home-after.png]');
    expect(written[0]?.body).not.toContain('still being taken');
  });

  it('stops waiting for the pictures after a bound and says they were still being taken', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    outlook = () => ({ kind: 'wait' });
    const id = oweOne('ended:1:0', LinearEventKind.Ended);
    book[KEY] = [
      [
        {
          do: 'mcp',
          tool: 'report_linear_post',
          args: { postId: id, body: 'The run ended and its change landed.', status: STATUS },
        },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => outlookCalls, { timeout: 10_000 }).toBeGreaterThan(0);
    clock.advance(PICTURES_WAIT_MS);
    await expect.poll(() => rows()[0]?.state, { timeout: 10_000 }).toBe(LinearPostState.Recorded);
    expect(written[0]?.body).toContain('still being taken');
  });

  it('owes an update again when its own write is refused, and does not hold it for a sign-in', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    writeError = { message: 'Issue not found', refused: true };
    const id = oweOne();
    book[KEY] = [
      [
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY, status: STATUS } },
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

  it.each([
    ['10db’s own write is turned away for its sign-in', 'direct'],
    ['the agent says Linear answered that it is not signed in', 'agent'],
  ] as const)('holds an update without spending a try when %s', async (_name, how) => {
    const id = oweOne();
    if (how === 'direct') {
      linearHeaders = { Authorization: 'Bearer lin_api_x' };
      writeError = { message: 'HTTP 401', refused: true, signedOut: true };
      book[KEY] = [
        [
          {
            do: 'mcp',
            tool: 'report_linear_post',
            args: { postId: id, body: BODY, status: STATUS },
          },
          { do: 'turn_complete' },
        ],
      ];
    } else {
      book[KEY] = [
        [
          // The call reaches Linear, which answers that the session must sign in.
          { do: 'tool', toolName: `${PREFIX}get_issue`, input: { id: ISSUE }, result: '{}' },
          { do: 'say', text: 'Linear asked me to sign in.\n\nLinear: not signed in' },
          { do: 'turn_complete' },
        ],
      ];
    }
    clock.advance(30_000);
    await expect
      .poll(() => rows()[0]?.lastError ?? null, { timeout: 10_000 })
      .toContain("isn't signed in to Linear");
    expect(rows()[0]).toMatchObject({ state: LinearPostState.Pending, tries: 0 });
  });

  it('retries a failed update from the card, and keeps a run’s verdict owed until it is dismissed', async () => {
    const started = oweOne();
    const verdict = oweOne('verdict:1:0', LinearEventKind.Verdict);
    const row = (id: LinearPostId) => rows().find((r) => r.id === id);
    // Every run fails to start; each settle backs both rows off, and an hour covers every backoff before the cap.
    launchError = new Error('no model to run');
    await expect
      .poll(
        () => {
          clock.advance(60 * 60_000);
          return row(started)?.state;
        },
        { timeout: 20_000 },
      )
      .toBe(LinearPostState.Failed);
    expect(row(verdict)).toMatchObject({ state: LinearPostState.Pending, tries: 5 });
    const card = () => findOpenByFoldKey(store.db, project.id, linearReporterFoldKey(project.id));
    const answer = (choice: ReporterChoice): void => {
      const open = card();
      if (open === undefined) throw new Error('the card is not open');
      inbox.answer(open.id, { choice });
    };
    expect(card()?.options.map((o) => o.label)).toEqual([
      ReporterChoice.Retry,
      ReporterChoice.Dismiss,
    ]);
    // Retry: the failed row is owed again with no try spent, and both rows are due now.
    launchError = null;
    book[KEY] = [recordingScript(started)];
    answer(ReporterChoice.Retry);
    const now = clock.now().toISOString();
    expect(row(started)).toMatchObject({ state: LinearPostState.Pending, tries: 0, dueAt: now });
    expect(row(verdict)?.dueAt).toBe(now);
    await expect
      .poll(
        () => {
          clock.advance(0);
          return row(started)?.state;
        },
        { timeout: 10_000 },
      )
      .toBe(LinearPostState.Recorded);
    // The run wrote no verdict: it fails again and is still owed.
    await expect.poll(() => row(verdict)?.tries, { timeout: 10_000 }).toBe(6);
    expect(row(verdict)?.state).toBe(LinearPostState.Pending);
    // Dismiss is the only end of a run's last update short of posting it.
    await expect.poll(() => card()?.id, { timeout: 10_000 }).toBeDefined();
    answer(ReporterChoice.Dismiss);
    expect(row(verdict)?.state).toBe(LinearPostState.Failed);
    expect(row(verdict)?.dismissedAt).not.toBeNull();
  });

  it('gives a new update the report delay even when an older row of the task is on a long backoff', () => {
    // AMP-134 got four comments in one second, 47 minutes late: new rows waited behind an older one's backoff.
    oweOne('run_started:old:0', LinearEventKind.RunStarted, { dueInMs: 2 * 60 * 60_000 });
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    const unsubscribe = subscribeLinearEvents(bus, {
      state,
      clock,
      reporter: {
        poke: (id) => {
          reporter.poke(id);
        },
        wake: (id) => {
          reporter.wake(id);
        },
      },
      log: silentLogger,
    });
    bus.publish([
      {
        seq: 1,
        type: EventType.WorkstreamChanged,
        entityType: 'workstream',
        entityId: ws.id,
        data: { from: 'QUEUED', to: 'STARTING', reason: null },
        at: clock.now().toISOString(),
      },
    ]);
    unsubscribe();
    const made = rows().find((r) => r.detail['workstreamId'] === ws.id);
    expect(made?.dueAt).toBe(new Date(clock.now().getTime() + REPORT_DELAY_MS).toISOString());
  });

  it('never writes a comment again when Linear may have taken it but did not answer', async () => {
    linearHeaders = { Authorization: 'Bearer lin_api_x' };
    writeError = { message: 'Request timed out', refused: false };
    const id = oweOne();
    book[KEY] = [
      [
        { do: 'mcp', tool: 'report_linear_post', args: { postId: id, body: BODY, status: STATUS } },
        { do: 'turn_complete' },
      ],
    ];
    clock.advance(30_000);
    await expect.poll(() => rows()[0]?.lastError, { timeout: 10_000 }).toContain('timed out');
    expect(rows()[0]).toMatchObject({ state: LinearPostState.Recorded, tries: 0, commentIds: [] });
    clock.advance(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toHaveLength(1);
    expect(rows()[0]?.state).toBe(LinearPostState.Recorded);
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

  it('records every update a run owes, however many come due together, from a script that names none', async () => {
    // A task's run raises a row per event; a script that wrote for a fixed count left the rest owed.
    book[KEY] = [
      [
        {
          do: 'each_owed',
          steps: [
            {
              do: 'mcp',
              tool: 'report_linear_post',
              args: { postId: '$post', body: BODY, status: STATUS },
            },
            {
              do: 'tool',
              // Whichever Linear server the account's agent has: the brief names its tools by full name.
              toolName: '$linear:save_comment',
              input: { issueId: ISSUE, body: '$comment.body' },
              result: JSON.stringify({ id: 'comment-1' }),
            },
            { do: 'say', text: '$post: comment-1' },
          ],
        },
        { do: 'turn_complete' },
      ],
    ];
    const kinds = [
      LinearEventKind.RunStarted,
      LinearEventKind.Waiting,
      LinearEventKind.Verdict,
      LinearEventKind.Verdict,
      LinearEventKind.Ended,
    ];
    kinds.forEach((kind, i) => oweOne(`${kind}:1:${String(i)}`, kind));
    clock.advance(30_000);
    await expect
      .poll(() => rows().map((r) => r.state), { timeout: 10_000 })
      .toEqual(kinds.map(() => LinearPostState.Recorded));
    expect(rows().map((r) => r.commentIds)).toEqual(kinds.map(() => ['comment-1']));
  });
});
