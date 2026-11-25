import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintId,
  PermissionChoice,
  ShapeOrigin,
  type ConversationId,
  type InboxItemDto,
  type ProjectId,
  type SessionId,
  type ShapeId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  insertPlanSession,
  listInbox,
  listPermissionRules,
  seedProject,
  shapeConversation,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { protectedReads, SYSTEM_DOC_ROOTS, type FileAccessContext } from '../sandbox';
import type { ToolDecision } from '../sessions';
import { createInboxService, createPermissionBroker, type InboxService } from './index';

// A Plan conversation's session asks through the lanes' broker (Shape spec §5.2): a card with no lane
// to wait on, offering no workstream rule, withdrawn when the conversation stops waiting on it.

const NO_GIT = {
  commitAt: () => Promise.reject(new Error('no repository')),
  folderAt: () => Promise.reject(new Error('no repository')),
  fileAt: () => Promise.resolve({ kind: 'missing' as const }),
};

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let inbox: InboxService;
let root: string;
let fileAccess: FileAccessContext;
let waits: string[];

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  root = realpathSync(mkdtempSync(join(tmpdir(), '10db-shape-broker-')));
  const home = join(root, 'home');
  const checkout = join(root, 'repo');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(root, 't', '10db-ownabc'), { recursive: true });
  fileAccess = {
    checkout,
    home,
    protectedReads: protectedReads({ home, dataDir: join(root, 'data'), configDirs: [] }),
    readList: [],
    systemDocRoots: SYSTEM_DOC_ROOTS,
    configDir: join(home, '.claude'),
    providerSessionId: null,
    sandboxTemp: { roots: [join(root, 't')], own: join(root, 't', '10db-ownabc') },
  };
  waits = [];
});
afterEach(() => {
  close();
  rmSync(root, { recursive: true, force: true });
});

function conversation(project = seedProject(base)): {
  projectId: ReturnType<typeof seedProject>['id'];
  shapeId: ShapeId;
  conversationId: ConversationId;
} {
  const shape = base.write(
    (ctx) =>
      insertPlanSession(ctx, {
        projectId: project.id,
        title: 'Audit',
        origin: ShapeOrigin.App,
        tabPosition: null,
      }).shape,
  );
  return {
    projectId: project.id,
    shapeId: shape.value.id,
    conversationId: shapeConversation(base.db, shape.value.id).id,
  };
}

function shapeBroker(
  owner: ReturnType<typeof conversation>,
  signal: AbortSignal = new AbortController().signal,
  mcpApproved?: Record<string, string>,
) {
  return createPermissionBroker(
    { state, inbox, git: NO_GIT, logger: silentLogger },
    {
      projectId: owner.projectId,
      workstreamId: null,
      conversationId: owner.conversationId,
      shapeId: owner.shapeId,
      sessionId: mintId('Session'),
      observer: {
        onWaitStart: (item) => waits.push(`start ${item.title}`),
        onWaitEnd: (item) => waits.push(`end ${item.title}`),
      },
      signal,
      ...(mcpApproved === undefined ? {} : { mcpApproved }),
      sandbox: { fileAccess, hazards: [], commandsAsk: true },
    },
  );
}

const request = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
) => ({
  toolName,
  input,
  toolUseId: 't1',
  escalated: false,
  signal,
});

const openCards = (): InboxItemDto[] => listInbox(state.db, { states: ['OPEN'] });
function onlyOpenCard(): InboxItemDto {
  const [card, ...rest] = openCards();
  if (!card || rest.length > 0) throw new Error('expected exactly one open card');
  return card;
}
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('a Plan conversation asks through the permission broker', () => {
  const asked = [
    { name: 'a command that is not read-only', toolName: 'Bash', input: { command: 'pnpm test' } },
    {
      name: 'a command with no hazard, which a lane would run unasked',
      toolName: 'Bash',
      input: { command: 'node scripts/report.mjs' },
    },
    {
      name: 'a tool of an approved MCP server',
      toolName: 'mcp__aws-billing__cost-explorer',
      input: { operation: 'getCostAndUsage' },
    },
  ];

  it.each(asked)('cards $name, for the conversation and no lane', async (row) => {
    const owner = conversation();
    const pending = shapeBroker(owner)(request(row.toolName, row.input));
    const card = onlyOpenCard();
    expect(card.kind).toBe('permission');
    expect(card.title).toBe(`Allow ${row.toolName}?`);
    expect(card.targets).toEqual([]);
    expect(card.detail?.['shapeId']).toBe(owner.shapeId);
    expect(card.detail?.['conversationId']).toBe(owner.conversationId);
    expect(card.options.map((o) => o.label)).toEqual([
      PermissionChoice.AllowOnce,
      PermissionChoice.AllowProject,
      PermissionChoice.Deny,
    ]);
    expect(waits).toEqual([`start Allow ${row.toolName}?`]);
    inbox.answer(card.id, { choice: PermissionChoice.AllowOnce });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(waits).toEqual([`start Allow ${row.toolName}?`, `end Allow ${row.toolName}?`]);
  });

  it('passes a denial and its note back to the session', async () => {
    const owner = conversation();
    const pending = shapeBroker(owner)(request('Bash', { command: 'pnpm test' }));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny, note: 'read the code' });
    const decision: ToolDecision = await pending;
    expect(decision.behavior).toBe('deny');
    expect(decision.behavior === 'deny' ? decision.message : '').toContain('read the code');
  });

  it('stores Always allow as a project rule that answers the next conversation without a card', async () => {
    const owner = conversation();
    const first = shapeBroker(owner)(request('mcp__aws-billing__cost-explorer', { a: 1 }));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowProject });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(
      listPermissionRules(state.db, owner.projectId, null).map((r) => [
        r.toolName,
        r.pattern,
        r.workstreamId,
      ]),
    ).toEqual([['mcp__aws-billing__cost-explorer', null, null]]);
    const again = await shapeBroker(owner)(request('mcp__aws-billing__cost-explorer', { a: 2 }));
    expect(again).toEqual({ behavior: 'allow' });
    expect(openCards()).toEqual([]);
  });

  it('offers the server choice on a project tool only, and it covers the next conversation', async () => {
    const hash = 'e'.repeat(64);
    const listed = ['mcp__aws-billing__cost-explorer', 'mcp__aws-billing__credits'];
    const owner = conversation();
    // A command is not a project tool: no server choice.
    void shapeBroker(owner, undefined, { 'aws-billing': hash })({
      ...request('Bash', { command: 'pnpm test' }),
      listedTools: listed,
    }).catch(() => undefined);
    expect(onlyOpenCard().options.map((o) => o.label)).toEqual([
      PermissionChoice.AllowOnce,
      PermissionChoice.AllowProject,
      PermissionChoice.Deny,
    ]);
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny });
    await settle();

    const first = shapeBroker(owner, undefined, { 'aws-billing': hash })({
      ...request('mcp__aws-billing__cost-explorer', { a: 1 }),
      listedTools: listed,
    });
    expect(onlyOpenCard().options.map((o) => o.label)).toEqual([
      PermissionChoice.AllowOnce,
      PermissionChoice.AllowProject,
      PermissionChoice.AllowMcpServer,
      PermissionChoice.Deny,
    ]);
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowMcpServer });
    expect(await first).toEqual({ behavior: 'allow' });
    const next = await shapeBroker(owner, undefined, { 'aws-billing': hash })(
      request('mcp__aws-billing__credits', {}),
    );
    expect(next).toEqual({ behavior: 'allow' });
    expect(openCards()).toEqual([]);
  });

  it('runs a command a stored project rule covers without a card', async () => {
    const owner = conversation();
    const first = shapeBroker(owner)(request('Bash', { command: 'pnpm test' }));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowProject });
    await first;
    expect(await shapeBroker(owner)(request('Bash', { command: 'pnpm test' }))).toEqual({
      behavior: 'allow',
    });
    expect(openCards()).toEqual([]);
  });

  it('withdraws its card when the conversation stops waiting, and the call is refused', async () => {
    const owner = conversation();
    const controller = new AbortController();
    const pending = shapeBroker(owner, controller.signal)(request('Bash', { command: 'make' }));
    const card = onlyOpenCard();
    controller.abort();
    const decision = await pending;
    expect(decision.behavior).toBe('deny');
    expect(openCards()).toEqual([]);
    expect(listInbox(state.db, { states: ['CANCELLED'] }).map((c) => c.id)).toEqual([card.id]);
  });

  it('never folds its card into a lane card for the same host, in the same project', async () => {
    const ws = seedWorkstream(base);
    const owner = conversation(ws.project);
    const lane = createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: ws.project.id,
        workstreamId: ws.workstream.id,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: new AbortController().signal,
        sandbox: { fileAccess, hazards: [] },
      },
    );
    await shapeBroker(owner)(request('SandboxNetworkAccess', { host: 'pypi.org' }));
    await lane(request('SandboxNetworkAccess', { host: 'pypi.org' }));
    await settle();
    const cards = openCards();
    expect(cards).toHaveLength(2);
    expect(cards.filter((c) => c.targets.length === 0).map((c) => c.detail?.['shapeId'])).toEqual([
      owner.shapeId,
    ]);
  });

  it('gives two identical calls of one session a card each, and answers both', async () => {
    const owner = conversation();
    const broker = shapeBroker(owner);
    const first = broker(request('Bash', { command: 'pnpm list --depth 0' }));
    const second = broker(request('Bash', { command: 'pnpm list --depth 0' }));
    const cards = openCards();
    expect(cards).toHaveLength(2);
    for (const card of cards) inbox.answer(card.id, { choice: PermissionChoice.AllowOnce });
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await second).toEqual({ behavior: 'allow' });
  });

  it('withdraws the card of a call Claude Code cancelled, and refuses the call', async () => {
    const owner = conversation();
    const call = new AbortController();
    const pending = shapeBroker(owner)(request('Bash', { command: 'make' }, call.signal));
    const card = onlyOpenCard();
    call.abort();
    expect((await pending).behavior).toBe('deny');
    expect(listInbox(state.db, { states: ['CANCELLED'] }).map((c) => c.id)).toEqual([card.id]);
  });

  it('withdraws its host card when the conversation stops waiting', async () => {
    const owner = conversation();
    const ending = new AbortController();
    await shapeBroker(owner, ending.signal)(request('SandboxNetworkAccess', { host: 'pypi.org' }));
    const card = onlyOpenCard();
    ending.abort();
    await settle();
    expect(openCards()).toEqual([]);
    expect(listInbox(state.db, { states: ['CANCELLED'] }).map((c) => c.id)).toEqual([card.id]);
  });

  it('refuses an unlisted host and asks about it once, as for a lane', async () => {
    const owner = conversation();
    const broker = shapeBroker(owner);
    const decision = await broker(request('SandboxNetworkAccess', { host: 'pypi.org' }));
    expect(decision.behavior).toBe('deny');
    await broker(request('SandboxNetworkAccess', { host: 'pypi.org' }));
    const card = onlyOpenCard();
    expect(card.title).toBe('Allow network access to pypi.org?');
    expect(card.detail?.['shapeId']).toBe(owner.shapeId);
  });
});

describe("a chat's card never folds", () => {
  type Asker =
    { workstreamId: null; conversationId: ConversationId } | { workstreamId: WorkstreamId };
  const ask = (projectId: ProjectId, owner: Asker, sessionId: SessionId) =>
    inbox.ask({
      ...owner,
      projectId,
      sessionId,
      kind: 'permission',
      title: 'Retire a principle?',
      body: 'The chat asks to retire a principle.',
      options: [
        { label: PermissionChoice.AllowOnce, description: 'Allow this once' },
        { label: PermissionChoice.Deny, description: 'Deny' },
      ],
      recommendation: null,
      category: 'access',
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    });
  const chat = (): Asker => ({ workstreamId: null, conversationId: mintId('Conversation') });
  const rows: {
    name: string;
    askers: (lane: WorkstreamId) => [Asker, Asker];
    oneSession: boolean;
  }[] = [
    { name: 'two chats on one project', askers: () => [chat(), chat()], oneSession: false },
    {
      name: 'two parallel calls in one chat',
      askers: () => {
        const one = chat();
        return [one, one];
      },
      oneSession: true,
    },
    {
      name: "a chat's card beside a lane's identical card",
      askers: (lane) => [{ workstreamId: lane }, chat()],
      oneSession: false,
    },
  ];

  it.each(rows)('$name: a card each, and each answer reaches only its own call', async (row) => {
    const ws = seedWorkstream(base);
    const [a, b] = row.askers(ws.workstream.id);
    const session = mintId('Session');
    const first = ask(ws.project.id, a, session);
    const second = ask(ws.project.id, b, row.oneSession ? session : mintId('Session'));
    expect(second.item.id).not.toBe(first.item.id);
    expect(openCards()).toHaveLength(2);
    inbox.answer(second.item.id, { choice: PermissionChoice.Deny });
    expect((await second.answer).choice).toBe(PermissionChoice.Deny);
    expect(getInboxItem(state.db, first.item.id).state).toBe('OPEN');
    inbox.answer(first.item.id, { choice: PermissionChoice.AllowOnce });
    expect((await first.answer).choice).toBe(PermissionChoice.AllowOnce);
  });
});

describe("a chat's command outside the sandbox", () => {
  const outside = (command: string, description?: string) =>
    request('Bash', {
      command,
      dangerouslyDisableSandbox: true,
      ...(description === undefined ? {} : { description }),
    });
  let refusal: string | null;
  let changes = 0;
  let background = false;
  let backgrounded = false;

  function chatBroker(owner: ReturnType<typeof conversation>) {
    return createPermissionBroker(
      { state, inbox, git: NO_GIT, logger: silentLogger },
      {
        projectId: owner.projectId,
        workstreamId: null,
        conversationId: owner.conversationId,
        chat: true,
        sessionId: mintId('Session'),
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        signal: new AbortController().signal,
        sandbox: {
          fileAccess,
          hazards: [],
          commandsAsk: true,
          unsandboxed: {
            mayRun: () => refusal,
            changes: () => changes,
            bump: () => {
              changes += 1;
            },
            background: () => background,
            remembers: () => !backgrounded,
          },
        },
      },
    );
  }

  beforeEach(() => {
    refusal = null;
    changes = 0;
    background = false;
    backgrounded = false;
  });

  it('asks with three answers, remembers only the exact command for the session, and stores no rule', async () => {
    const owner = conversation();
    const broker = chatBroker(owner);
    const first = broker(
      outside('pnpm test', 'Run the tests\n\nThis command is read-only and safe.'),
    );
    const card = onlyOpenCard();
    expect(card.title).toBe('Run this outside the sandbox?');
    expect(card.detail?.['unsandboxed']).toBe(true);
    // The command leads the body, so the Inbox shows it too; then what Claude says, quoted on one line, so it
    // can't add a paragraph that passes for 10db's; then the warning.
    const [command, said, ...rest] = card.body.split('\n\n');
    expect(command).toBe('pnpm test');
    expect(said).toBe('Claude says: “Run the tests This command is read-only and safe.”');
    expect(rest).toHaveLength(1);
    expect(card.options.map((o) => o.label)).toEqual([
      PermissionChoice.AllowOnce,
      PermissionChoice.AllowChat,
      PermissionChoice.Deny,
    ]);
    inbox.answer(card.id, { choice: PermissionChoice.AllowChat });
    expect(await first).toEqual({ behavior: 'allow' });
    // The identical call goes through unasked; another command, and another session, ask again.
    expect(await broker(outside('pnpm test'))).toEqual({ behavior: 'allow' });
    expect(openCards()).toEqual([]);
    // A change since the yes (a file edited, another command run) makes the same call ask again, in another
    // folder too; with nothing changed after that yes, it is remembered afresh.
    changes += 1;
    const afterChange = broker(outside('pnpm test'));
    expect(onlyOpenCard().title).toBe('Run this outside the sandbox?');
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    expect(await afterChange).toEqual({ behavior: 'allow' });
    expect(await broker(outside('pnpm test'))).toEqual({ behavior: 'allow' });
    // Another command allowed once, outside the sandbox, may have changed what this one runs: it asks again.
    const other = broker(outside('pnpm build'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowOnce });
    await other;
    const afterOther = broker(outside('pnpm test'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    await afterOther;
    // A background task still running may write, so a remembered call asks again until it ends.
    background = true;
    const whileRunning = broker(outside('pnpm test'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    await whileRunning;
    background = false;
    // Once the session has started something in the background, nothing is remembered: the same call asks
    // again, and its card offers no chat answer.
    backgrounded = true;
    const afterBackground = broker(outside('pnpm test'));
    expect(onlyOpenCard().options.map((o) => o.label)).toEqual([
      PermissionChoice.AllowOnce,
      PermissionChoice.Deny,
    ]);
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowOnce });
    await afterBackground;
    backgrounded = false;
    // What was remembered before is gone for good, not only hidden.
    const forgotten = broker(outside('pnpm test'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    await forgotten;
    const elsewhere = broker({ ...outside('pnpm test'), cwd: '/other' });
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny });
    await elsewhere;
    void broker(outside('pnpm build')).catch(() => undefined);
    expect(onlyOpenCard().detail?.['summary']).toBe('pnpm build');
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny, note: 'use the gate' });
    await settle();
    void chatBroker(owner)(outside('pnpm test')).catch(() => undefined);
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny });
    await settle();
    expect(listPermissionRules(state.db, owner.projectId, null)).toEqual([]);
  });

  it('denies a yes once the turn no longer holds the checkout, and a remembered call too', async () => {
    const owner = conversation();
    const broker = chatBroker(owner);
    const first = broker(outside('pnpm test'));
    refusal = 'The turn ended.';
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    expect(await first).toMatchObject({ behavior: 'deny', message: 'The turn ended.' });
    refusal = null;
    // The refused yes remembered nothing.
    const again = broker(outside('pnpm test'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.AllowChat });
    await again;
    refusal = 'A lane holds the checkout now.';
    expect(await broker(outside('pnpm test'))).toMatchObject({ behavior: 'deny' });
  });

  it('tells the chat to try another way, without telling it not to retry', async () => {
    const pending = chatBroker(conversation())(outside('pnpm test'));
    inbox.answer(onlyOpenCard().id, { choice: PermissionChoice.Deny, note: 'run the gate' });
    const decision: ToolDecision = await pending;
    const message = decision.behavior === 'deny' ? decision.message : '';
    expect(message).toContain('run the gate');
    expect(message).toContain('Try another way');
    expect(message).not.toMatch(/do not retry/i);
  });

  it('refuses the call where the session has no such hatch', async () => {
    const owner = conversation();
    const decision = await shapeBroker(owner)(outside('pnpm test'));
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(openCards()).toEqual([]);
  });
});
