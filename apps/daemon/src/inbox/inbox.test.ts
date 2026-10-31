import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConflictError,
  DEFAULT_HAZARDS,
  EventType,
  InboxAnswerRefused,
  type HazardDef,
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
  insertPermissionRule,
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
import { allowFoundHosts, removeNetworkHost } from '../permissions';
import { protectedReads, type FileAccessContext } from '../sandbox';
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
    void decide(request('Bash', { command: 'curl -s https://example.com' }, true)).catch(
      () => undefined,
    );
    expect(onlyOpenCard().kind).toBe('permission');
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
  ) {
    return createPermissionBroker(
      { state, inbox },
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
    { name: 'a variable after pnpm test', command: 'pnpm test $x', outcome: 'allow' },
    { name: 'a glob argument to pnpm run', command: 'pnpm run build *.ts', outcome: 'allow' },
    { name: 'pnpm exec of a known tool', command: 'pnpm exec tsc $x', outcome: 'allow' },
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
    { name: 'eval of a literal', command: 'eval "echo hi"', outcome: 'card' },
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
      outcome: 'allow',
    },
    {
      name: 'pnpm filter= with a quoted value',
      command: 'pnpm --filter="$pkg" test',
      outcome: 'allow',
    },
    { name: 'pnpm -F with a quoted value', command: 'pnpm -F "$p" test', outcome: 'allow' },
    {
      name: 'a loop of pnpm filters',
      command: 'for p in daemon desktop; do pnpm --filter "@10db/$p" test; done',
      outcome: 'allow',
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
    const tasks = (): string =>
      join(fileAccess.sandboxTemp.own, 'claude-501', 'slug', 'own-id', 'tasks');
    const siblingTasks = (): string =>
      join(fileAccess.sandboxTemp.own, 'claude-501', 'slug', 'other-id', 'tasks');
    const otherLaneTasks = (): string =>
      join(fileAccess.sandboxTemp.root, '10db-othabc', 'claude-501', 'slug', 'own-id', 'tasks');

    interface MonitorCase {
      readonly name: string;
      /** The command, given the session's own task output directory. */
      readonly command: (own: string) => string;
      readonly outcome: 'allow' | 'card';
      readonly escalated?: boolean;
    }
    const MONITOR_CASES: readonly MonitorCase[] = [
      // The 2026-10-30 shapes: wait for the file, then read it.
      {
        name: 'until -s, then sleep',
        command: (d) => `until [ -s ${d}/b1.output ]; do sleep 2; done`,
        outcome: 'allow',
      },
      {
        name: 'until grep -q, then sleep',
        command: (d) => `until grep -q "DONE" ${d}/b1.output; do sleep 2; done`,
        outcome: 'allow',
      },
      {
        name: 'until grep with an alternation, quiet to /dev/null',
        command: (d) =>
          `until grep -qE 'passed|failed|Error' ${d}/b1.output 2>/dev/null; do sleep 1; done`,
        outcome: 'allow',
      },
      {
        name: 'the wait, then a grep of the file',
        command: (d) =>
          `until [ -s ${d}/b1.output ]; do sleep 2; done; grep -E "Tests|FAIL" ${d}/b1.output`,
        outcome: 'allow',
      },
      {
        name: 'a while loop that tests for a missing file, then tail',
        command: (d) =>
          `while [ ! -s ${d}/b1.output ]; do sleep 1; done; tail -n 20 ${d}/b1.output`,
        outcome: 'allow',
      },
      { name: 'tail -f of the file', command: (d) => `tail -f ${d}/b1.output`, outcome: 'allow' },
      {
        name: 'tail piped to grep, which names no file',
        command: (d) => `tail -n 50 ${d}/b1.output | grep -i error`,
        outcome: 'allow',
      },
      { name: 'cat of the file', command: (d) => `cat ${d}/b1.output`, outcome: 'allow' },
      {
        name: 'a file not yet written',
        command: (d) => `[ -s ${d}/later.output ]`,
        outcome: 'allow',
      },
      // Reads anywhere else.
      {
        name: 'a file in the checkout',
        command: () => 'until [ -s out.txt ]; do sleep 1; done',
        outcome: 'card',
      },
      {
        name: 'a relative path',
        command: () => 'until [ -s tasks/b1.output ]; do sleep 1; done',
        outcome: 'card',
      },
      { name: 'a system file', command: () => 'cat /etc/passwd', outcome: 'card' },
      {
        name: 'another session of this lane',
        command: () => `cat ${siblingTasks()}/b1.output`,
        outcome: 'card',
      },
      {
        name: 'another lane with the same session id',
        command: () => `cat ${otherLaneTasks()}/b1.output`,
        outcome: 'card',
      },
      { name: 'stdin', command: () => 'grep -q DONE', outcome: 'card' },
      {
        name: 'a path that climbs out',
        command: (d) => `cat ${d}/../../x`,
        outcome: 'card',
      },
      {
        name: 'a link in the task dir that leads out',
        command: (d) => `cat ${d}/link.output`,
        outcome: 'card',
      },
      // Writes.
      {
        name: 'a redirect into the file',
        command: (d) => `echo hi > ${d}/b1.output`,
        outcome: 'card',
      },
      { name: 'an append', command: (d) => `echo hi >> ${d}/b1.output`, outcome: 'card' },
      {
        name: 'a redirect elsewhere',
        command: (d) => `cat ${d}/b1.output > /private/tmp/x`,
        outcome: 'card',
      },
      {
        name: 'an input redirect',
        command: (d) => `grep -q DONE < ${d}/b1.output`,
        outcome: 'card',
      },
      {
        name: 'tee',
        command: (d) => `cat ${d}/b1.output | tee ${d}/b2.output`,
        outcome: 'card',
      },
      { name: 'rm', command: (d) => `rm ${d}/b1.output`, outcome: 'card' },
      { name: 'sed -i', command: (d) => `sed -i s/a/b/ ${d}/b1.output`, outcome: 'card' },
      {
        name: 'grep -f reads a pattern file',
        command: (d) => `grep -f /etc/hosts ${d}/b1.output`,
        outcome: 'card',
      },
      { name: 'grep -r', command: (d) => `grep -r DONE ${d}`, outcome: 'card' },
      // Unread programs and shapes.
      {
        name: 'an unnamed program in the loop',
        command: (d) => `until [ -s ${d}/b1.output ]; do ./wait.sh; done`,
        outcome: 'card',
      },
      {
        name: 'a program from a variable',
        command: (d) => `$CMD ${d}/b1.output`,
        outcome: 'card',
      },
      {
        name: 'a program set by an assignment',
        command: (d) => `X=1 cat ${d}/b1.output`,
        outcome: 'card',
      },
      {
        name: 'a substitution in the path',
        command: (d) => `cat ${d}/$(date).output`,
        outcome: 'card',
      },
      { name: 'a variable in the path', command: (d) => `cat ${d}/$f`, outcome: 'card' },
      { name: 'a glob in the path', command: (d) => `cat ${d}/*.output`, outcome: 'card' },
      {
        name: 'a variable in the pattern',
        command: (d) => `grep "$x" ${d}/b1.output`,
        outcome: 'card',
      },
      { name: 'a sub-shell', command: (d) => `(cat ${d}/b1.output)`, outcome: 'card' },
      {
        name: 'a command run in the background',
        command: (d) => `cat ${d}/b1.output &`,
        outcome: 'card',
      },
      { name: 'sh -c', command: (d) => `sh -c 'cat ${d}/b1.output'`, outcome: 'card' },
      {
        name: 'a hazard after the wait',
        command: (d) => `until [ -s ${d}/b1.output ]; do sleep 1; done; pnpm add zod`,
        outcome: 'card',
      },
      { name: 'an unclosed quote', command: (d) => `cat "${d}/b1.output`, outcome: 'card' },
      {
        name: 'escalated, the plain wait',
        command: (d) => `cat ${d}/b1.output`,
        outcome: 'card',
        escalated: true,
      },
    ];

    beforeEach(() => {
      for (const dir of [tasks(), siblingTasks(), otherLaneTasks()]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'b1.output'), 'x');
      }
      symlinkSync('/etc/hosts', join(tasks(), 'link.output'));
    });

    const cardedTools = () => openCards().map((card) => card.detail?.['toolName']);

    it.each(MONITOR_CASES)('$name -> $outcome', async (c) => {
      const ws = seedWorkstream(base);
      const pending = sandboxed(ws)(
        request(
          'Monitor',
          { command: c.command(tasks()), description: 'wait', timeout_ms: 60000 },
          c.escalated ?? false,
        ),
      );
      pending.catch(() => undefined);
      await settle();
      if (c.outcome === 'allow') {
        expect(cardedTools()).toEqual([]);
        expect(await pending).toEqual({ behavior: 'allow' });
      } else {
        expect(cardedTools()).toEqual(['Monitor']);
      }
    });

    it('cards a call before the session has an id', async () => {
      const ws = seedWorkstream(base);
      fileAccess = { ...fileAccess, providerSessionId: null };
      void sandboxed(ws)(request('Monitor', { command: `cat ${tasks()}/b1.output` })).catch(
        () => undefined,
      );
      await settle();
      expect(cardedTools()).toEqual(['Monitor']);
    });

    it('cards a Monitor call with no command', async () => {
      const ws = seedWorkstream(base);
      void sandboxed(ws)(request('Monitor', { description: 'x' })).catch(() => undefined);
      await settle();
      expect(cardedTools()).toEqual(['Monitor']);
    });

    it('cards Monitor without a sandbox', async () => {
      const ws = seedWorkstream(base);
      void sandboxed(
        ws,
        false,
      )(request('Monitor', { command: `cat ${tasks()}/b1.output` })).catch(() => undefined);
      await settle();
      expect(cardedTools()).toEqual(['Monitor']);
    });
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

  it('cards an edit with the real path and stores a rule for that one path', async () => {
    const ws = seedWorkstream(base);
    const decide = sandboxed(ws);
    const vscode = join(fileAccess.checkout, '.vscode', 'settings.json');
    const pending = decide(request('Edit', { file_path: '.vscode/settings.json' }));
    const card = onlyOpenCard();
    expect(card.detail).toEqual({ toolName: 'Edit', summary: vscode });
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect((await decide(request('Edit', { file_path: vscode }))).behavior).toBe('allow');
    void decide(request('Edit', { file_path: '.claude/hooks/x' })).catch(() => undefined);
    expect(onlyOpenCard().detail).toEqual({
      toolName: 'Edit',
      summary: join(fileAccess.checkout, '.claude', 'hooks', 'x'),
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
      { state, inbox },
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
      { state, inbox },
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
