import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountKind, mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ManualClock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { silentLogger } from '../log';
import { codexHomes } from './codex-home';
import { readThreadClientUuids, THREAD_READ_MS } from './codex-thread-read';
import { fakeAppServer, type FakeAppServer } from './codex-test-support';
import { ConversationUnreadError, type ConversationReadSpec } from './types';

// Workbench spec §12: after a restart, 10db reads a Codex thread back, without running a turn, to
// tell whether a message it pushed before was taken. Codex's app-server is a child process 10db does
// not own, so these run against a fake of it; the live test runs the real one.

let root: string;
let checkout: string;
let codexHome: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-thread-read-')));
  checkout = join(root, 'checkout');
  codexHome = join(root, 'account-home');
  await mkdir(checkout);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const Cursor = z.looseObject({ cursor: z.string().nullable().optional() });

const INITIALIZE = { userAgent: `codex/${CODEX_VERIFIED_ON}`, codexHome: '/h/codex' };

const userMessage = (clientId: string | null) => ({
  type: 'userMessage',
  id: `item-${String(clientId)}`,
  clientId,
  content: [{ type: 'text', text: 'Make it blue', text_elements: [] }],
});
const turn = (id: string, items: readonly unknown[]) => ({
  id,
  status: 'completed',
  items,
  itemsView: 'full',
});

function specOf(over: Partial<ConversationReadSpec> = {}): ConversationReadSpec {
  return {
    account: {
      accountId: mintId('Account'),
      label: 'ChatGPT plan',
      kind: AccountKind.CodexSignin,
      identity: 'me@example.com · ws-1',
    },
    env: { PATH: '/usr/bin', CODEX_HOME: codexHome },
    cwd: checkout,
    providerSessionId: 'thr-1',
    ...over,
  };
}

function read(server: FakeAppServer, spec = specOf(), clock = new ManualClock()) {
  return readThreadClientUuids(spec, {
    codexPath: '/opt/codex',
    logger: silentLogger,
    spawn: server.spawn,
    clock,
    homes: codexHomes(),
  });
}

describe('reading a Codex thread back', () => {
  it("answers the client uuid of every user message on every page of the thread's turns, and closes the child", async () => {
    const server = fakeAppServer({
      initialize: INITIALIZE,
      'thread/turns/list': (params: unknown) => {
        const cursor = Cursor.parse(params).cursor ?? null;
        return cursor === null
          ? {
              data: [
                turn('turn-3', [userMessage('u3'), { type: 'agentMessage', id: 'a', text: 'x' }]),
              ],
              nextCursor: 'page-2',
            }
          : {
              data: [turn('turn-1', [userMessage('u1'), userMessage(null), userMessage('u2')])],
              nextCursor: null,
            };
      },
    });

    expect(await read(server)).toEqual(['u3', 'u1', 'u2']);

    const lists = server.sent().filter((r) => r.method === 'thread/turns/list');
    expect(lists.map((r) => r.params)).toEqual([
      { threadId: 'thr-1', itemsView: 'full', cursor: null },
      { threadId: 'thr-1', itemsView: 'full', cursor: 'page-2' },
    ]);
    // Nothing that runs a turn, or loads the thread to run one, is asked.
    expect(server.sent().map((r) => r.method)).toEqual([
      'initialize',
      'initialized',
      'thread/turns/list',
      'thread/turns/list',
    ]);
    expect(server.killed()).toBe(true);
  });

  it("runs the child with the account's home and its empty HOME", async () => {
    let env: Readonly<Record<string, string>> = {};
    const server = fakeAppServer({
      initialize: INITIALIZE,
      'thread/turns/list': { data: [], nextCursor: null },
    });
    await readThreadClientUuids(specOf(), {
      codexPath: '/opt/codex',
      logger: silentLogger,
      spawn: (_path, given) => {
        env = given;
        return server.child;
      },
      clock: new ManualClock(),
      homes: codexHomes(),
    });
    expect(env['CODEX_HOME']).toBe(codexHome);
    expect(env['HOME']).toBe(codexHomes()(codexHome).emptyHome);
  });

  it.each([
    [
      'Codex answers an error, which names nothing it printed',
      {
        'thread/turns/list': {
          error: { code: -32600, message: 'thread not loaded: me@example.com' },
        },
      },
    ],
    ['a page is not the shape 10db reads', { 'thread/turns/list': { data: 'nope' } }],
    ['initialize fails', { initialize: { error: { code: -32000, message: 'no' } } }],
  ])('refuses with the thread named when %s, and closes the child', async (_name, script) => {
    const server = fakeAppServer({
      initialize: INITIALIZE,
      'thread/turns/list': { data: [], nextCursor: null },
      ...script,
    });
    const failure = await read(server).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConversationUnreadError);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('thr-1');
    expect(message).not.toContain('me@example.com');
    expect(server.killed()).toBe(true);
  });

  it('refuses when Codex does not answer in time, and closes the child', async () => {
    const clock = new ManualClock();
    const server = fakeAppServer({
      initialize: INITIALIZE,
      'thread/turns/list': () => new Promise(() => undefined),
    });
    const reading = read(server, specOf(), clock).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(server.sent().map((r) => r.method)).toContain('thread/turns/list');
    });
    clock.advance(THREAD_READ_MS);
    expect(await reading).toBeInstanceOf(ConversationUnreadError);
    expect(server.killed()).toBe(true);
  });

  it('refuses an account with no CODEX_HOME, starting nothing', async () => {
    const server = fakeAppServer({ initialize: INITIALIZE });
    const failure = await read(server, specOf({ env: { PATH: '/usr/bin' } })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConversationUnreadError);
    expect(server.sent()).toEqual([]);
  });
});
