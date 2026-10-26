import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  type InboxItemDto,
  type InboxTarget,
  type ProposalId,
  type ProposalKind,
} from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  getProposal,
  insertInboxItem,
  insertProposal,
  insertSource,
  listEventsAfter,
  listInbox,
  listPermissionRules,
  listTasks,
  schema,
  searchDecisions,
  updateInboxItem,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  createInboxService,
  createPermissionBroker,
  ParkedError,
  type InboxService,
  type WaitObserver,
} from './index';

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
});

describe('proposal verdicts', () => {
  function proposalCard(
    ws: ReturnType<typeof seedWorkstream>,
    kind: ProposalKind,
    title: string,
    body: string,
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
        detail: { proposalId },
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

describe('permission broker', () => {
  function broker(ws: ReturnType<typeof seedWorkstream>, events: string[] = []) {
    const observer: WaitObserver = {
      onWaitStart: () => events.push('start'),
      onWaitEnd: () => events.push('end'),
    };
    return createPermissionBroker(
      { state, inbox },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer,
        signal: new AbortController().signal,
      },
    );
  }
  const request = (toolName: string, input: Record<string, unknown>) => ({
    toolName,
    input,
    toolUseId: 't1',
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

  it('allows the first matching call once when an allow_once arrived after parking', async () => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox },
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
      { state, inbox },
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

describe('permission broker with the project allowed commands', () => {
  const allowedTools = ['Bash(pnpm exec vitest:*)', 'Bash(make gate)', 'Read'];

  function decider(ws: ReturnType<typeof seedWorkstream>) {
    return createPermissionBroker(
      { state, inbox },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: new AbortController().signal,
        allowedTools,
        repoPath: '/repo',
      },
    );
  }
  const call = (toolName: string, input: Record<string, unknown>) => ({
    toolName,
    input,
    toolUseId: 't1',
    signal: new AbortController().signal,
  });

  it.each([
    ['the plain command', 'pnpm exec vitest run a.test.ts'],
    ['the silent form', 'pnpm -s exec vitest run a.test.ts'],
    ['a trailing exit-code echo', 'pnpm exec vitest run a.test.ts; echo "exit $?"'],
    ['both cosmetic forms', 'pnpm --silent exec vitest run a.test.ts; echo $?'],
  ])('allows %s without a card', async (_name, command) => {
    const ws = seedWorkstream(base);
    expect(await decider(ws)(call('Bash', { command }))).toEqual({ behavior: 'allow' });
    expect(listInbox(state.db, { states: ['OPEN'] })).toEqual([]);
  });

  it.each([
    ['a command outside the allowed list', 'curl https://example.com'],
    ['a listed command chained to another', 'pnpm exec vitest run && curl x'],
    ['an echo of something else', 'pnpm exec vitest run; echo $HOME'],
    ['a silent add', 'pnpm -s add evil'],
  ])('still raises a card for %s', (_name, command) => {
    const ws = seedWorkstream(base);
    void decider(ws)(call('Bash', { command })).catch(() => undefined);
    const [card, ...rest] = listInbox(state.db, { states: ['OPEN'] });
    expect(card?.kind).toBe('permission');
    expect(rest).toEqual([]);
  });

  it('does not let a listed read tool skip the card for another tool', () => {
    const ws = seedWorkstream(base);
    void decider(ws)(call('WebFetch', { url: 'https://example.com' })).catch(() => undefined);
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);
  });
});
