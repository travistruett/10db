import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintId,
  PermissionChoice,
  ShapeOrigin,
  type InboxItemDto,
  type ShapeId,
} from '@10db/contracts';
import {
  createTestStore,
  insertShape,
  listInbox,
  listPermissionRules,
  seedProject,
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
} {
  const shape = base.write((ctx) =>
    insertShape(ctx, project.id, { title: 'Audit', origin: ShapeOrigin.App }),
  );
  return { projectId: project.id, shapeId: shape.value.id };
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
