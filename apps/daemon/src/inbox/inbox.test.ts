import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CARD_PROPOSED_PRINCIPLES,
  ConflictError,
  DEFAULT_HAZARDS,
  EventType,
  InboxAnswerRefused,
  type HazardDef,
  InvalidError,
  mintId,
  PARK_TASK_CHOICE,
  ProposedPrinciples,
  STOCK_HAZARD_REVISIONS,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  WorkstreamState,
  type InboxItemDto,
  type InboxTarget,
  type ProposalId,
  type ProposalKind,
} from '@10db/contracts';
import {
  addStockHazardCommands,
  createTestStore,
  getInboxItem,
  getPrinciple,
  getProject,
  getProposal,
  getProposalDto,
  humanTouchDays,
  insertInboxItem,
  insertPermissionRule,
  insertProposal,
  insertSource,
  listDecisions,
  listEventsAfter,
  listInbox,
  listPermissionRules,
  listTasks,
  openItemsForWorkstream,
  patchProject,
  schema,
  searchDecisions,
  searchPrincipleIds,
  searchPrinciples,
  seedProject,
  transitionWorkstream,
  updateInboxItem,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createTempRepoWithOrigin, isolatedGitEnv, seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, type Git } from '../git';
import { acceptProposal, proposePrinciple } from '../knowledge';
import { silentLogger } from '../log';
import {
  allowFoundHosts,
  foundHostFile,
  listNetworkHosts,
  removeNetworkHost,
  storableRule,
} from '../permissions';
import { protectedReads, SYSTEM_DOC_ROOTS, type FileAccessContext } from '../sandbox';
import {
  createInboxService,
  createPermissionBroker,
  ParkedError,
  type InboxService,
  type WaitObserver,
} from './index';

/** A git that reads no repository: a project with no reading gets none from it. */
const NO_GIT = {
  commitAt: () => Promise.reject(new Error('no repository')),
  folderAt: () => Promise.reject(new Error('no repository')),
  fileAt: () => Promise.resolve({ kind: 'missing' as const }),
};

let close: () => void;
let state: StateStore;
let inbox: InboxService;
let parked: { target: InboxTarget; item: InboxItemDto }[];
let base: ReturnType<typeof createTestStore>['store'];

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  parked = [];
  inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => parked.push({ target, item }),
  });
});
afterEach(() => {
  close();
});

function ask(
  ctx: ReturnType<typeof seedWorkstream>,
  signal = new AbortController().signal,
  sessionId = mintId('Session'),
) {
  return inbox.ask({
    projectId: ctx.project.id,
    workstreamId: ctx.workstream.id,
    sessionId,
    kind: 'question',
    title: 'Which color?',
    body: 'For the badge',
    options: [
      { label: 'Teal', description: '' },
      { label: 'Red', description: '' },
    ],
    recommendation: 'Teal',
    category: 'design',
    urgency: 'normal',
    detail: null,
    signal,
  });
}

describe('inbox questions', () => {
  it('resolves a live waiter and records a design answer as a decision', async () => {
    const ws = seedWorkstream(base);
    const { item, answer } = ask(ws);
    const final = inbox.answer(item.id, { choice: 'Teal', note: 'brand color' });
    expect(await answer).toEqual({ choice: 'Teal', note: 'brand color' });
    expect(final.state).toBe('RESOLVED');
    expect(searchDecisions(state.db, ws.project.id, 'color', 5).map((d) => d.choice)).toEqual([
      'Teal',
    ]);
  });

  it('folds an identical question from two workstreams into one card and resumes both', async () => {
    const a = seedWorkstream(base, { title: 'A' });
    const b = seedWorkstream(base, { project: a.project, title: 'B', areas: ['ui'] });
    const first = ask(a);
    const second = ask(b);
    expect(second.item.id).toBe(first.item.id);
    expect(getInboxItem(state.db, first.item.id).targets.map((t) => t.workstreamId)).toEqual([
      a.workstream.id,
      b.workstream.id,
    ]);
    inbox.answer(first.item.id, { choice: 'Red' });
    expect(await Promise.all([first.answer, second.answer])).toEqual([
      { choice: 'Red' },
      { choice: 'Red' },
    ]);
  });

  it('hands the answer to onParkedAnswer when the session stopped waiting', async () => {
    const ws = seedWorkstream(base);
    const abort = new AbortController();
    const { item, answer } = ask(ws, abort.signal);
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    inbox.answer(item.id, { choice: 'Teal' });
    expect(parked.map((p) => p.target.workstreamId)).toEqual([ws.workstream.id]);
  });

  it('rejects a choice that is not an option, and a second answer', () => {
    const ws = seedWorkstream(base);
    const { item } = ask(ws);
    expect(() => inbox.answer(item.id, { choice: 'Purple' })).toThrow(InvalidError);
    inbox.answer(item.id, { choice: 'Teal' });
    expect(() => inbox.answer(item.id, { choice: 'Teal' })).toThrow(ConflictError);
  });

  it('redelivers an answer stuck in DELIVERING', async () => {
    const ws = seedWorkstream(base);
    // As after a restart: the session that asked is gone, so no live waiter exists.
    const abort = new AbortController();
    const { item, answer } = ask(ws, abort.signal);
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    state.write((ctx) =>
      updateInboxItem(ctx, item.id, { state: 'DELIVERING', answer: { choice: 'Teal' } }),
    );
    expect(inbox.redeliver(item.id).state).toBe('RESOLVED');
    expect(parked).toHaveLength(1);
  });

  it('never leaves an unhandled rejection when nobody awaits a parked answer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const abort = new AbortController();
      ask(seedWorkstream(base), abort.signal);
      abort.abort();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('applies a permission choice even when no session is waiting any more', async () => {
    const ws = seedWorkstream(base);
    const abort = new AbortController();
    const { item, answer } = inbox.ask({
      projectId: ws.project.id,
      workstreamId: ws.workstream.id,
      sessionId: mintId('Session'),
      kind: 'permission',
      title: 'Allow Bash?',
      body: 'docker compose up -d',
      options: [
        { label: 'allow_once', description: '' },
        { label: 'allow_workstream', description: '' },
        { label: 'allow_project', description: '' },
        { label: 'deny', description: '' },
      ],
      recommendation: null,
      category: 'environment',
      urgency: 'normal',
      detail: { toolName: 'Bash', summary: 'docker compose up -d' },
      signal: abort.signal,
    });
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    inbox.answer(item.id, { choice: 'allow_workstream' });
    const rules = listPermissionRules(state.db, ws.project.id, ws.workstream.id);
    expect(
      rules.map((r) => ({
        toolName: r.toolName,
        pattern: r.pattern,
        workstreamId: r.workstreamId,
      })),
    ).toEqual([{ toolName: 'Bash', pattern: 'docker compose', workstreamId: ws.workstream.id }]);
    expect(parked.map((p) => p.target.workstreamId)).toEqual([ws.workstream.id]);
  });

  it('records the verdict and rationale when a proposal card is answered', () => {
    const ws = seedWorkstream(base);
    const proposalId = state.write((ctx) =>
      insertProposal(ctx, {
        projectId: ws.project.id,
        kind: 'new_task',
        title: 'Add caching',
        body: 'b',
        sourceId: insertSource(ctx, 'agent', {}),
      }),
    );
    const card = state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: ws.project.id,
        kind: 'proposal',
        title: 'Add caching',
        body: 'b',
        options: [
          { label: 'accept', description: '' },
          { label: 'reject', description: '' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'low',
        detail: { proposalId },
        foldKey: null,
        targets: [],
      }),
    );
    expect(inbox.answer(card.id, { choice: 'reject', note: 'not this milestone' }).state).toBe(
      'RESOLVED',
    );
    expect(getProposal(state.db, proposalId)).toMatchObject({
      status: 'rejected',
      rationale: 'not this milestone',
    });
  });

  it('cancels a card when its only workstream is cancelled', () => {
    const ws = seedWorkstream(base);
    const { item } = ask(ws);
    inbox.cancelForWorkstream(ws.workstream.id);
    expect(getInboxItem(state.db, item.id).state).toBe('CANCELLED');
  });

  it('keeps counting a failure card that Start cancels as time the run waited on a retry', () => {
    let now = Date.parse('2026-11-03T00:30:00.000Z');
    const test = createTestStore(() => new Date(now));
    onTestFinished(test.close);
    const clocked = createStateStore(test.store, createEventBus());
    const service = createInboxService({ state: clocked, onParkedAnswer: () => undefined });
    const ws = seedWorkstream(test.store);
    const move = (to: WorkstreamState): void => {
      clocked.write((ctx) => transitionWorkstream(ctx, ws.workstream.id, { to, fence: null }));
    };
    move(WorkstreamState.Starting);
    move(WorkstreamState.Running);

    now = Date.parse('2026-11-03T01:00:00.000Z');
    move(WorkstreamState.Failed);
    const card = service.flag({
      projectId: ws.project.id,
      workstreamId: ws.workstream.id,
      title: `${WORKSTREAM_FAILED_TITLE_PREFIX}Alpha`,
      body: 'it stopped',
    });

    now = Date.parse('2026-11-03T08:00:00.000Z');
    move(WorkstreamState.Queued);
    service.cancelForWorkstream(ws.workstream.id);

    expect(getInboxItem(clocked.db, card.id)).toMatchObject({
      state: 'CANCELLED',
      targets: [{ workstreamId: ws.workstream.id }],
    });
    now = Date.parse('2026-11-03T12:00:00.000Z');
    expect(humanTouchDays(clocked.db, ws.project.id, new Date(now))[0]?.failedMinutes).toBe(420);
    expect(openItemsForWorkstream(clocked.db, ws.workstream.id)).toEqual([]);
  });

  it('keeps the minutes a lane waited on a folded card after that lane is cancelled', () => {
    let now = Date.parse('2026-11-03T00:30:00.000Z');
    const test = createTestStore(() => new Date(now));
    onTestFinished(test.close);
    const clocked = createStateStore(test.store, createEventBus());
    const service = createInboxService({ state: clocked, onParkedAnswer: () => undefined });
    const a = seedWorkstream(test.store, { title: 'A' });
    const b = seedWorkstream(test.store, { project: a.project, title: 'B' });
    const move = (id: typeof a.workstream.id, to: WorkstreamState): void => {
      clocked.write((ctx) => transitionWorkstream(ctx, id, { to, fence: null }));
    };
    for (const lane of [a, b]) {
      move(lane.workstream.id, WorkstreamState.Starting);
      move(lane.workstream.id, WorkstreamState.Running);
    }

    // Both lanes wait on one folded card from 01:00.
    now = Date.parse('2026-11-03T01:00:00.000Z');
    const askOn = (lane: typeof a) =>
      service.ask({
        projectId: lane.project.id,
        workstreamId: lane.workstream.id,
        sessionId: mintId('Session'),
        kind: 'question',
        title: 'Which color?',
        body: 'For the badge',
        options: [{ label: 'Teal', description: '' }],
        recommendation: null,
        category: 'design',
        urgency: 'normal',
        detail: null,
        signal: new AbortController().signal,
      });
    const card = askOn(a).item;
    expect(askOn(b).item.id).toBe(card.id);
    move(a.workstream.id, WorkstreamState.WaitingHuman);
    move(b.workstream.id, WorkstreamState.WaitingHuman);

    // A is cancelled at 08:00, B is answered at 10:00.
    now = Date.parse('2026-11-03T08:00:00.000Z');
    service.cancelForWorkstream(a.workstream.id);
    move(a.workstream.id, WorkstreamState.Cancelled);
    now = Date.parse('2026-11-03T10:00:00.000Z');
    service.answer(card.id, { choice: 'Teal' });
    now = Date.parse('2026-11-03T12:00:00.000Z');

    // A waited 7 hours and B 9: the card's change of targets takes nothing from A's 7.
    expect(humanTouchDays(clocked.db, a.project.id, new Date(now))[0]?.waitingMinutes).toBe(960);
  });
});

describe('proposal verdicts', () => {
  function proposalCard(
    ws: ReturnType<typeof seedWorkstream>,
    kind: ProposalKind,
    title: string,
    body: string,
    detail: Record<string, unknown> = {},
  ): { proposalId: ProposalId; card: InboxItemDto } {
    const proposalId = state.write((ctx) =>
      insertProposal(ctx, {
        projectId: ws.project.id,
        kind,
        title,
        body,
        sourceId: insertSource(ctx, 'agent', {}),
      }),
    );
    const card = state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: ws.project.id,
        kind: 'proposal',
        title,
        body,
        options: [
          { label: 'accept', description: '' },
          { label: 'reject', description: '' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'low',
        detail: { proposalId, ...detail },
        foldKey: null,
        targets: [],
      }),
    );
    return { proposalId, card };
  }
  const taskCount = (ws: ReturnType<typeof seedWorkstream>) =>
    listTasks(state.db, ws.project.id).length;

  it('files an accepted new task as an open task with the proposal title and body', () => {
    const ws = seedWorkstream(base);
    const { proposalId, card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.');
    inbox.answer(card.id, { choice: 'accept', note: 'next milestone' });
    expect(getProposal(state.db, proposalId).status).toBe('accepted');
    expect(listTasks(state.db, ws.project.id).find((t) => t.title === 'Add caching')).toMatchObject(
      { projectId: ws.project.id, description: 'Cache the query.', status: 'open' },
    );
  });

  it.each([
    ['a project whose default is a separate copy', 'pull_request', 'worktree', 'worktree'],
    ['a pull request project whose default is Your folder', 'pull_request', 'shared', 'shared'],
    ['a project with local delivery', 'local', 'shared', 'shared'],
  ] as const)(
    'files an accepted new task with the placement proposed for %s, and no reason',
    (_name, delivery, projectMode, expected) => {
      const project = seedProject(base, {
        delivery,
        workspaceMode: projectMode,
        ...(delivery === 'pull_request' ? { prTitlePrefix: 'feat(app)' } : {}),
      });
      const ws = seedWorkstream(base, { project });
      const { card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.');
      inbox.answer(card.id, { choice: 'accept' });
      expect(listTasks(state.db, project.id).find((t) => t.title === 'Add caching')).toMatchObject({
        workspaceMode: expected,
        placementReason: null,
      });
    },
  );

  it('files an accepted task with the risk tags the lane declared', () => {
    const ws = seedWorkstream(base);
    const { card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.', {
      riskTags: ['security', 'migration'],
    });
    inbox.answer(card.id, { choice: 'accept' });
    expect(listTasks(state.db, ws.project.id).find((t) => t.title === 'Add caching')).toMatchObject(
      { riskTags: ['security', 'migration'] },
    );
  });

  it('files an accepted task with no risk tags when the card declares none', () => {
    const ws = seedWorkstream(base);
    const { card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.');
    inbox.answer(card.id, { choice: 'accept' });
    expect(listTasks(state.db, ws.project.id).find((t) => t.title === 'Add caching')).toMatchObject(
      { riskTags: [] },
    );
  });

  it('ignores a card whose declared risk tags are not risk tags', () => {
    const ws = seedWorkstream(base);
    const { card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.', {
      riskTags: ['nonsense'],
    });
    inbox.answer(card.id, { choice: 'accept' });
    expect(listTasks(state.db, ws.project.id).find((t) => t.title === 'Add caching')).toMatchObject(
      { riskTags: [] },
    );
  });

  it('links the filed task to its proposal and the task.created event carries the link', () => {
    const ws = seedWorkstream(base);
    const { proposalId, card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.');
    inbox.answer(card.id, { choice: 'accept' });
    const filed = listTasks(state.db, ws.project.id).find((t) => t.title === 'Add caching');
    if (!filed) throw new Error('expected the accepted proposal to file a task');
    const linked = state.db
      .select({ id: schema.tasks.id, proposalId: schema.tasks.proposalId })
      .from(schema.tasks)
      .all()
      .find((row) => row.id === filed.id);
    expect(linked?.proposalId).toBe(proposalId);
    expect(
      listEventsAfter(state.db, 0, 1000).filter(
        (e) => e.type === EventType.TaskCreated && e.entityId === filed.id,
      ),
    ).toEqual([expect.objectContaining({ data: { projectId: ws.project.id, proposalId } })]);
  });

  it('files nothing when the proposal is rejected', () => {
    const ws = seedWorkstream(base);
    const before = taskCount(ws);
    const { proposalId, card } = proposalCard(ws, 'new_task', 'Add caching', 'Cache the query.');
    inbox.answer(card.id, { choice: 'reject', note: 'not now' });
    expect(getProposal(state.db, proposalId).status).toBe('rejected');
    expect(taskCount(ws)).toBe(before);
  });

  it.each([
    ['a change to a task', 'change_task'],
    ['a principle', 'principle'],
    ['a note', 'note'],
  ] as const)('files nothing when %s is accepted', (_name, kind) => {
    const ws = seedWorkstream(base);
    const before = taskCount(ws);
    const { proposalId, card } = proposalCard(ws, kind, 'Something', 'Body.');
    inbox.answer(card.id, { choice: 'accept' });
    expect(getProposal(state.db, proposalId).status).toBe('accepted');
    expect(taskCount(ws)).toBe(before);
  });

  it('keeps the proposal pending and its card open when the task cannot be filed', () => {
    const ws = seedWorkstream(base);
    const before = taskCount(ws);
    const { proposalId, card } = proposalCard(ws, 'new_task', '   ', 'Body.');
    expect(() => inbox.answer(card.id, { choice: 'accept' })).toThrow(InvalidError);
    expect(getProposal(state.db, proposalId).status).toBe('pending');
    expect(getInboxItem(state.db, card.id).state).toBe('OPEN');
    expect(taskCount(ws)).toBe(before);
  });
});

describe('knowledge capture', () => {
  function askIn(ws: ReturnType<typeof seedWorkstream>, category: 'design' | 'other') {
    return inbox.ask({
      projectId: ws.project.id,
      workstreamId: ws.workstream.id,
      sessionId: mintId('Session'),
      kind: 'question',
      title: 'Which queue library?',
      body: '',
      options: [
        { label: 'BullMQ', description: '' },
        { label: 'pg-boss', description: '' },
      ],
      recommendation: null,
      category,
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    }).item;
  }

  it.each([
    {
      name: 'a design answer, by default',
      category: 'design',
      record: undefined,
      scope: 'project',
      fromOther: false,
    },
    {
      name: 'an other answer, by default',
      category: 'other',
      record: undefined,
      scope: null,
      fromOther: false,
    },
    {
      name: 'a design answer told not to record',
      category: 'design',
      record: null,
      scope: null,
      fromOther: false,
    },
    {
      name: 'an other answer recorded for you',
      category: 'other',
      record: { scope: 'you', area: null },
      scope: 'you',
      fromOther: true,
    },
    {
      name: 'a design answer recorded for an area',
      category: 'design',
      record: { scope: 'area', area: 'api' },
      scope: 'area',
      fromOther: false,
    },
  ] as const)(
    'records $name, and reads it back through search',
    ({ category, record, scope, fromOther }) => {
      const ws = seedWorkstream(base);
      const other = seedWorkstream(base, { title: 'Elsewhere' }).project;
      const item = askIn(ws, category);
      inbox.answer(item.id, {
        choice: 'pg-boss',
        note: 'one database',
        ...(record === undefined ? {} : { record }),
      });
      const found = searchDecisions(state.db, ws.project.id, 'queue', 5);
      expect(found.map((d) => d.scope)).toEqual(scope === null ? [] : [scope]);
      expect(searchDecisions(state.db, other.id, 'queue', 5).length > 0).toBe(fromOther);
    },
  );

  it('labels a decision recorded for an area with that area', () => {
    const ws = seedWorkstream(base);
    inbox.answer(askIn(ws, 'design').id, {
      choice: 'pg-boss',
      record: { scope: 'area', area: 'api' },
    });
    expect(searchDecisions(state.db, ws.project.id, 'queue', 5)).toMatchObject([
      { scope: 'area', area: 'api', choice: 'pg-boss' },
    ]);
  });

  it('refuses an area the project lacks and leaves the card open', () => {
    const ws = seedWorkstream(base);
    const item = askIn(ws, 'design');
    expect(() =>
      inbox.answer(item.id, { choice: 'pg-boss', record: { scope: 'area', area: 'billing' } }),
    ).toThrow(InvalidError);
    expect(getInboxItem(state.db, item.id).state).toBe('OPEN');
    expect(listDecisions(state.db, { projectId: ws.project.id })).toEqual([]);
  });

  it('turns always and never sentences in a note into principle proposals, none of them current', () => {
    const ws = seedWorkstream(base);
    const item = askIn(ws, 'other');
    inbox.answer(item.id, {
      choice: 'pg-boss',
      note: 'Use pg-boss. Never add Redis for queues. Always keep jobs idempotent.',
    });
    const cards = listInbox(state.db, { states: ['OPEN'] }).filter((c) => c.kind === 'proposal');
    expect(cards.map((c) => c.title)).toEqual([
      'Make this a principle? Never add Redis for queues.',
      'Make this a principle? Always keep jobs idempotent.',
    ]);
    expect(cards[0]?.options.map((o) => o.label)).toEqual([
      'accept_project',
      'accept_you',
      'reject',
    ]);
    expect(searchPrinciples(state.db, ws.project.id, 'redis', 5)).toEqual([]);
    const [id] = searchPrincipleIds(state.db, {
      projectId: ws.project.id,
      query: 'redis',
      limit: 5,
      history: true,
    });
    expect(id && getPrinciple(state.db, id)).toMatchObject({
      state: 'proposed',
      kind: 'policy',
      scope: 'project',
      speaker: 'me',
      sourceQuote: 'Never add Redis for queues.',
    });
  });

  it('keeps which principles an answer proposed on the answered card', () => {
    const ws = seedWorkstream(base);
    const item = askIn(ws, 'other');
    inbox.answer(item.id, {
      choice: 'pg-boss',
      note: 'Use pg-boss. Never add Redis for queues. Always keep jobs idempotent.',
    });
    const proposed = listInbox(state.db, { states: ['OPEN'] })
      .filter((c) => c.kind === 'proposal')
      .map((c) => c.detail);
    const kept = ProposedPrinciples.parse(
      getInboxItem(state.db, item.id).detail?.[CARD_PROPOSED_PRINCIPLES],
    );
    expect(kept).toHaveLength(2);
    expect(kept).toEqual(proposed);
  });

  it('keeps nothing on a card whose answer proposed no principle', () => {
    const ws = seedWorkstream(base);
    const item = askIn(ws, 'other');
    inbox.answer(item.id, { choice: 'pg-boss', note: 'Sounds good.' });
    expect(getInboxItem(state.db, item.id).detail?.[CARD_PROPOSED_PRINCIPLES]).toBeUndefined();
  });

  it('proposes the formatter sentence from an answer, quoting it', () => {
    const ws = seedWorkstream(base);
    inbox.answer(askIn(ws, 'design').id, {
      choice: 'pg-boss',
      note: 'Fine with me, and always run the formatter before committing.',
    });
    const [id] = searchPrincipleIds(state.db, {
      projectId: ws.project.id,
      query: 'formatter',
      limit: 5,
      history: true,
    });
    expect(id && getPrinciple(state.db, id)).toMatchObject({
      state: 'proposed',
      sourceQuote: 'Fine with me, and always run the formatter before committing.',
    });
  });

  it('proposes at most three principles from one answer', () => {
    const ws = seedWorkstream(base);
    inbox.answer(askIn(ws, 'other').id, {
      choice: 'pg-boss',
      note: 'Always do A now. Always do B now. Always do C now. Always do D now.',
    });
    expect(
      listInbox(state.db, { states: ['OPEN'] }).filter((c) => c.kind === 'proposal'),
    ).toHaveLength(3);
  });

  it('proposes nothing from a note without always or never', () => {
    const ws = seedWorkstream(base);
    inbox.answer(askIn(ws, 'other').id, { choice: 'pg-boss', note: 'Sounds good.' });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
  });

  it('records no decision and proposes no principle when the answer parks the task', () => {
    const ws = seedWorkstream(base);
    const item = askIn(ws, 'design');
    inbox.answer(item.id, {
      choice: PARK_TASK_CHOICE,
      note: 'Never mind this one, always ask me later.',
      record: { scope: 'project', area: null },
    });
    expect(searchDecisions(state.db, ws.project.id, 'queue', 5)).toEqual([]);
    expect(listDecisions(state.db, { projectId: ws.project.id, history: true })).toEqual([]);
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
    expect(
      searchPrincipleIds(state.db, {
        projectId: ws.project.id,
        query: 'ask',
        limit: 5,
        history: true,
      }),
    ).toEqual([]);
  });

  function proposal(
    ws: ReturnType<typeof seedWorkstream>,
    draft: Partial<Parameters<typeof proposePrinciple>[1]['draft']> = {},
  ) {
    return state.write((ctx) =>
      proposePrinciple(ctx, {
        projectId: ws.project.id,
        title: 'No sleeps',
        body: 'b',
        draft: { statement: 'Never sleep in tests', kind: 'policy', scope: 'project', ...draft },
        sourceId: insertSource(ctx, 'agent', {}),
        speaker: 'agent:x',
      }),
    );
  }

  it.each([
    { verdict: 'accept_project', state: 'current', scope: 'project', fromOther: false },
    { verdict: 'accept_you', state: 'current', scope: 'you', fromOther: true },
    { verdict: 'accept_area', state: 'current', scope: 'area', fromOther: false },
    { verdict: 'reject', state: 'withdrawn', scope: 'area', fromOther: false },
  ] as const)(
    'applies the card verdict $verdict and reads the result back through search',
    ({ verdict, state: expected, scope, fromOther }) => {
      const ws = seedWorkstream(base);
      const other = seedWorkstream(base, { title: 'Elsewhere' }).project;
      const { principle, proposalId, card } = proposal(ws, { scope: 'area', area: 'api' });
      inbox.answer(card.id, { choice: verdict, note: 'checked' });
      expect(getPrinciple(state.db, principle.id)).toMatchObject({ state: expected, scope });
      expect(getProposalDto(state.db, proposalId).status).toBe(
        verdict === 'reject' ? 'rejected' : 'accepted',
      );
      expect(searchPrinciples(state.db, ws.project.id, 'sleep', 5).length).toBe(
        expected === 'current' ? 1 : 0,
      );
      expect(searchPrinciples(state.db, other.id, 'sleep', 5).length > 0).toBe(fromOther);
    },
  );

  it.each([
    { name: 'the answer note', note: 'we use fake timers', reason: 'we use fake timers' },
    { name: 'a default when there is no note', note: undefined, reason: 'Rejected in the Inbox' },
    { name: 'a default when the note is blank', note: '  ', reason: 'Rejected in the Inbox' },
  ])('withdraws a rejected principle with $name as the reason', ({ note, reason }) => {
    const ws = seedWorkstream(base);
    const { principle, card } = proposal(ws);
    inbox.answer(card.id, { choice: 'reject', ...(note === undefined ? {} : { note }) });
    expect(getPrinciple(state.db, principle.id)).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: reason,
    });
  });

  it('refuses a second verdict on a decided proposal and changes nothing', () => {
    const ws = seedWorkstream(base);
    const { principle, proposalId, card } = proposal(ws);
    inbox.answer(card.id, { choice: 'accept_project' });
    expect(() => state.write((ctx) => acceptProposal(ctx, proposalId, {}, 'me'))).toThrow(
      ConflictError,
    );
    expect(() => inbox.answer(card.id, { choice: 'reject' })).toThrow(ConflictError);
    expect(getPrinciple(state.db, principle.id).state).toBe('current');
    expect(getProposalDto(state.db, proposalId).status).toBe('accepted');
    expect(searchPrinciples(state.db, ws.project.id, 'sleep', 5)).toHaveLength(1);
  });

  it('keeps a card open and its principle proposed when the accepted target is refused', () => {
    const ws = seedWorkstream(base);
    const { principle, proposalId, card } = proposal(ws);
    expect(() =>
      state.write((ctx) =>
        acceptProposal(
          ctx,
          proposalId,
          { target: { scope: 'area', projectId: ws.project.id, area: 'billing' } },
          'me',
        ),
      ),
    ).toThrow(InvalidError);
    expect(getProposalDto(state.db, proposalId).status).toBe('pending');
    expect(getPrinciple(state.db, principle.id).state).toBe('proposed');
    expect(getInboxItem(state.db, card.id).state).toBe('OPEN');
    expect(searchPrinciples(state.db, ws.project.id, 'sleep', 5)).toEqual([]);
  });
});

describe('permission broker', () => {
  function broker(ws: ReturnType<typeof seedWorkstream>, events: string[] = []) {
    const observer: WaitObserver = {
      onWaitStart: () => events.push('start'),
      onWaitEnd: () => events.push('end'),
    };
    return createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer,
        signal: new AbortController().signal,
      },
    );
  }
  const request = (toolName: string, input: Record<string, unknown>, escalated = false) => ({
    toolName,
    input,
    toolUseId: 't1',
    escalated,
    signal: new AbortController().signal,
  });
  function onlyOpenCard(): InboxItemDto {
    const [card, ...rest] = listInbox(state.db, { states: ['OPEN'] });
    if (!card || rest.length > 0) throw new Error('expected exactly one open card');
    return card;
  }

  it('answers AskUserQuestion through a question card and returns the answers', async () => {
    const ws = seedWorkstream(base);
    const events: string[] = [];
    const pending = broker(
      ws,
      events,
    )(
      request('AskUserQuestion', {
        questions: [
          {
            question: 'Ship it?',
            header: 'Ship',
            options: [
              { label: 'Yes', description: '' },
              { label: 'No', description: '' },
            ],
            multiSelect: false,
          },
        ],
      }),
    );
    const card = onlyOpenCard();
    expect(card.kind).toBe('question');
    inbox.answer(card.id, { choice: 'Yes' });
    const decision = await pending;
    expect(decision.behavior === 'allow' && decision.updatedInput?.['answers']).toEqual({
      'Ship it?': 'Yes',
    });
    expect(events).toEqual(['start', 'end']);
  });

  it('writes a project rule for "always for this project" and skips the card next time', async () => {
    const ws = seedWorkstream(base);
    const decide = broker(ws);
    const pending = decide(request('Bash', { command: 'docker compose up -d' }));
    const card = onlyOpenCard();
    expect(card.kind).toBe('permission');
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([
      expect.objectContaining({ toolName: 'Bash', pattern: 'docker compose', workstreamId: null }),
    ]);
    expect(searchDecisions(state.db, ws.project.id, 'docker compose', 5)).toEqual([
      expect.objectContaining({
        question: 'Allow Bash (docker compose) in this project?',
        choice: 'Always allow',
      }),
    ]);
    expect(await decide(request('Bash', { command: 'docker compose logs' }))).toEqual({
      behavior: 'allow',
    });
  });

  it('passes the builder note back on deny', async () => {
    const ws = seedWorkstream(base);
    const pending = broker(ws)(request('WebFetch', { url: 'https://example.com' }));
    inbox.answer(onlyOpenCard().id, { choice: 'deny', note: 'use the vendored docs' });
    const decision = await pending;
    expect(decision.behavior === 'deny' && decision.message).toContain('use the vendored docs');
  });

  it('allows a call a stored rule covers, but raises a card when Claude Code escalated it', async () => {
    const ws = seedWorkstream(base);
    const decide = broker(ws);
    const first = decide(request('Bash', { command: 'pnpm test' }));
    inbox.answer(onlyOpenCard().id, { choice: 'allow_project' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await decide(request('Bash', { command: 'pnpm test --run' }))).toEqual({
      behavior: 'allow',
    });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);

    void decide(request('Bash', { command: 'pnpm test --run' }, true)).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('raises a card for an escalated call that matches the carried allow-once', () => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        signal: new AbortController().signal,
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        allowOnce: { toolName: 'Bash', summary: 'curl -s https://example.com' },
      },
    );
    void decide(request('Bash', { command: 'curl -s https://example.com' }, true)).catch(
      () => undefined,
    );
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('allows the first matching call once when an allow_once arrived after parking', async () => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        signal: new AbortController().signal,
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        allowOnce: { toolName: 'Bash', summary: 'curl -s https://example.com' },
      },
    );
    expect(await decide(request('Bash', { command: 'curl -s https://example.com' }))).toEqual({
      behavior: 'allow',
    });
    void decide(request('Bash', { command: 'curl -s https://example.com' })).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });
});

describe('inbox lifecycle guards', () => {
  it('rejects a late answer on a cancelled card and leaves it cancelled', () => {
    const ws = seedWorkstream(base);
    const { item } = ask(ws);
    inbox.cancelForWorkstream(ws.workstream.id);
    expect(() => inbox.answer(item.id, { choice: 'Teal' })).toThrow(ConflictError);
    expect(getInboxItem(state.db, item.id)).toMatchObject({ state: 'CANCELLED', answer: null });
  });

  it('refuses to overwrite a proposal that is already resolved', () => {
    const ws = seedWorkstream(base);
    const proposalId = state.write((ctx) =>
      insertProposal(ctx, {
        projectId: ws.project.id,
        kind: 'new_task',
        title: 'Add caching',
        body: 'b',
        sourceId: insertSource(ctx, 'agent', {}),
      }),
    );
    const card = () =>
      state.write((ctx) =>
        insertInboxItem(ctx, {
          projectId: ws.project.id,
          kind: 'proposal',
          title: 'Add caching',
          body: 'b',
          options: [
            { label: 'accept', description: '' },
            { label: 'reject', description: '' },
          ],
          recommendation: null,
          category: 'product',
          urgency: 'low',
          detail: { proposalId },
          foldKey: null,
          targets: [],
        }),
      );
    inbox.answer(card().id, { choice: 'accept', note: 'yes' });
    const second = card();
    expect(() => inbox.answer(second.id, { choice: 'reject', note: 'no' })).toThrow(ConflictError);
    expect(getProposal(state.db, proposalId)).toMatchObject({
      status: 'accepted',
      rationale: 'yes',
    });
    expect(getInboxItem(state.db, second.id).state).toBe('OPEN');
  });

  it('writes one workstream rule per target when a folded permission card is answered', () => {
    const a = seedWorkstream(base, { title: 'A' });
    const b = seedWorkstream(base, { project: a.project, title: 'B', areas: ['ui'] });
    const permission = (ws: typeof a) =>
      inbox.ask({
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        kind: 'permission',
        title: 'Allow Bash?',
        body: 'docker compose up -d',
        options: [
          { label: 'allow_once', description: '' },
          { label: 'allow_workstream', description: '' },
          { label: 'deny', description: '' },
        ],
        recommendation: null,
        category: 'environment',
        urgency: 'normal',
        detail: { toolName: 'Bash', summary: 'docker compose up -d' },
        signal: new AbortController().signal,
      });
    const first = permission(a);
    expect(permission(b).item.id).toBe(first.item.id);
    inbox.answer(first.item.id, { choice: 'allow_workstream' });
    expect(
      listPermissionRules(state.db, a.project.id, a.workstream.id).map((r) => r.workstreamId),
    ).toEqual([a.workstream.id]);
    expect(
      listPermissionRules(state.db, b.project.id, b.workstream.id).map((r) => r.workstreamId),
    ).toEqual([b.workstream.id]);
  });
});

describe('permission broker without a storable pattern', () => {
  it('allows once and stores no rule or decision when the command has no safe prefix', async () => {
    const ws = seedWorkstream(base);
    const observer: WaitObserver = { onWaitStart: () => undefined, onWaitEnd: () => undefined };
    const decide = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer,
        signal: new AbortController().signal,
      },
    );
    const pending = decide({
      toolName: 'Bash',
      input: { command: 'echo $HOME' },
      toolUseId: 't1',
      escalated: false,
      signal: new AbortController().signal,
    });
    const [card] = listInbox(state.db, { states: ['OPEN'] });
    if (!card) throw new Error('expected a card');
    expect(card.options.find((o) => o.label === 'allow_project')?.description).toContain(
      'only be allowed once',
    );
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([]);
    expect(searchDecisions(state.db, ws.project.id, 'allow', 5)).toEqual([]);
  });
});

describe('permission cards store scoped rules', () => {
  function permissionCard(
    ws: ReturnType<typeof seedWorkstream>,
    toolName: string,
    summary: string,
  ): InboxItemDto {
    const { item } = inbox.ask({
      projectId: ws.project.id,
      workstreamId: ws.workstream.id,
      sessionId: mintId('Session'),
      kind: 'permission',
      title: `Allow ${toolName}?`,
      body: summary,
      options: [
        { label: 'allow_once', description: '' },
        { label: 'allow_project', description: '' },
        { label: 'deny', description: '' },
      ],
      recommendation: null,
      category: 'environment',
      urgency: 'normal',
      detail: { toolName, summary },
      signal: new AbortController().signal,
    });
    return item;
  }

  it.each([
    {
      name: 'a host is stored lower-cased',
      toolName: 'SandboxNetworkAccess',
      summary: 'Registry.NPMJS.org',
      stored: { toolName: 'SandboxNetworkAccess', pattern: 'registry.npmjs.org' },
    },
    {
      name: 'a Grep approval is stored as Read, on the path',
      toolName: 'Grep',
      summary: '/work/other',
      stored: { toolName: 'Read', pattern: '/work/other' },
    },
    {
      name: 'an Edit approval is stored for the tool and the one path',
      toolName: 'Edit',
      summary: '/work/repo/.vscode/settings.json',
      stored: { toolName: 'Edit', pattern: '/work/repo/.vscode/settings.json' },
    },
  ])('$name', ({ toolName, summary, stored }) => {
    const ws = seedWorkstream(base);
    inbox.answer(permissionCard(ws, toolName, summary).id, { choice: 'allow_project' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([
      expect.objectContaining({ ...stored, workstreamId: null }),
    ]);
  });

  it.each([{ name: 'a glob path', toolName: 'Read', summary: '/work/*' }])(
    'stores nothing for $name',
    ({ toolName, summary }) => {
      const ws = seedWorkstream(base);
      inbox.answer(permissionCard(ws, toolName, summary).id, { choice: 'allow_project' });
      expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([]);
      expect(searchDecisions(state.db, ws.project.id, 'allow', 5)).toEqual([]);
    },
  );
});

describe('permission broker in a sandboxed lane', () => {
  const PNPM_BODY =
    "pnpm 12 locks its store in a /tmp directory shared with every lane and your own pnpm, which a lane can't write. Approving lets the command run, and it will fail on that lock. Run it yourself, or use npm.";
  const HOST_BODY =
    'The command was refused. Allow the host for the project and the next session gets it; allow once only reaches a session that is still running.';

  let root: string;
  let fileAccess: FileAccessContext;
  let controller: AbortController;
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), '10db-broker-')));
    const home = join(root, 'home');
    const checkout = join(root, 'work', 'repo');
    const configDir = join(home, '.claude');
    mkdirSync(join(checkout, 'src'), { recursive: true });
    mkdirSync(join(root, 'work', 'other'), { recursive: true });
    mkdirSync(join(root, 'work', 'listed'), { recursive: true });
    mkdirSync(join(configDir, 'projects', 'x', 'own-id', 'tool-results'), { recursive: true });
    mkdirSync(join(configDir, 'projects', 'x', 'other-id', 'tool-results'), { recursive: true });
    writeFileSync(join(configDir, 'projects', 'x', 'own-id', 'tool-results', 'a.txt'), '');
    writeFileSync(join(configDir, 'projects', 'x', 'other-id', 'tool-results', 'a.txt'), '');
    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(join(root, 'work', 'other', 'notes.txt'), '');
    writeFileSync(join(root, 'work', 'listed', 'notes.txt'), '');
    symlinkSync(join(root, 'work', 'other'), join(checkout, 'link-out'));
    fileAccess = {
      checkout,
      home,
      protectedReads: protectedReads({
        home,
        dataDir: join(root, 'data'),
        configDirs: [configDir],
      }),
      readList: [join(root, 'work', 'listed')],
      systemDocRoots: SYSTEM_DOC_ROOTS,
      configDir,
      providerSessionId: 'own-id',
      sandboxTemp: { root: join(root, 't'), own: join(root, 't', '10db-ownabc') },
    };
    mkdirSync(join(root, 't', '10db-ownabc'), { recursive: true });
    mkdirSync(join(root, 't', '10db-othabc'));
    writeFileSync(join(root, 't', '10db-mcp-0123456789ab.sh'), "export TOKEN='x'\n");
    writeFileSync(join(root, 't', '10db-othabc', 'notes.txt'), '');
    writeFileSync(join(root, 't', '10db-ownabc', 'notes.txt'), '');
    controller = new AbortController();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function sandboxed(
    ws: ReturnType<typeof seedWorkstream>,
    sandbox = true,
    hazards: readonly HazardDef[] = DEFAULT_HAZARDS,
    git: Pick<Git, 'commitAt' | 'folderAt' | 'fileAt'> = NO_GIT,
  ) {
    return createPermissionBroker(
      { state, inbox, git, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: controller.signal,
        ...(sandbox ? { sandbox: { fileAccess, hazards } } : {}),
      },
    );
  }
  const request = (toolName: string, input: Record<string, unknown>, escalated = false) => ({
    toolName,
    input,
    toolUseId: 't1',
    escalated,
    signal: new AbortController().signal,
  });
  const openCards = () => listInbox(state.db, { states: ['OPEN'] });
  function onlyOpenCard(): InboxItemDto {
    const [card, ...rest] = openCards();
    if (!card || rest.length > 0) throw new Error('expected exactly one open card');
    return card;
  }

  it('allows a sandboxed non-hazard command without a card', async () => {
    const ws = seedWorkstream(base);
    expect(await sandboxed(ws)(request('Bash', { command: 'pnpm test' }))).toEqual({
      behavior: 'allow',
    });
    expect(openCards()).toEqual([]);
  });

  it('cards a hazard command', async () => {
    const ws = seedWorkstream(base);
    const pending = sandboxed(ws)(request('Bash', { command: 'npm install zod' }));
    const card = onlyOpenCard();
    expect(card.detail).toEqual({ toolName: 'Bash', summary: 'npm install zod' });
    expect(card.body).toBe('npm install zod');
    inbox.answer(card.id, { choice: 'allow_once' });
    expect(await pending).toEqual({ behavior: 'allow' });
  });

  it("explains pnpm's shared store lock on a pnpm hazard card", () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request('Bash', { command: 'pnpm add zod' })).catch(() => undefined);
    const card = onlyOpenCard();
    expect(card.body).toBe(`pnpm add zod\n\n${PNPM_BODY}`);
    expect(card.detail).toEqual({ toolName: 'Bash', summary: 'pnpm add zod' });
  });

  it('keeps two different pnpm commands on two cards', () => {
    const first = seedWorkstream(base);
    const second = seedWorkstream(base, { project: first.project, title: 'Beta' });
    void sandboxed(first)(request('Bash', { command: 'pnpm add zod' })).catch(() => undefined);
    void sandboxed(second)(request('Bash', { command: 'pnpm add evil-pkg' })).catch(
      () => undefined,
    );
    expect(
      openCards()
        .map((card) => card.detail?.['summary'])
        .sort(),
    ).toEqual(['pnpm add evil-pkg', 'pnpm add zod']);
  });

  describe('in a project added before the 2026-10-31 stock commands', () => {
    const latest = new Set(Object.values(STOCK_HAZARD_REVISIONS.at(-1) ?? {}).flat());
    const stored = DEFAULT_HAZARDS.map((h) => ({
      ...h,
      commands: h.commands.filter((c) => !latest.has(c)),
    }));
    const isCard = async (ws: ReturnType<typeof seedWorkstream>, command: string) => {
      const hazards = getProject(state.db, ws.project.id).hazards;
      const pending = sandboxed(ws, true, hazards)(request('Bash', { command }));
      const card = openCards().find((c) => c.detail?.['summary'] === command);
      if (!card) return (await pending).behavior;
      inbox.answer(card.id, { choice: 'deny' });
      await pending;
      return 'card';
    };
    function oldProject(): ReturnType<typeof seedWorkstream> {
      const ws = seedWorkstream(base);
      state.write((ctx) => patchProject(ctx, ws.project.id, { hazards: stored }));
      state.write((ctx) => {
        addStockHazardCommands(ctx);
      });
      return ws;
    }

    it.each(['npm r left-pad', 'bun add x', 'pnpm add x'])(
      'cards %s as the dependency hazard',
      async (command) => {
        expect(await isCard(oldProject(), command)).toBe('card');
      },
    );

    it('keeps a command the builder removed off the list', async () => {
      const ws = oldProject();
      const trimmed = getProject(state.db, ws.project.id).hazards.map((h) =>
        h.name === 'deps' ? { ...h, commands: h.commands.filter((c) => c !== 'bun add') } : h,
      );
      state.write((ctx) => patchProject(ctx, ws.project.id, { hazards: trimmed }));
      state.write((ctx) => {
        addStockHazardCommands(ctx);
      });
      expect(getProject(state.db, ws.project.id).hazards).toEqual(trimmed);
      expect(await isCard(ws, 'bun add x')).toBe('allow');
    });
  });

  it('cards a hazard hidden in sh -c', () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request('Bash', { command: "sh -c 'pnpm add x'" })).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('cards a command the shell parser cannot read with certainty', () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request('Bash', { command: 'echo "unclosed' })).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('cards an escalated call, even one that is not a hazard', () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request('Bash', { command: 'pnpm test' }, true)).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('cards a command that starts background loops with no end, as the incident did', async () => {
    const ws = seedWorkstream(base);
    const command = 'for i in 1 2 3; do (while :; do :; done) & done; pnpm test';
    const pending = sandboxed(ws)(request('Bash', { command }));
    const card = onlyOpenCard();
    expect(card.kind).toBe('permission');
    expect(card.detail).toEqual({ toolName: 'Bash', summary: command });
    expect(card.body).toContain(command);
    expect(card.body).toContain('never ends');
    inbox.answer(card.id, { choice: 'allow_once' });
    expect(await pending).toEqual({ behavior: 'allow' });
  });

  it('cards the yes-loop form too, and passes the denial on in words that cover its equivalents', async () => {
    const ws = seedWorkstream(base);
    const pending = sandboxed(ws)(request('Bash', { command: 'yes > /dev/null &' }));
    inbox.answer(onlyOpenCard().id, { choice: 'deny', note: 'no CPU load, please' });
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
    const message = decision.behavior === 'deny' ? decision.message : '';
    expect(message).toContain('yes > /dev/null &');
    expect(message).toContain('no CPU load, please');
    expect(message).toMatch(/equivalent/i);
    expect(message).toMatch(/another (form|way)/i);
  });

  it('offers only allow-once and deny on a loop card, so no rule lets the next loop run unasked', async () => {
    const ws = seedWorkstream(base);
    const first = sandboxed(ws)(request('Bash', { command: 'yes &' }));
    const card = onlyOpenCard();
    expect(card.options.map((o) => o.label)).toEqual(['allow_once', 'deny']);
    expect(() => inbox.answer(card.id, { choice: 'allow_workstream' })).toThrow(InvalidError);
    expect(() => inbox.answer(card.id, { choice: 'allow_project' })).toThrow(InvalidError);
    inbox.answer(card.id, { choice: 'allow_once' });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([]);
    void sandboxed(ws)(request('Bash', { command: 'yes &' })).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('cards a loop even when a stored rule covers the command', () => {
    const ws = seedWorkstream(base);
    // As an answer on an ordinary card for the same command would have stored it.
    const rule = storableRule('Bash', 'yes &');
    if (rule === undefined) throw new Error('expected a storable rule');
    base.write((ctx) =>
      insertPermissionRule(ctx, {
        projectId: ws.project.id,
        workstreamId: null,
        toolName: rule.toolName,
        pattern: rule.pattern,
        sourceInboxId: null,
      }),
    );
    void sandboxed(ws)(request('Bash', { command: 'yes &' })).catch(() => undefined);
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it('does not card a loop that runs in the foreground', async () => {
    const ws = seedWorkstream(base);
    expect(await sandboxed(ws)(request('Bash', { command: 'while :; do :; done' }))).toEqual({
      behavior: 'allow',
    });
    expect(openCards()).toEqual([]);
  });

  it('cards a loop the Bash tool runs in the background itself, offering only allow-once and deny', async () => {
    const ws = seedWorkstream(base);
    const command = 'while :; do :; done';
    const pending = sandboxed(ws)(request('Bash', { command, run_in_background: true }));
    const card = onlyOpenCard();
    expect(card.options.map((o) => o.label)).toEqual(['allow_once', 'deny']);
    expect(card.detail).toEqual({ toolName: 'Bash', summary: command });
    expect(card.body).toContain(command);
    expect(card.body).toContain('never ends');
    expect(card.body).toContain('background flag');
    inbox.answer(card.id, { choice: 'deny', note: 'no busy loops' });
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' ? decision.message : '').toMatch(/equivalent/i);
  });

  const BACKGROUND_FLAG: readonly {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly outcome: 'allow' | 'card';
  }[] = [
    {
      name: 'yes, run in the background by the flag',
      input: { command: 'yes > /dev/null', run_in_background: true },
      outcome: 'card',
    },
    {
      // Claude Code may read a string flag as the boolean; the broker asks rather than miss it.
      name: 'a loop with the flag spelled as a string',
      input: { command: 'while :; do :; done', run_in_background: 'true' },
      outcome: 'card',
    },
    {
      name: 'a loop with the flag off',
      input: { command: 'while :; do :; done', run_in_background: false },
      outcome: 'allow',
    },
    {
      name: 'a dev server run in the background by the flag',
      input: { command: 'pnpm dev', run_in_background: true },
      outcome: 'allow',
    },
  ];

  it.each(BACKGROUND_FLAG)('$outcome: $name', async ({ input, outcome }) => {
    const ws = seedWorkstream(base);
    const pending = sandboxed(ws)(request('Bash', input));
    if (outcome === 'allow') {
      expect(await pending).toEqual({ behavior: 'allow' });
      expect(openCards()).toEqual([]);
      return;
    }
    void pending.catch(() => undefined);
    expect(onlyOpenCard().options.map((o) => o.label)).toEqual(['allow_once', 'deny']);
  });

  const MAKE_MIGRATE: HazardDef = {
    name: 'schema',
    globs: ['db/**'],
    commands: ['make migrate'],
  };
  const REAL_COMMAND =
    'for d in apps/desktop packages/db packages/contracts apps/daemon; do (cd $d && pnpm exec tsc --noEmit 2>&1 | grep "error TS"); done; pnpm exec eslint apps/desktop/src/views/settings packages/db/src/store packages/contracts/src apps/daemon/src/api 2>&1 | grep -v "mise WARN\\|WARN\\|ERR_PNPM\\|installing\\|Operation not\\|^$\\|Scope"';

  interface BashCase {
    readonly name: string;
    readonly command: string;
    readonly outcome: 'allow' | 'card';
    readonly escalated?: boolean;
    readonly hazards?: readonly HazardDef[];
  }
  const BASH_CASES: readonly BashCase[] = [
    // Known programs, with arguments the parser cannot read: no card.
    { name: 'the real tsc and eslint loop', command: REAL_COMMAND, outcome: 'allow' },
    { name: 'cd into a variable, then make', command: 'cd $d && make test', outcome: 'allow' },
    { name: 'a loop over a glob', command: 'for f in *.ts; do eslint $f; done', outcome: 'allow' },
    {
      name: 'a subshell after do',
      command: 'for d in a b; do (cd $d && ls); done',
      outcome: 'allow',
    },
    { name: 'a subshell after then', command: 'if true; then (cd $d && ls); fi', outcome: 'allow' },
    { name: 'a variable argument to echo', command: 'echo "$HOME" "$(date)"', outcome: 'allow' },
    // A word the shell fills in, only as an argument to a fixed pnpm script or program.
    { name: 'a variable after pnpm test', command: 'pnpm test $x', outcome: 'allow' },
    { name: 'pnpm exec of a known tool', command: 'pnpm exec tsc $x', outcome: 'allow' },
    {
      name: 'a variable after a filtered script',
      command: 'pnpm --filter @10db/daemon test $x',
      outcome: 'allow',
    },
    // A word that can pick the program or pnpm's subcommand.
    { name: 'a glob argument to pnpm run', command: 'pnpm run build *.ts', outcome: 'card' },
    { name: 'a variable as the pnpm subcommand', command: 'pnpm $SUB x', outcome: 'card' },
    { name: 'a variable after pnpm exec', command: 'pnpm exec $X y', outcome: 'card' },
    { name: 'a variable program with add', command: '$P add z', outcome: 'card' },
    {
      name: 'a redirection after the command',
      command: 'pnpm test 2>&1 | grep $x',
      outcome: 'allow',
    },
    {
      name: 'a substitution in an argument to a known program',
      command: 'git log --since="$(date)"',
      outcome: 'allow',
    },
    { name: 'sh -c with a literal safe script', command: "sh -c 'echo hi'", outcome: 'allow' },
    {
      name: 'sh -c whose script holds an expansion the outer shell may fill in',
      command: "sh -c 'echo $HOME'",
      outcome: 'card',
    },
    { name: 'a data here-document', command: 'cat <<EOF\nit is $HOME\nEOF', outcome: 'allow' },
    {
      name: 'make with an unread target and no make hazard',
      command: 'make $target',
      outcome: 'allow',
    },
    // An unread program name.
    { name: 'a variable as the program', command: '$CMD --help', outcome: 'card' },
    { name: 'a quoted variable as the program', command: '"$CMD" --help', outcome: 'card' },
    {
      name: 'a substitution as the program',
      command: '$(echo pnpm) add left-pad',
      outcome: 'card',
    },
    { name: 'a backtick as the program', command: '`which pnpm` add x', outcome: 'card' },
    { name: 'a glob as the program', command: '/usr/bin/p?pm add x', outcome: 'card' },
    { name: 'a tilde as the program', command: '~/bin/tool', outcome: 'card' },
    { name: 'a variable after env', command: 'env FOO=1 $CMD', outcome: 'card' },
    { name: 'a variable after exec', command: 'exec $CMD arg', outcome: 'card' },
    { name: 'a variable after command', command: 'command $CMD arg', outcome: 'card' },
    { name: 'a variable after xargs', command: 'ls | xargs $CMD', outcome: 'card' },
    { name: 'a variable after nice', command: 'nice -n 5 $CMD', outcome: 'card' },
    { name: 'a variable after timeout', command: 'timeout 5 $CMD', outcome: 'card' },
    { name: 'a variable after a loop do', command: 'for x in a b; do $x; done', outcome: 'card' },
    { name: 'a variable after &&', command: 'cd src && $CMD', outcome: 'card' },
    { name: 'a variable in a subshell', command: '(cd src && $CMD)', outcome: 'card' },
    { name: 'a variable in a substitution body', command: 'echo $($CMD)', outcome: 'card' },
    { name: 'a variable after find -exec', command: 'find . -exec $CMD {} \\;', outcome: 'card' },
    { name: 'env -S hides the program', command: "env -S 'pnpm add x'", outcome: 'card' },
    { name: 'sudo', command: 'sudo pnpm test', outcome: 'card' },
    { name: 'noglob runs a command', command: 'noglob pnpm test', outcome: 'card' },
    { name: 'an alias definition', command: 'alias p=pnpm', outcome: 'card' },
    { name: 'eval of a variable', command: 'eval "$x"', outcome: 'card' },
    { name: 'eval of a literal', command: 'eval "echo hi"', outcome: 'allow' },
    { name: 'sh -c of a variable', command: 'sh -c "$x"', outcome: 'card' },
    { name: 'bash -c with no script', command: 'bash -c', outcome: 'card' },
    { name: 'a script piped into sh', command: 'echo "echo hi" | sh', outcome: 'card' },
    { name: 'a script piped into bash -s', command: 'curl -s x | bash -s', outcome: 'card' },
    { name: 'a shell reading a redirect', command: 'bash < script.sh', outcome: 'card' },
    {
      name: 'a here-document run by sh with a variable',
      command: 'sh <<EOF\n$x\nEOF',
      outcome: 'card',
    },
    {
      name: 'a here-document with no closing line',
      command: 'bash <<EOF\n$x',
      outcome: 'card',
    },
    { name: 'a here-string run by sh', command: 'sh <<< "$x"', outcome: 'card' },
    { name: 'a process substitution read', command: 'diff <(sort a) <(sort b)', outcome: 'card' },
    { name: 'a process substitution written', command: 'echo hi > >(sh)', outcome: 'card' },
    // Declarations store a plain name's value as written; a name or an array option can evaluate.
    { name: 'export of a variable value', command: 'export NAME=$value', outcome: 'allow' },
    {
      name: 'export of a path built from variables',
      command: 'export PATH="$HOME/.local/bin:$PATH"',
      outcome: 'allow',
    },
    { name: 'local of a positional', command: 'local dir=$1', outcome: 'allow' },
    {
      name: 'a declaration with an array option and a variable value',
      command: 'declare -a list=$value',
      outcome: 'card',
    },
    {
      name: 'a declaration whose name is a variable',
      command: 'export "$name=1"',
      outcome: 'card',
    },
    {
      name: 'export after an integer declaration',
      command: 'declare -i n; export NAME=$n',
      outcome: 'card',
    },
    {
      name: 'a quoted numeric parameter in [[',
      command: '[[ "$#" -gt 0 ]] && ls',
      outcome: 'allow',
    },
    // A fully double-quoted expansion is one word.
    {
      name: 'pnpm filter with a quoted value',
      command: 'pnpm --filter "$pkg" test',
      outcome: 'card',
    },
    {
      name: 'pnpm filter= with a quoted value',
      command: 'pnpm --filter="$pkg" test',
      outcome: 'card',
    },
    { name: 'pnpm -F with a quoted value', command: 'pnpm -F "$p" test', outcome: 'card' },
    {
      name: 'a loop of pnpm filters',
      command: 'for p in daemon desktop; do pnpm --filter "@10db/$p" test; done',
      outcome: 'card',
    },
    { name: 'a quoted word could be the subcommand', command: 'pnpm "$x"', outcome: 'card' },
    { name: 'all positional parameters', command: 'pnpm "$@"', outcome: 'card' },
    { name: 'every array element', command: 'pnpm "${args[@]}"', outcome: 'card' },
    {
      name: 'a quoted filter, then a hazard in plain view',
      command: 'pnpm --filter "$pkg" add zod',
      outcome: 'card',
    },
    // Flags that take a value are per program.
    { name: 'npm -p before install', command: 'npm -p install x', outcome: 'card' },
    {
      name: 'pnpm --reporter before add',
      command: 'pnpm --reporter silent add x',
      outcome: 'card',
    },
    { name: 'cargo toolchain before add', command: 'cargo +stable add serde', outcome: 'card' },
    { name: 'pnpm --reporter value', command: 'pnpm --reporter silent test', outcome: 'allow' },
    { name: 'pnpm --filter value named add', command: 'pnpm --filter add test', outcome: 'allow' },
    {
      name: 'an unknown npm flag before install',
      command: 'npm --frobnicate install',
      outcome: 'card',
    },
    // Runners the scan reads through.
    { name: 'mise x runs a hazard', command: 'mise x -- pnpm add x', outcome: 'card' },
    {
      name: 'mise exec runs a hazard',
      command: 'mise exec node@22 -- pnpm add x',
      outcome: 'card',
    },
    { name: 'corepack runs a hazard', command: 'corepack pnpm add x', outcome: 'card' },
    { name: 'arch runs a hazard', command: 'arch -arm64 pnpm add x', outcome: 'card' },
    { name: 'script runs a hazard', command: 'script -q /dev/null pnpm add x', outcome: 'card' },
    { name: 'mise exec runs a safe command', command: 'mise exec -- pnpm test', outcome: 'allow' },
    { name: 'corepack runs a safe command', command: 'corepack pnpm test', outcome: 'allow' },
    { name: 'arch runs a safe command', command: 'arch -arm64 pnpm test', outcome: 'allow' },
    {
      name: 'script runs a safe command',
      command: 'script -q /dev/null pnpm test',
      outcome: 'allow',
    },
    { name: 'mise x runs a variable program', command: 'mise x -- $CMD', outcome: 'card' },
    // An argument that could select a hazard form of a program that has one.
    { name: 'pnpm with a variable', command: 'pnpm $x', outcome: 'card' },
    { name: 'pnpm with a variable and more', command: 'pnpm $x test', outcome: 'card' },
    { name: 'pnpm after a flag with a variable', command: 'pnpm -r $x', outcome: 'card' },
    {
      name: 'pnpm filter value with a variable',
      command: 'pnpm --filter $pkg test',
      outcome: 'card',
    },
    { name: 'pnpm with a glob', command: 'pnpm a*', outcome: 'card' },
    { name: 'pnpm with a substitution', command: 'pnpm $(echo add) x', outcome: 'card' },
    { name: 'pnpm exec with a variable', command: 'pnpm exec $x', outcome: 'card' },
    { name: 'pnpm dlx with a variable', command: 'pnpm dlx $x', outcome: 'card' },
    {
      name: 'a variable where pnpm exec could go',
      command: 'pnpm $x drizzle-kit generate',
      outcome: 'card',
    },
    { name: 'npx with a variable', command: 'npx $x', outcome: 'card' },
    { name: 'npm with a variable', command: 'npm $x', outcome: 'card' },
    { name: 'npm exec with a variable', command: 'npm exec $x', outcome: 'card' },
    { name: 'cargo with a variable', command: 'cargo $x', outcome: 'card' },
    { name: 'drizzle-kit with a variable', command: 'drizzle-kit $x', outcome: 'card' },
    {
      name: 'pnpm exec drizzle-kit with a variable',
      command: 'pnpm exec drizzle-kit $x',
      outcome: 'card',
    },
    {
      name: 'a path-named pnpm with a variable',
      command: '/opt/homebrew/bin/pnpm $x',
      outcome: 'card',
    },
    { name: 'pnpm behind env with a variable', command: 'env CI=1 pnpm $x', outcome: 'card' },
    {
      name: 'pnpm behind xargs takes its words from stdin',
      command: 'echo add | xargs pnpm',
      outcome: 'card',
    },
    {
      name: 'pnpm behind find -exec with a variable',
      command: 'find . -exec pnpm $x \\;',
      outcome: 'card',
    },
    { name: 'pnpm in a substitution with a variable', command: 'echo $(pnpm $x)', outcome: 'card' },
    { name: 'pnpm in sh -c with a variable', command: "sh -c 'pnpm $x'", outcome: 'card' },
    {
      name: 'pnpm after a redirection hides the subcommand',
      command: 'pnpm 2>/dev/null add x',
      outcome: 'card',
    },
    {
      name: 'a project hazard program with a variable',
      command: 'make $target',
      outcome: 'card',
      hazards: [MAKE_MIGRATE],
    },
    {
      name: 'a project hazard program, a flag value variable',
      command: 'make -C $dir migrate',
      outcome: 'card',
      hazards: [MAKE_MIGRATE],
    },
    { name: 'a project hazard', command: 'make migrate', outcome: 'card', hazards: [MAKE_MIGRATE] },
    {
      name: 'a project hazard program, a safe target',
      command: 'make test',
      outcome: 'allow',
      hazards: [MAKE_MIGRATE],
    },
    {
      name: 'a project hazard program, a safe target and a variable before it',
      command: 'cd $d && make test',
      outcome: 'allow',
      hazards: [MAKE_MIGRATE],
    },
    { name: 'a project with no hazards', command: 'pnpm $x', outcome: 'allow', hazards: [] },
    // Hazards read with certainty, as before.
    { name: 'npm install', command: 'npm install', outcome: 'card' },
    { name: 'pnpm add', command: 'pnpm add x', outcome: 'card' },
    { name: 'pnpm add after a cd to a variable', command: 'cd $d && pnpm add x', outcome: 'card' },
    {
      name: 'pnpm add in a loop',
      command: 'for d in a b; do (cd $d && pnpm add x); done',
      outcome: 'card',
    },
    { name: 'a hazard in bash -c', command: 'bash -c "pnpm add x"', outcome: 'card' },
    { name: 'a hazard in a substitution', command: 'echo $(pnpm add x)', outcome: 'card' },
    {
      name: 'a hazard in a here-document',
      command: 'bash <<EOF\npnpm add x\nEOF',
      outcome: 'card',
    },
    { name: 'a hazard in find -exec', command: 'find . -exec pnpm add x \\;', outcome: 'card' },
    // Bypasses of the unread-argument scan.
    { name: 'bash -c -e with a variable', command: 'bash -c -e "$CMD"', outcome: 'card' },
    { name: 'sh -c -- with a variable', command: 'sh -c -- "$CMD"', outcome: 'card' },
    { name: 'zsh -c -e with a hazard', command: "zsh -c -e 'pnpm add left-pad'", outcome: 'card' },
    { name: 'bash -c -e with an expansion', command: "bash -c -e 'pnpm $x'", outcome: 'card' },
    {
      name: 'bash -c -o x with a hazard',
      command: "bash -c -o pipefail 'pnpm add left-pad'",
      outcome: 'card',
    },
    {
      name: 'xargs -I into sh -c',
      command: "echo 'pnpm add left-pad' | xargs -I X sh -c X",
      outcome: 'card',
    },
    {
      name: 'xargs -J into sh -c',
      command: "echo 'pnpm add left-pad' | xargs -J X sh -c X",
      outcome: 'card',
    },
    {
      name: 'xargs -I replacing an argument',
      command: 'echo add | xargs -I X pnpm X left-pad',
      outcome: 'card',
    },
    {
      name: 'xargs -J replacing an argument',
      command: 'echo left-pad | xargs -J % pnpm add %',
      outcome: 'card',
    },
    {
      name: 'xargs -I replacing the program',
      command: 'echo pnpm | xargs -I X X add left-pad',
      outcome: 'card',
    },
    {
      name: 'xargs with a long value flag',
      command: 'xargs --max-procs 1 pnpm add left-pad',
      outcome: 'card',
    },
    {
      name: 'xargs with an unknown long flag',
      command: 'xargs --frobnicate pnpm test',
      outcome: 'card',
    },
    { name: 'a here-string on fd 3', command: 'bash /dev/fd/3 3<<<"$CMD"', outcome: 'card' },
    {
      name: 'a here-string on fd 0',
      command: "bash /dev/stdin 0<<<'pnpm add left-pad'",
      outcome: 'card',
    },
    { name: 'a second here-string', command: 'bash <<< true <<< "$CMD"', outcome: 'card' },
    { name: 'trap with a variable', command: 'trap "$CMD" EXIT', outcome: 'card' },
    { name: 'trap with a hazard', command: "trap 'pnpm add left-pad' EXIT", outcome: 'card' },
    { name: 'dot of stdin', command: '. /dev/stdin <<< "$CMD"', outcome: 'card' },
    {
      name: 'source of stdin',
      command: "source /dev/stdin <<< 'pnpm add left-pad'",
      outcome: 'card',
    },
    {
      name: 'hash -p then the name',
      command: 'hash -p /opt/homebrew/bin/pnpm ls; ls add left-pad',
      outcome: 'card',
    },
    {
      name: 'hash name=path then the name',
      command: 'hash ls=/opt/homebrew/bin/pnpm; ls add left-pad',
      outcome: 'card',
    },
    {
      name: 'read with a subscript substitution',
      command: "read 'a[$(pnpm add left-pad)]' <<< x",
      outcome: 'card',
    },
    {
      name: 'a test -v subscript substitution',
      command: "[[ -v 'a[$(pnpm add left-pad)]' ]]",
      outcome: 'card',
    },
    { name: 'an expanded path ending in done', command: '$D/done add left-pad', outcome: 'card' },
    { name: 'a glob path ending in fi', command: '/x/*/fi add left-pad', outcome: 'card' },
    { name: 'bash -c with a lone dash', command: 'bash -c - "$CMD"', outcome: 'card' },
    {
      name: 'bash -c with a lone dash and a hazard',
      command: "bash -c - 'pnpm add left-pad'",
      outcome: 'card',
    },
    {
      name: 'xargs named as an argument, replacing',
      command: 'echo add | xargs -I X echo xargs; xargs -I X pnpm X left-pad',
      outcome: 'card',
    },
    {
      name: 'a second xargs wrapper',
      command: 'echo add | xargs xargs -I X pnpm X left-pad',
      outcome: 'card',
    },
    {
      name: 'source of a double-slash stdin',
      command: "source //dev/stdin <<< 'pnpm add left-pad'",
      outcome: 'card',
    },
    { name: 'source of a dotted stdin', command: '. /./dev/stdin <<< "$CMD"', outcome: 'card' },
    {
      name: 'source after --',
      command: "source -- /dev/stdin <<< 'pnpm add left-pad'",
      outcome: 'card',
    },
    {
      name: 'source fed by a pipe',
      command: "echo 'pnpm add left-pad' | . /dev/fd/0",
      outcome: 'card',
    },
    { name: 'source of a path with an expansion', command: '. "$F"', outcome: 'card' },
    {
      name: 'a test -eq with a substitution in a string',
      command: "[[ 1 -eq 'a[$(pnpm add x)]' ]]",
      outcome: 'card',
    },
    {
      name: 'a test -eq with a bare substitution string',
      command: "[[ 1 -eq '$(pnpm add x)' ]]",
      outcome: 'card',
    },
    { name: 'let with a substitution string', command: "let 'x=$(pnpm add x)'", outcome: 'card' },
    {
      name: 'printf -v with a substitution subscript',
      command: "printf -v 'a[`pnpm add x`]' hi",
      outcome: 'card',
    },
    {
      name: 'declare -i with a substitution',
      command: "declare -i 'n=$(pnpm add x)'",
      outcome: 'card',
    },
    { name: 'a numeric test on a variable', command: '[[ $n -eq 3 ]]', outcome: 'card' },
    { name: 'let on a variable', command: 'let x=$n', outcome: 'card' },
    { name: 'declare -i on a variable', command: 'declare -i x=$n', outcome: 'card' },
    { name: 'a relative source after a cd', command: 'cd src && . ./env.sh', outcome: 'card' },
    { name: 'source with an option', command: '. -x ./env.sh', outcome: 'card' },
    { name: 'a subscripted assignment', command: 'a[$n]=1', outcome: 'card' },
    { name: 'a subscript expansion', command: 'echo ${a[$n]}', outcome: 'card' },
    { name: 'a substring offset', command: 'echo ${a:$n:1}', outcome: 'card' },
    { name: 'old-style arithmetic', command: 'echo $[1+$n]', outcome: 'card' },
    { name: 'a bare name in arithmetic', command: 'echo $((n))', outcome: 'card' },
    { name: 'let on a name', command: 'let n', outcome: 'card' },
    { name: 'a test of a name', command: '[[ n -eq 1 ]]', outcome: 'card' },
    { name: 'an assignment to an integer', command: 'declare -i x; x=n', outcome: 'card' },
    { name: 'a subscript on a name', command: 'a[n]=1', outcome: 'card' },
    { name: 'a file test with a variable', command: '[[ -f $f ]]', outcome: 'allow' },
    { name: 'a default value with a variable', command: 'echo ${a:-$b}', outcome: 'allow' },
    { name: 'arithmetic on literals', command: 'echo $((1+2))', outcome: 'allow' },
    { name: 'a prefixed subscript', command: 'echo ${!a[n]}', outcome: 'card' },
    { name: 'a positional offset', command: 'echo ${1:n}', outcome: 'card' },
    { name: 'a second subscript', command: 'echo ${a[1]} ${b[n]}', outcome: 'card' },
    { name: 'an integer declared, then read', command: 'declare -i n; read a[n]', outcome: 'card' },
    {
      name: 'an integer declared behind a runner',
      command: 'command typeset -i x; x=n',
      outcome: 'card',
    },
    { name: 'indirect expansion', command: 'echo ${!ref}', outcome: 'card' },
    { name: 'a nameref', command: 'declare -n r=x; r=1', outcome: 'card' },
    { name: 'names with a prefix', command: 'echo ${!BASH*}', outcome: 'allow' },
    { name: 'a prompt transform', command: 'echo ${x@P}', outcome: 'card' },
    { name: 'a declare option from a variable', command: 'declare -$f x', outcome: 'card' },
    {
      name: 'five thousand nested arithmetic expansions',
      command: '$(('.repeat(5000),
      outcome: 'card',
    },
    {
      name: 'a scoped commit message in a quoted heredoc, with a backtick',
      command:
        "git commit -m \"$(cat <<'EOF'\nfix(daemon): close the `db` handle (it leaked)\n\nDon't leak.\nEOF\n)\"",
      outcome: 'allow',
    },
    {
      name: 'a pull request body in a quoted heredoc, with a code fence',
      command:
        'gh pr create --title t --body "$(cat <<\'EOF\'\n## Summary\n```ts\nconst a = (1 + 2);\n```\nEOF\n)"',
      outcome: 'allow',
    },
    {
      name: 'a file written from a quoted heredoc with a template literal',
      command: "cat > a.ts <<'EOF'\nexport const x = `${!y} ${a[n]} $(echo)`;\nEOF",
      outcome: 'allow',
    },
    {
      name: 'node reading a quoted heredoc',
      command: "node - <<'EOF'\nconsole.log(`$(x)`)\nEOF",
      outcome: 'allow',
    },
    {
      name: 'a quoted heredoc read by bash stays a script',
      command: "bash <<'EOF'\npnpm add x\nEOF",
      outcome: 'card',
    },
    {
      name: 'a numeric test with [ and a variable',
      command: '[ "$#" -eq 0 ] && ls',
      outcome: 'allow',
    },
    { name: 'a numeric test with [[ and $#', command: '[[ $# -eq 0 ]] && ls', outcome: 'allow' },
    { name: 'read from a file named by a variable', command: 'read -r x < "$f"', outcome: 'allow' },
    {
      name: 'read from a here-string of a variable',
      command: 'IFS=: read -r a b <<< "$PATH"',
      outcome: 'allow',
    },
    // A structure the parser cannot read.
    { name: 'an unclosed double quote', command: 'echo "unclosed', outcome: 'card' },
    { name: 'an unclosed single quote', command: "echo 'unclosed", outcome: 'card' },
    { name: 'an unclosed parenthesis', command: '(cd src && ls', outcome: 'card' },
    { name: 'an unclosed substitution', command: 'echo $(ls', outcome: 'card' },
    { name: 'an unclosed backtick', command: 'echo `ls', outcome: 'card' },
    { name: 'a stray close parenthesis', command: 'echo a) ls', outcome: 'card' },
    { name: 'a case statement', command: 'case $x in a) ls;; esac', outcome: 'card' },
    { name: 'a function definition', command: 'f() { pnpm add x; }; f', outcome: 'card' },
    { name: 'arithmetic', command: '(( i++ ))', outcome: 'card' },
    { name: 'a group brace in the middle', command: 'echo a { pnpm', outcome: 'card' },
    { name: 'a zsh clobber redirection', command: 'echo hi >| out', outcome: 'card' },
    // The classifier handed the call to a person.
    { name: 'escalated, a safe command', command: 'pnpm test', outcome: 'card', escalated: true },
    {
      name: 'escalated, the real command',
      command: REAL_COMMAND,
      outcome: 'card',
      escalated: true,
    },
  ];

  it.each(BASH_CASES)('Bash: $name -> $outcome', async (c) => {
    const ws = seedWorkstream(base);
    const pending = sandboxed(
      ws,
      true,
      c.hazards,
    )(request('Bash', { command: c.command }, c.escalated ?? false));
    pending.catch(() => undefined);
    await settle();
    const cards = openCards();
    if (c.outcome === 'allow') {
      expect(cards).toEqual([]);
      expect(await pending).toEqual({ behavior: 'allow' });
    } else {
      expect(cards.map((card) => card.detail?.['summary'])).toEqual([c.command]);
      expect(onlyOpenCard().kind).toBe('permission');
    }
  });

  describe('Monitor', () => {
    interface MonitorCase {
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly outcome: 'allow' | 'card';
      readonly escalated?: boolean;
      /** Text the card's body must hold. */
      readonly body?: string;
    }
    // A Monitor call gets the checks a Bash command gets and no more: its command runs in the sandbox.
    const MONITOR_CASES: readonly MonitorCase[] = [
      {
        name: 'a plain wait',
        input: { command: 'until [ -s out ]; do sleep 2; done' },
        outcome: 'allow',
      },
      {
        name: 'a tail of any file',
        input: { command: 'tail -f /var/log/x.log' },
        outcome: 'allow',
      },
      {
        name: 'a hazard command',
        input: { command: 'pnpm add left-pad' },
        outcome: 'card',
        body: 'shared with every lane',
      },
      {
        name: 'a background loop with no end',
        input: { command: '(while :; do :; done) &' },
        outcome: 'card',
      },
      {
        name: 'a socket key',
        input: { command: 'tail -f out', ws: 'wss://example.org' },
        outcome: 'card',
      },
      { name: 'no command', input: { description: 'x' }, outcome: 'card' },
      {
        name: 'an escalated plain wait',
        input: { command: 'sleep 1' },
        outcome: 'card',
        escalated: true,
      },
    ];
    const cardedTools = () => openCards().map((card) => card.detail?.['toolName']);

    it.each(MONITOR_CASES)('$name -> $outcome', async (c) => {
      const ws = seedWorkstream(base);
      const pending = sandboxed(ws)(request('Monitor', c.input, c.escalated ?? false));
      pending.catch(() => undefined);
      await settle();
      if (c.outcome === 'allow') {
        expect(cardedTools()).toEqual([]);
        expect(await pending).toEqual({ behavior: 'allow' });
      } else {
        expect(cardedTools()).toEqual(['Monitor']);
        if (c.body !== undefined) expect(onlyOpenCard().body).toContain(c.body);
        const command = c.input['command'];
        if (typeof command === 'string') {
          expect(onlyOpenCard().detail?.['summary']).toBe(command);
        }
      }
    });

    it('cards Monitor without a sandbox', async () => {
      const ws = seedWorkstream(base);
      void sandboxed(ws, false)(request('Monitor', { command: 'sleep 1' })).catch(() => undefined);
      await settle();
      expect(cardedTools()).toEqual(['Monitor']);
    });
  });

  it.each([
    'EnterWorktree',
    'ExitWorktree',
    'CronCreate',
    'ScheduleWakeup',
    'RemoteTrigger',
    'PushNotification',
    'SendMessage',
    'LSP',
    'SomeToolAddedLater',
  ])('cards %s, a tool the hook hands over', (toolName) => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request(toolName, {})).catch(() => undefined);
    const card = onlyOpenCard();
    expect(card.kind).toBe('permission');
    expect(card.detail?.['toolName']).toBe(toolName);
  });

  it('denies an unlisted host at once and raises one card', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const first = await decide(request('SandboxNetworkAccess', { host: 'example.com' }));
    const second = await decide(request('SandboxNetworkAccess', { host: 'Example.com' }));
    for (const decision of [first, second]) {
      expect(decision).toEqual({
        behavior: 'deny',
        message:
          '10db asked the builder about example.com. Retry after the card is answered, or work without it.',
      });
    }
    const card = onlyOpenCard();
    expect(card).toMatchObject({
      kind: 'permission',
      title: 'Allow network access to example.com?',
      body: HOST_BODY,
      detail: { toolName: 'SandboxNetworkAccess', summary: 'example.com' },
    });
    expect(card.options.map((o) => o.label)).toEqual(['allow_once', 'allow_project', 'deny']);
  });

  it('recommends Allow for the project, and says why, when a project file names the host as a registry', async () => {
    const ws = seedWorkstream(base);
    // The builder removed the host after setup; Cargo.lock still names it.
    allowFoundHosts(state, ws.project.id, [{ host: 'index.crates.io', file: 'Cargo.lock' }]);
    removeNetworkHost(state, ws.project.id, 'index.crates.io');

    await sandboxed(ws)(request('SandboxNetworkAccess', { host: 'index.crates.io' }));

    const card = onlyOpenCard();
    expect(card.recommendation).toBe('allow_project');
    expect(card.body).toContain("The project's Cargo.lock needs index.crates.io");
    expect(card.body).not.toContain('package registry');
    expect(card.body).toContain(HOST_BODY);
  });

  it('names the file and recommends Allow for a project added before readings, from its default branch', async () => {
    const remote = createTempRepoWithOrigin();
    const { repo } = remote;
    try {
      mkdirSync(join(repo.path, 'apps/desktop/src-tauri'), { recursive: true });
      writeFileSync(
        join(repo.path, 'apps/desktop/src-tauri/Cargo.lock'),
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      );
      const rawGit = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      rawGit('add', 'apps');
      rawGit('commit', '-q', '-m', 'lock');
      // A reading takes only origin's copy of the base branch, which a lane can't move.
      rawGit('push', '-q', 'origin', 'main');
      // The lane's own uncommitted line must not become its card's reason.
      writeFileSync(join(repo.path, '.npmrc'), '@x:registry=https://exfil.example.net/\n');
      const project = seedProject(base, { repoPath: repo.path, delivery: 'pull_request' });
      const ws = seedWorkstream(base, { project });
      // No reading was ever written for this project, as for one added before 10db kept readings.

      await sandboxed(
        ws,
        true,
        DEFAULT_HAZARDS,
        createGit(),
      )(request('SandboxNetworkAccess', { host: 'index.crates.io' }));
      const card = onlyOpenCard();
      expect(card.recommendation).toBe('allow_project');
      expect(card.body).toContain(
        "The project's apps/desktop/src-tauri/Cargo.lock needs index.crates.io",
      );
      expect(listNetworkHosts(state.db, ws.project.id)).toEqual([]);

      await sandboxed(
        ws,
        true,
        DEFAULT_HAZARDS,
        createGit(),
      )(request('SandboxNetworkAccess', { host: 'exfil.example.net' }));
      const cards = openCards().filter(
        (c) => c.title === 'Allow network access to exfil.example.net?',
      );
      expect(cards.map((c) => c.recommendation)).toEqual([null]);
    } finally {
      remote.cleanup();
    }
  });

  it('under local delivery reads only origin’s base branch, never a lane’s commit on the local one', async () => {
    const remote = createTempRepoWithOrigin();
    const { repo } = remote;
    try {
      const rawGit = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      mkdirSync(join(repo.path, 'apps/desktop/src-tauri'), { recursive: true });
      writeFileSync(
        join(repo.path, 'apps/desktop/src-tauri/Cargo.lock'),
        'source = "registry+https://github.com/rust-lang/crates.io-index"\n',
      );
      rawGit('add', 'apps');
      rawGit('commit', '-q', '-m', 'lock');
      rawGit('push', '-q', 'origin', 'main');
      const git = createGit();
      // A local lane's commit tool commits on the checked-out branch: here, main itself.
      writeFileSync(join(repo.path, '.npmrc'), '@x:registry=https://exfil.example.net/\n');
      await git.commit({
        repo: repo.path,
        paths: ['.npmrc'],
        message: 'registry',
        opId: 'op-lane-npmrc',
        branch: 'main',
      });
      const project = seedProject(base, { repoPath: repo.path, delivery: 'local' });
      const ws = seedWorkstream(base, { project });

      await sandboxed(
        ws,
        true,
        DEFAULT_HAZARDS,
        git,
      )(request('SandboxNetworkAccess', { host: 'exfil.example.net' }));
      expect(onlyOpenCard().recommendation).toBeNull();
      expect(foundHostFile(state.db, project.id, 'exfil.example.net')).toBeNull();

      await sandboxed(
        ws,
        true,
        DEFAULT_HAZARDS,
        git,
      )(request('SandboxNetworkAccess', { host: 'index.crates.io' }));
      const crates = openCards().filter(
        (c) => c.title === 'Allow network access to index.crates.io?',
      );
      expect(crates.map((c) => c.recommendation)).toEqual(['allow_project']);
      expect(listNetworkHosts(state.db, project.id)).toEqual([]);
    } finally {
      remote.cleanup();
    }
  });

  it('recommends nothing for a host no project file names', async () => {
    const ws = seedWorkstream(base);
    allowFoundHosts(state, ws.project.id, [{ host: 'index.crates.io', file: 'Cargo.lock' }]);
    await sandboxed(ws)(request('SandboxNetworkAccess', { host: 'example.com' }));
    expect(onlyOpenCard().recommendation).toBeNull();
    expect(onlyOpenCard().body).toBe(HOST_BODY);
  });

  it('denies a network ask that names no host, with no card', async () => {
    const ws = seedWorkstream(base);
    const decision = await sandboxed(ws)(request('SandboxNetworkAccess', {}));
    expect(decision.behavior).toBe('deny');
    expect(openCards()).toEqual([]);
  });

  it('lets exactly the next request for the host through after allow once', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const ask = request('SandboxNetworkAccess', { host: 'example.com' });
    expect((await decide(ask)).behavior).toBe('deny');
    inbox.answer(onlyOpenCard().id, { choice: 'allow_once' });
    await settle();
    expect(await decide(ask)).toEqual({ behavior: 'allow' });
    expect((await decide(ask)).behavior).toBe('deny');
    expect(openCards()).toEqual([]);
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([]);
  });

  it('keeps the allowance to the host and the session it was given for', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    await decide(request('SandboxNetworkAccess', { host: 'example.com' }));
    inbox.answer(onlyOpenCard().id, { choice: 'allow_once' });
    await settle();
    expect((await decide(request('SandboxNetworkAccess', { host: 'evil.com' }))).behavior).toBe(
      'deny',
    );
    expect(
      (await sandboxed(ws)(request('SandboxNetworkAccess', { host: 'example.com' }))).behavior,
    ).toBe('deny');
  });

  it('stores the host for the project on allow project, for this session and the next', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const ask = request('SandboxNetworkAccess', { host: 'Registry.NPMJS.org' });
    expect((await decide(ask)).behavior).toBe('deny');
    inbox.answer(onlyOpenCard().id, { choice: 'allow_project' });
    await settle();
    expect(await decide(ask)).toEqual({ behavior: 'allow' });
    expect(await sandboxed(ws)(ask)).toEqual({ behavior: 'allow' });
    expect(searchDecisions(state.db, ws.project.id, 'registry.npmjs.org', 5)).toEqual([
      expect.objectContaining({
        question: 'Allow SandboxNetworkAccess (registry.npmjs.org) in this project?',
        choice: 'Always allow',
      }),
    ]);
    expect(
      (await decide(request('SandboxNetworkAccess', { host: 'evil.npmjs.org' }))).behavior,
    ).toBe('deny');
  });

  it.each([['my_service'], ['fe80::1']])(
    'stores %s, which the profile cannot list, and lets the next session reach it with no card',
    async (host) => {
      const ws = seedWorkstream(base);
      const ask = request('SandboxNetworkAccess', { host });
      expect((await sandboxed(ws)(ask)).behavior).toBe('deny');
      inbox.answer(onlyOpenCard().id, { choice: 'allow_project' });
      await settle();
      expect(await sandboxed(ws)(ask)).toEqual({ behavior: 'allow' });
      expect(openCards()).toEqual([]);
    },
  );

  it('never lets an unscoped network rule allow a host', async () => {
    const ws = seedWorkstream(base);
    base.write((ctx) =>
      insertPermissionRule(ctx, {
        projectId: ws.project.id,
        workstreamId: null,
        toolName: 'SandboxNetworkAccess',
        pattern: null,
        sourceInboxId: null,
      }),
    );
    const decision = await sandboxed(ws)(request('SandboxNetworkAccess', { host: 'example.com' }));
    expect(decision.behavior).toBe('deny');
    expect(onlyOpenCard().detail).toEqual({
      toolName: 'SandboxNetworkAccess',
      summary: 'example.com',
    });
  });

  it('allows a host with a stored rule, with no card', async () => {
    const ws = seedWorkstream(base);
    base.write((ctx) =>
      insertPermissionRule(ctx, {
        projectId: ws.project.id,
        workstreamId: null,
        toolName: 'SandboxNetworkAccess',
        pattern: 'registry.npmjs.org',
        sourceInboxId: null,
      }),
    );
    const decision = await sandboxed(ws)(
      request('SandboxNetworkAccess', { host: 'Registry.NPMJS.org' }),
    );
    expect(decision).toEqual({ behavior: 'allow' });
    expect(openCards()).toEqual([]);
  });

  it('never lets a denied host card allow later requests', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const ask = request('SandboxNetworkAccess', { host: 'example.com' });
    await decide(ask);
    inbox.answer(onlyOpenCard().id, { choice: 'deny' });
    await settle();
    expect((await decide(ask)).behavior).toBe('deny');
    expect(openCards()).toEqual([]);
  });

  it('leaves no unhandled rejection when the session ends with a host card open', async () => {
    const ws = seedWorkstream(base);
    await sandboxed(ws)(request('SandboxNetworkAccess', { host: 'example.com' }));
    controller.abort();
    await settle();
    expect(openCards()).toHaveLength(1);
  });

  it('refuses a protected read with no card', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    for (const [tool, input] of [
      ['Read', { file_path: join(fileAccess.home, '.claude.json') }],
      ['Grep', { pattern: 'x', path: fileAccess.home }],
      ['Glob', { pattern: '*', path: join(fileAccess.home, '.claude') }],
      ['LS', { path: join(fileAccess.configDir, 'projects', 'x', 'other-id') }],
    ] as const) {
      expect((await decide(request(tool, input))).behavior, tool).toBe('deny');
    }
    expect(openCards()).toEqual([]);
  });

  it("refuses with no card a read of another session's sealed file or temp dir, and leaves its own temp dir alone", async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const temp = join(root, 't');
    for (const [tool, input] of [
      ['Read', { file_path: join(temp, '10db-mcp-0123456789ab.sh') }],
      ['Read', { file_path: join(temp, '10db-othabc', 'notes.txt') }],
      ['Grep', { pattern: 'x', path: temp }],
      ['LS', { path: join(temp, '10db-othabc') }],
    ] as const) {
      expect(
        (await decide(request(tool, input))).behavior,
        `${tool} ${JSON.stringify(input)}`,
      ).toBe('deny');
    }
    expect(openCards()).toEqual([]);
    // Its own temp dir is judged as before: outside the checkout, so a card.
    void decide(request('Read', { file_path: join(temp, '10db-ownabc', 'notes.txt') })).catch(
      () => undefined,
    );
    expect(onlyOpenCard().kind).toBe('permission');
  });

  it("keeps reading the session's own saved tool results", async () => {
    const ws = seedWorkstream(base);
    const own = join(fileAccess.configDir, 'projects', 'x', 'own-id', 'tool-results', 'a.txt');
    expect(await sandboxed(ws)(request('Read', { file_path: own }))).toEqual({ behavior: 'allow' });
    expect(openCards()).toEqual([]);
  });

  it('allows a read inside the checkout, including one through a link that stays inside', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    expect((await decide(request('Read', { file_path: 'src/a.ts' }))).behavior).toBe('allow');
    expect((await decide(request('LS', {}))).behavior).toBe('allow');
    expect(openCards()).toEqual([]);
  });

  it('allows a read-list path', async () => {
    const ws = seedWorkstream(base);
    const file = join(root, 'work', 'listed', 'notes.txt');
    expect(await sandboxed(ws)(request('Read', { file_path: file }))).toEqual({
      behavior: 'allow',
    });
    expect(openCards()).toEqual([]);
  });

  it("reads the system's manual pages with Read, Grep and Glob and no card", async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    for (const [tool, input] of [
      ['Read', { file_path: '/usr/share/man/man1/ps.1' }],
      ['Grep', { pattern: 'signal', path: '/usr/share/man/man1/pkill.1' }],
      ['Grep', { pattern: 'signal', path: '/usr/share/man' }],
      ['Glob', { pattern: 'man1/p*.1', path: '/usr/share/man' }],
      ['Glob', { pattern: '/usr/share/man/man1/p*.1' }],
    ] as const) {
      expect(await decide(request(tool, input)), `${tool} ${JSON.stringify(input)}`).toEqual({
        behavior: 'allow',
      });
    }
    expect(openCards()).toEqual([]);
  });

  it('still cards a read under the home directory outside the copy, and a write to the manual pages', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    void decide(request('Read', { file_path: join(fileAccess.home, 'notes.txt') })).catch(
      () => undefined,
    );
    expect(onlyOpenCard().kind).toBe('permission');
    inbox.answer(onlyOpenCard().id, { choice: 'deny' });
    await settle();
    // The manual-page rule reads only; an Edit or Write there is never allowed without a person.
    for (const tool of ['Edit', 'Write'] as const) {
      void decide(request(tool, { file_path: '/usr/share/man/man1/ps.1' })).catch(() => undefined);
      await settle();
      const card = onlyOpenCard();
      expect(card.kind, tool).toBe('permission');
      inbox.answer(card.id, { choice: 'deny' });
      await settle();
    }
  });

  it('cards a read outside the checkout, naming the real path, and stores the grant for every read tool', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const other = join(root, 'work', 'other');
    // Reached through a link inside the checkout: the card names where it lands.
    const pending = decide(
      request('Grep', { pattern: 'x', path: join(fileAccess.checkout, 'link-out') }),
    );
    const card = onlyOpenCard();
    expect(card.body).toBe(other);
    expect(card.detail).toEqual({ toolName: 'Grep', summary: other });
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([
      expect.objectContaining({ toolName: 'Read', pattern: other }),
    ]);
    expect((await decide(request('Read', { file_path: join(other, 'notes.txt') }))).behavior).toBe(
      'allow',
    );
    expect((await decide(request('Glob', { pattern: '*.txt', path: other }))).behavior).toBe(
      'allow',
    );
    expect(openCards()).toEqual([]);
  });

  it('cards a read that mixes an inside path with an outside one, naming the outside one', () => {
    const ws = seedWorkstream(base);
    const outside = join(root, 'work', 'other');
    void sandboxed(ws)(request('Glob', { pattern: join(outside, '*.txt'), path: '.' })).catch(
      () => undefined,
    );
    expect(onlyOpenCard().body).toBe(outside);
  });

  it('names every path a read needs asking about in the card body', () => {
    const ws = seedWorkstream(base);
    const a = join(root, 'work', 'other');
    const b = join(root, 'work', 'elsewhere');
    mkdirSync(b);
    void sandboxed(ws)(request('Glob', { pattern: `${a}/*.txt`, path: b })).catch(() => undefined);
    const card = onlyOpenCard();
    expect(card.body).toContain(a);
    expect(card.body).toContain(b);
    expect(card.detail?.['summary']).toBe(b);
  });

  it('does not let an old unscoped Read or Edit rule cover a sandboxed card', () => {
    const ws = seedWorkstream(base);
    for (const toolName of ['Read', 'Edit']) {
      base.write((ctx) =>
        insertPermissionRule(ctx, {
          projectId: ws.project.id,
          workstreamId: null,
          toolName,
          pattern: null,
          sourceInboxId: null,
        }),
      );
    }
    const decide = sandboxed(ws);
    void decide(request('Edit', { file_path: '.claude/hooks/x' })).catch(() => undefined);
    void decide(request('Read', { file_path: join(root, 'work', 'other', 'notes.txt') })).catch(
      () => undefined,
    );
    expect(openCards()).toHaveLength(2);
  });

  it.each([
    ['Read', (path: string) => ({ file_path: join(path, 'notes.txt') })],
    ['Grep', (path: string) => ({ pattern: 'x', path })],
    ['Glob', (path: string) => ({ pattern: '*.txt', path })],
  ])(
    'refuses a %s of the worktrees folder outside the lane’s copy at once, with no card',
    async (toolName, inputFor) => {
      const ws = seedWorkstream(base);
      fileAccess = { ...fileAccess, worktreeRoot: join(root, 'work') };
      const decision = await sandboxed(ws)(
        request(toolName, inputFor(join(root, 'work', 'other'))),
      );
      expect(decision).toEqual({
        behavior: 'deny',
        message: expect.stringContaining(`The copy is ${fileAccess.checkout}`) as string,
      });
      expect(openCards()).toEqual([]);
    },
  );

  it.each<{ name: string; toolName: string; input: Record<string, unknown>; fails?: boolean }>([
    { name: 'a Read with no file path', toolName: 'Read', input: {} },
    { name: 'an Edit with no file path', toolName: 'Edit', input: { old_string: 'a' } },
    {
      name: 'an Edit whose path judging fails',
      toolName: 'Edit',
      input: { file_path: 'src/a.ts' },
      fails: true,
    },
  ])(
    'denies $name with no card, even with an old unscoped rule stored',
    async ({ toolName, input, fails }) => {
      const ws = seedWorkstream(base);
      base.write((ctx) =>
        insertPermissionRule(ctx, {
          projectId: ws.project.id,
          workstreamId: null,
          toolName,
          pattern: null,
          sourceInboxId: null,
        }),
      );
      if (fails === true) {
        // An unexpected failure while judging: reading the context throws.
        const { checkout, protectedReads: reads, readList, configDir, sandboxTemp } = fileAccess;
        fileAccess = {
          checkout,
          protectedReads: reads,
          readList,
          configDir,
          providerSessionId: 'own-id',
          sandboxTemp,
          get home(): string {
            throw new Error('the context could not be read');
          },
        };
      }
      expect(await sandboxed(ws)(request(toolName, input))).toEqual({
        behavior: 'deny',
        message: "10db could not judge this call's path.",
      });
      expect(openCards()).toEqual([]);
    },
  );

  it('names the file an edit card is about in its detail, whether or not the lane is sandboxed', () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws, false)(request('Write', { file_path: 'docs/a.md' })).catch(() => undefined);
    expect(onlyOpenCard().detail).toMatchObject({ toolName: 'Write', path: 'docs/a.md' });
  });

  describe('the write an allowed edit call makes', () => {
    const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
    const file = (): string => join(fileAccess.checkout, 'src', 'a.json');
    const edit = (newText: string) =>
      request('Edit', { file_path: file(), old_string: '"a":1', new_string: newText });

    it('marks the card as excusing only that exact write, and records nothing before the answer', () => {
      const ws = seedWorkstream(base);
      writeFileSync(file(), '{"a":1}');
      void sandboxed(ws)(edit('"a":2')).catch(() => undefined);
      expect(onlyOpenCard().detail).toMatchObject({ exactWrite: true, path: file() });
      expect(onlyOpenCard().detail).not.toHaveProperty('allowedWrites');
    });

    it('records for the lane the file its call leaves, read when the builder allows it', async () => {
      const ws = seedWorkstream(base);
      writeFileSync(file(), '{"a":1}');
      const decision = sandboxed(ws)(edit('"a":2'));
      const card = onlyOpenCard();
      // Another change lands between the card and the answer: the call applies to the file as it is then.
      writeFileSync(file(), '{"b":0,"a":1}');
      inbox.answer(card.id, { choice: 'allow_once' });
      expect(await decision).toEqual({ behavior: 'allow' });
      expect(getInboxItem(state.db, card.id).detail).toMatchObject({
        allowedWrites: { [ws.workstream.id]: sha('{"b":0,"a":2}') },
      });
    });

    it('records the line an allowed Edit deletes with its newline, as Claude Code writes it', async () => {
      const ws = seedWorkstream(base);
      const env = join(fileAccess.checkout, 'src', '.env');
      writeFileSync(env, 'A=1\nB=2\nC=3\n');
      const decision = sandboxed(ws)(
        request('Edit', { file_path: env, old_string: 'B=2', new_string: '' }),
      );
      const card = onlyOpenCard();
      inbox.answer(card.id, { choice: 'allow_once' });
      expect(await decision).toEqual({ behavior: 'allow' });
      expect(getInboxItem(state.db, card.id).detail).toMatchObject({
        allowedWrites: { [ws.workstream.id]: sha('A=1\nC=3\n') },
      });
    });

    it("gives two lanes' Edits to one file a card each, so each records the file its own write makes", async () => {
      const a = seedWorkstream(base);
      const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
      writeFileSync(file(), '{"a":1,"b":1}');
      const first = sandboxed(a)(
        request('Edit', { file_path: file(), old_string: '"a":1', new_string: '"a":2' }),
      );
      const second = sandboxed(b)(
        request('Edit', { file_path: file(), old_string: '"b":1', new_string: '"b":2' }),
      );
      const cards = openCards();
      expect(cards).toHaveLength(2);
      const cardOf = (lane: typeof a) => {
        const card = cards.find((c) => c.targets[0]?.workstreamId === lane.workstream.id);
        if (card === undefined) throw new Error('no card for the lane');
        return card;
      };
      // Alpha's write lands before the builder answers Beta's card.
      inbox.answer(cardOf(a).id, { choice: 'allow_once' });
      expect(await first).toEqual({ behavior: 'allow' });
      writeFileSync(file(), '{"a":2,"b":1}');
      inbox.answer(cardOf(b).id, { choice: 'allow_once' });
      expect(await second).toEqual({ behavior: 'allow' });
      expect(getInboxItem(state.db, cardOf(a).id).detail).toMatchObject({
        allowedWrites: { [a.workstream.id]: sha('{"a":2,"b":1}') },
      });
      expect(getInboxItem(state.db, cardOf(b).id).detail).toMatchObject({
        allowedWrites: { [b.workstream.id]: sha('{"a":2,"b":2}') },
      });
    });

    describe("answering one lane's Edit card with allow_project", () => {
      const twoLanes = () => {
        const a = seedWorkstream(base);
        const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
        writeFileSync(file(), '{"a":1,"b":1}');
        const editOf = (key: string) =>
          request('Edit', {
            file_path: file(),
            old_string: `"${key}":1`,
            new_string: `"${key}":2`,
          });
        const first = sandboxed(a)(editOf('a'));
        const second = sandboxed(b)(editOf('b'));
        const cardOf = (lane: typeof a) => {
          const card = openCards().find((c) => c.targets[0]?.workstreamId === lane.workstream.id);
          if (card === undefined) throw new Error('no card for the lane');
          return card;
        };
        return { a, b, first, second, cardOf };
      };

      it("releases the other lane's open card for the same edit, and records its hash", async () => {
        const { a, b, first, second, cardOf } = twoLanes();
        const alphaCard = cardOf(a);
        const betaCard = cardOf(b);
        inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(await first).toEqual({ behavior: 'allow' });
        expect(await second).toEqual({ behavior: 'allow' });
        expect(openCards()).toEqual([]);
        expect(getInboxItem(state.db, betaCard.id)).toMatchObject({ state: 'RESOLVED' });
        expect(getInboxItem(state.db, betaCard.id).detail).toMatchObject({
          allowedWrites: { [b.workstream.id]: sha('{"a":1,"b":2}') },
        });
        // One rule and one decision: the released card stores none of its own.
        expect(listPermissionRules(state.db, a.project.id, a.workstream.id)).toHaveLength(1);
      });

      it("still returns the builder's answered card when releasing the other lane's card fails, leaving it open and logging it", async () => {
        const warnings: { fields: unknown; message: unknown }[] = [];
        const logger = {
          ...silentLogger,
          warn: (fields: unknown, message?: unknown) => warnings.push({ fields, message }),
        };
        const failing: { id?: string } = {};
        inbox = createInboxService({
          state: {
            db: state.db,
            now: () => state.now(),
            write: (fn) =>
              state.write((ctx) => {
                const result = fn(ctx);
                // A write failure that lands as the other lane's card is answered rolls it back.
                if (
                  failing.id !== undefined &&
                  (result as { id?: string } | null)?.id === failing.id
                ) {
                  throw new Error('disk full');
                }
                return result;
              }),
          },
          onParkedAnswer: () => undefined,
          log: logger,
        });
        const { a, b, first, cardOf } = twoLanes();
        const alphaCard = cardOf(a);
        const betaCard = cardOf(b);
        failing.id = betaCard.id;
        const answered = inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(answered).toMatchObject({ id: alphaCard.id, state: 'RESOLVED' });
        expect(await first).toEqual({ behavior: 'allow' });
        expect(getInboxItem(state.db, betaCard.id)).toMatchObject({ state: 'OPEN' });
        expect(openCards().map((c) => c.id)).toEqual([betaCard.id]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.fields).toMatchObject({ cardId: betaCard.id });
      });

      it("raises a card for the builder when delivering the other lane's answer fails after it committed, and retries delivery when they answer it", async () => {
        const failing: { id?: string } = {};
        inbox = createInboxService({
          state: {
            db: state.db,
            now: () => state.now(),
            write: (fn) =>
              state.write((ctx) => {
                const result = fn(ctx) as { id?: string; state?: string } | null;
                // The write that closes the other lane's card after its answer was handed on.
                if (
                  failing.id !== undefined &&
                  result?.id === failing.id &&
                  result.state === 'RESOLVED'
                )
                  throw new Error('disk full');
                return result as never;
              }),
          },
          onParkedAnswer: () => undefined,
          log: silentLogger,
        });
        const { a, b, first, cardOf } = twoLanes();
        const alphaCard = cardOf(a);
        const betaCard = cardOf(b);
        failing.id = betaCard.id;
        const answered = inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(answered).toMatchObject({ id: alphaCard.id, state: 'RESOLVED' });
        await first;
        // Its answer is stored but it never closed: it is no longer open, so a flag says so.
        expect(getInboxItem(state.db, betaCard.id)).toMatchObject({ state: 'DELIVERING' });
        const flags = openCards().filter((c) => c.kind === 'flag');
        expect(flags).toHaveLength(1);
        expect(flags[0]).toMatchObject({ projectId: b.project.id });
        expect(flags[0]?.targets[0]?.workstreamId).toBe(b.workstream.id);
        // The cause is gone: answering the flag delivers the answer again.
        delete failing.id;
        const flag = flags[0];
        if (flag === undefined) throw new Error('no flag');
        inbox.answer(flag.id, { choice: flag.options[0]?.label ?? '' });
        expect(getInboxItem(state.db, betaCard.id)).toMatchObject({ state: 'RESOLVED' });
        expect(openCards()).toEqual([]);
      });

      it("still returns the builder's answered card when listing the covered cards fails, leaving them open and logging it", async () => {
        const warnings: { fields: unknown; message: unknown }[] = [];
        const logger = {
          ...silentLogger,
          warn: (fields: unknown, message?: unknown) => warnings.push({ fields, message }),
        };
        const failing: { afterId?: string; reading: boolean } = { reading: false };
        inbox = createInboxService({
          state: {
            // The listing is the first read after the builder's answer is stored.
            get db() {
              if (failing.reading) throw new Error('database is locked');
              return state.db;
            },
            now: () => state.now(),
            write: (fn) =>
              state.write((ctx) => {
                const result = fn(ctx);
                if ((result as { id?: string } | null)?.id === failing.afterId) {
                  failing.reading = true;
                }
                return result;
              }),
          },
          onParkedAnswer: () => undefined,
          log: logger,
        });
        const { a, b, first, cardOf } = twoLanes();
        const alphaCard = cardOf(a);
        const betaCard = cardOf(b);
        failing.afterId = alphaCard.id;
        const answered = inbox.answer(alphaCard.id, { choice: 'allow_project' });
        failing.reading = false;
        expect(answered).toMatchObject({ id: alphaCard.id, state: 'RESOLVED' });
        expect(await first).toEqual({ behavior: 'allow' });
        expect(getInboxItem(state.db, betaCard.id)).toMatchObject({ state: 'OPEN' });
        expect(openCards().map((c) => c.id)).toEqual([betaCard.id]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.fields).toMatchObject({ cardId: alphaCard.id });
      });

      it('leaves another lane’s card for a different file open', () => {
        const a = seedWorkstream(base);
        const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
        writeFileSync(file(), '{"a":1}');
        const other = join(fileAccess.checkout, 'src', 'b.json');
        writeFileSync(other, '{"a":1}');
        void sandboxed(a)(edit('"a":2')).catch(() => undefined);
        void sandboxed(b)(
          request('Edit', { file_path: other, old_string: '"a":1', new_string: '"a":2' }),
        ).catch(() => undefined);
        const alphaCard = openCards().find((c) => c.targets[0]?.workstreamId === a.workstream.id);
        if (alphaCard === undefined) throw new Error('no card for Alpha');
        inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(openCards()).toHaveLength(1);
      });

      it('leaves the other lane’s card open when Claude Code escalated its call', async () => {
        const a = seedWorkstream(base);
        const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
        writeFileSync(file(), '{"a":1}');
        const first = sandboxed(a)(edit('"a":2'));
        void sandboxed(b)(
          request('Edit', { file_path: file(), old_string: '"a":1', new_string: '"a":2' }, true),
        ).catch(() => undefined);
        const alphaCard = openCards().find((c) => c.targets[0]?.workstreamId === a.workstream.id);
        if (alphaCard === undefined) throw new Error('no card for Alpha');
        inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(await first).toEqual({ behavior: 'allow' });
        const open = openCards();
        expect(open).toHaveLength(1);
        expect(open[0]?.targets[0]?.workstreamId).toBe(b.workstream.id);
      });

      it('keeps an escalated Edit on its own card, apart from an identical ordinary Edit in the same lane', async () => {
        const a = seedWorkstream(base);
        const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
        writeFileSync(file(), '{"a":1}');
        const input = { file_path: file(), old_string: '"a":1', new_string: '"a":2' };
        const first = sandboxed(a)(request('Edit', input));
        const ordinary = sandboxed(b)(request('Edit', input));
        void sandboxed(b)(request('Edit', input, true)).catch(() => undefined);
        const betaCards = openCards().filter((c) => c.targets[0]?.workstreamId === b.workstream.id);
        expect(betaCards).toHaveLength(2);
        const alphaCard = openCards().find((c) => c.targets[0]?.workstreamId === a.workstream.id);
        if (alphaCard === undefined) throw new Error('no card for Alpha');
        inbox.answer(alphaCard.id, { choice: 'allow_project' });
        expect(await first).toEqual({ behavior: 'allow' });
        expect(await ordinary).toEqual({ behavior: 'allow' });
        const open = openCards();
        expect(open).toHaveLength(1);
        expect(open[0]?.targets[0]?.workstreamId).toBe(b.workstream.id);
        expect(open[0]?.detail).toMatchObject({ escalated: true });
      });

      it('leaves the other lane’s card open for allow_once', () => {
        const { a, cardOf } = twoLanes();
        inbox.answer(cardOf(a).id, { choice: 'allow_once' });
        expect(openCards()).toHaveLength(1);
      });
    });

    it("still folds two lanes' Writes to one file, keeping each lane's content", async () => {
      const a = seedWorkstream(base);
      const b = seedWorkstream(base, { project: a.project, title: 'Beta' });
      const write = (content: string) => request('Write', { file_path: file(), content });
      const first = sandboxed(a)(write('X'));
      const second = sandboxed(b)(write('Y'));
      const card = onlyOpenCard();
      inbox.answer(card.id, { choice: 'allow_once' });
      await Promise.all([first, second]);
      expect(getInboxItem(state.db, card.id).detail).toMatchObject({
        allowedWrites: { [a.workstream.id]: sha('X'), [b.workstream.id]: sha('Y') },
      });
    });

    it('records nothing for a denied call', async () => {
      const ws = seedWorkstream(base);
      writeFileSync(file(), '{"a":1}');
      const decision = sandboxed(ws)(edit('"a":2'));
      const card = onlyOpenCard();
      inbox.answer(card.id, { choice: 'deny' });
      expect((await decision).behavior).toBe('deny');
      expect(getInboxItem(state.db, card.id).detail).not.toHaveProperty('allowedWrites');
    });

    it('records the write of the call an allow_once answered after parking lets through', async () => {
      const ws = seedWorkstream(base);
      writeFileSync(file(), '{"a":1}');
      void sandboxed(ws)(edit('"a":2')).catch(() => undefined);
      const card = onlyOpenCard();
      controller.abort();
      inbox.answer(card.id, { choice: 'allow_once' });
      const decide = createPermissionBroker(
        { state, inbox, git: NO_GIT, logger: silentLogger },
        {
          projectId: ws.project.id,
          workstreamId: ws.workstream.id,
          sessionId: mintId('Session'),
          signal: new AbortController().signal,
          observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
          allowOnce: { toolName: 'Edit', summary: file(), cardId: card.id },
          sandbox: { fileAccess, hazards: DEFAULT_HAZARDS },
        },
      );
      expect(await decide(edit('"a":5'))).toEqual({ behavior: 'allow' });
      expect(getInboxItem(state.db, card.id).detail).toMatchObject({
        allowedWrites: { [ws.workstream.id]: sha('{"a":5}') },
      });
    });
  });

  it('names no file on a card for a tool that is not an edit', () => {
    const ws = seedWorkstream(base);
    void sandboxed(
      ws,
      false,
    )(request('SomeToolAddedLater', { file_path: 'a' })).catch(() => undefined);
    expect(onlyOpenCard().detail).not.toHaveProperty('path');
  });

  it('cards an edit with the real path and stores a rule for that one path', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const vscode = join(fileAccess.checkout, '.vscode', 'settings.json');
    const pending = decide(request('Edit', { file_path: '.vscode/settings.json' }));
    const card = onlyOpenCard();
    expect(card.detail).toEqual({
      toolName: 'Edit',
      summary: vscode,
      path: vscode,
      exactWrite: true,
    });
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect((await decide(request('Edit', { file_path: vscode }))).behavior).toBe('allow');
    void decide(request('Edit', { file_path: '.claude/hooks/x' })).catch(() => undefined);
    const hook = join(fileAccess.checkout, '.claude', 'hooks', 'x');
    expect(onlyOpenCard().detail).toEqual({
      toolName: 'Edit',
      summary: hook,
      path: hook,
      exactWrite: true,
    });
  });

  it('asks about every other tool as it always did', () => {
    const ws = seedWorkstream(base);
    void sandboxed(ws)(request('WebFetch', { url: 'https://example.com' })).catch(() => undefined);
    expect(onlyOpenCard()).toMatchObject({
      title: 'Allow WebFetch?',
      body: '{"url":"https://example.com"}',
    });
  });

  it('without sandbox context, behaves as before', () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws, false);
    void decide(request('Bash', { command: 'pnpm test' })).catch(() => undefined);
    void decide(request('Read', { file_path: join(fileAccess.home, '.claude.json') })).catch(
      () => undefined,
    );
    void decide(request('SandboxNetworkAccess', { host: 'example.com' })).catch(() => undefined);
    expect(openCards().map((card) => [card.title, card.body])).toEqual([
      ['Allow Bash?', 'pnpm test'],
      ['Allow Read?', JSON.stringify({ file_path: join(fileAccess.home, '.claude.json') })],
      ['Allow SandboxNetworkAccess?', '{"host":"example.com"}'],
    ]);
  });
});

describe('permission broker without a sandbox keeps its network cards', () => {
  it('stores an unscoped network rule on always allow, which then allows with no card', async () => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: new AbortController().signal,
      },
    );
    const request = (host: string) => ({
      toolName: 'SandboxNetworkAccess',
      input: { host },
      toolUseId: 't1',
      escalated: false,
      signal: new AbortController().signal,
    });
    const pending = decide(request('example.com'));
    const [card] = listInbox(state.db, { states: ['OPEN'] });
    if (!card) throw new Error('expected a card');
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([
      expect.objectContaining({ toolName: 'SandboxNetworkAccess', pattern: null }),
    ]);
    expect(await decide(request('other.example'))).toEqual({ behavior: 'allow' });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
  });
});

describe('permission broker without a sandbox keeps its Read and Edit cards', () => {
  it.each([
    ['Read', { file_path: '/etc/hosts' }],
    ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
  ])('offers always-allow on a %s card and stores the unscoped rule', async (toolName, input) => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: new AbortController().signal,
      },
    );
    const pending = decide({
      toolName,
      input,
      toolUseId: 't1',
      escalated: false,
      signal: new AbortController().signal,
    });
    const [card] = listInbox(state.db, { states: ['OPEN'] });
    if (!card) throw new Error('expected a card');
    expect(card.options.find((o) => o.label === 'allow_project')?.description).toBe(
      'Always allow in this project (records a decision)',
    );
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([
      expect.objectContaining({ toolName, pattern: null }),
    ]);
  });
});

describe('a check card', () => {
  let checked: { item: InboxItemDto; choice: string; note: string | undefined }[];
  let committed: string[];
  let checkInbox: InboxService;

  beforeEach(() => {
    checked = [];
    committed = [];
    checkInbox = createInboxService({
      state,
      onParkedAnswer: (target, item) => parked.push({ target, item }),
      onCheckAnswer: (_ctx, item, answer) => {
        checked.push({ item, choice: answer.choice, note: answer.note });
        return () => {
          committed.push(getInboxItem(state.db, item.id).state);
        };
      },
    });
  });

  function checkCard() {
    const ws = seedWorkstream(base);
    const card = state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: ws.project.id,
        kind: 'check',
        title: 'Ready for you to check: Task',
        body: '1 commit is ready.',
        options: [
          { label: 'approve', description: 'The work is right' },
          { label: 'send_back', description: 'It needs more work' },
        ],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: { workstreamId: ws.workstream.id },
        foldKey: null,
        targets: [{ workstreamId: ws.workstream.id, sessionId: null }],
      }),
    );
    return card;
  }

  it.each([
    { name: 'approve', answer: { choice: 'approve' } },
    { name: 'approve with a note', answer: { choice: 'approve', note: 'fine' } },
    { name: 'send back with a note', answer: { choice: 'send_back', note: 'Rename it' } },
  ])('$name reaches onCheckAnswer once and never onParkedAnswer', ({ answer }) => {
    const card = checkCard();
    const done = checkInbox.answer(card.id, answer);
    expect(done.state).toBe('RESOLVED');
    expect(checked.map((c) => [c.item.id, c.choice, c.note])).toEqual([
      [card.id, answer.choice, 'note' in answer ? answer.note : undefined],
    ]);
    expect(parked).toEqual([]);
  });

  it('runs what the handler returns only after the card is closed', () => {
    const card = checkCard();
    checkInbox.answer(card.id, { choice: 'approve' });
    expect(committed).toEqual(['RESOLVED']);
  });

  it('a handler that throws leaves the card open and runs nothing after', () => {
    const card = checkCard();
    const refusing = createInboxService({
      state,
      onParkedAnswer: () => undefined,
      onCheckAnswer: () => {
        throw new ConflictError('not waiting');
      },
    });
    expect(() => refusing.answer(card.id, { choice: 'approve' })).toThrow(ConflictError);
    expect(getInboxItem(state.db, card.id).state).toBe('OPEN');
    expect(committed).toEqual([]);
  });

  it.each([
    { name: 'no note', note: undefined },
    { name: 'an empty note', note: '' },
    { name: 'a blank note', note: '  \n ' },
  ])('send back with $name is refused and leaves the card open', ({ note }) => {
    const card = checkCard();
    expect(() =>
      checkInbox.answer(card.id, { choice: 'send_back', ...(note === undefined ? {} : { note }) }),
    ).toThrow(InboxAnswerRefused);
    expect(checked).toEqual([]);
    expect(getInboxItem(state.db, card.id).state).toBe('OPEN');
  });

  it('an unknown choice is refused before anything acts', () => {
    const card = checkCard();
    expect(() => checkInbox.answer(card.id, { choice: 'ship_it' })).toThrow(InvalidError);
    expect(checked).toEqual([]);
    expect(getInboxItem(state.db, card.id).state).toBe('OPEN');
  });

  it.each(['ANSWERED', 'DELIVERING'] as const)(
    'a %s card found at startup is closed without reaching onParkedAnswer',
    (cardState) => {
      const card = checkCard();
      state.write((ctx) =>
        updateInboxItem(ctx, card.id, { state: cardState, answer: { choice: 'approve' } }),
      );
      expect(checkInbox.redeliver(card.id).state).toBe('RESOLVED');
      expect(parked).toEqual([]);
      expect(checked).toEqual([]);
    },
  );

  it('answering a closed card again is a conflict that acts on nothing', () => {
    const card = checkCard();
    checkInbox.answer(card.id, { choice: 'approve' });
    expect(() => checkInbox.answer(card.id, { choice: 'approve' })).toThrow(ConflictError);
    expect(checked).toHaveLength(1);
  });
});

describe('a flag with a fold key', () => {
  function refusal() {
    const ws = seedWorkstream(base);
    return {
      projectId: ws.project.id,
      workstreamId: null,
      title: 'Batch not started: the checkout has uncommitted changes',
      body: 'Nothing was pushed.',
      foldKey: 'start-refused:one',
    };
  }
  const inboxEvents = (id: string) =>
    listEventsAfter(state.db, 0, 1000).filter(
      (e) => e.type === EventType.InboxChanged && e.entityId === id,
    );

  it('keeps one open card when it is raised again, and says nothing of the repeat', () => {
    const input = refusal();
    const first = inbox.flag(input);
    const before = inboxEvents(first.id).length;
    const second = inbox.flag({ ...input, body: 'Something else.' });
    expect(second.id).toBe(first.id);
    expect(second.body).toBe('Nothing was pushed.');
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);
    expect(inboxEvents(first.id)).toHaveLength(before);
  });

  it('rewrites the open card and tells the board when the repeat asks to refresh it', () => {
    const input = { ...refusal(), refresh: true };
    const first = inbox.flag(input);
    const before = inboxEvents(first.id).length;
    const second = inbox.flag({ ...input, body: 'b.txt is in the way.', detail: { n: 2 } });
    expect(second.id).toBe(first.id);
    expect(second.body).toBe('b.txt is in the way.');
    expect(second.detail).toEqual({ n: 2 });
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);
    expect(inboxEvents(first.id)).toHaveLength(before + 1);
  });

  it('opens a new card once the first was dismissed', () => {
    const input = refusal();
    const first = inbox.flag(input);
    inbox.answer(first.id, { choice: 'dismiss' });
    expect(inbox.flag(input).id).not.toBe(first.id);
  });

  it('rewords an open card title with its body, and leaves a dismissed card as it was', () => {
    const input = refusal();
    const first = inbox.flag(input);
    inbox.reword(first.id, 'b.txt is in the way.', { title: 'Batch not started: b.txt' });
    expect(getInboxItem(state.db, first.id)).toMatchObject({
      title: 'Batch not started: b.txt',
      body: 'b.txt is in the way.',
      state: 'OPEN',
    });

    inbox.answer(first.id, { choice: 'dismiss' });
    inbox.reword(first.id, 'c.txt is in the way.', { title: 'Batch not started: c.txt' });
    expect(getInboxItem(state.db, first.id)).toMatchObject({
      title: 'Batch not started: b.txt',
      body: 'b.txt is in the way.',
    });
  });
});

describe('a card 10db closes because its cause is gone', () => {
  function flag(detail: Record<string, string>) {
    const ws = seedWorkstream(base);
    return inbox.flag({
      projectId: ws.project.id,
      workstreamId: null,
      title: 'Batch not started: 10db will not run git',
      body: 'Nothing was pushed.',
      detail,
    });
  }

  it('is resolved by 10db with the reason, keeping the rest of its detail', () => {
    const card = flag({ keep: 'me' });
    const resolved = inbox.resolve(card.id, 'Alpha started');
    expect(resolved).toMatchObject({
      state: 'RESOLVED',
      detail: { keep: 'me', resolution: { by: '10db', reason: 'Alpha started' } },
    });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
    expect(listInbox(state.db, { states: ['RESOLVED'] }).map((i) => i.id)).toEqual([card.id]);
  });

  it('leaves a card the builder already closed as it was', () => {
    const card = flag({});
    inbox.answer(card.id, { choice: 'dismiss' });
    const again = inbox.resolve(card.id, 'Alpha started');
    expect(again.detail).toEqual({});
  });
});
