import {
  AccountKind,
  type AccountId,
  type NextAction,
  type TaskId,
  type TaskMessageId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createTestStore,
  getAccountRow,
  getTaskMessageRow,
  getWorkstreamRow,
  insertBuilderMessage,
  insertTask,
  insertWorkstream,
  listTaskThread,
  markTaskMessagePushedUnder,
  markTaskMessagesPushed,
  patchWorkstream,
  seedAccount,
  seedProject,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  ConversationUnreadError,
  type ConversationReadSpec,
  type SessionAdapter,
} from '../sessions';
import { readBackThread, THREAD_UNREAD_NOTICE, TURN_CUT_SHORT, type ReadBack } from './read-back';

// Workbench spec §12: a lane that resumes a Codex thread while a builder message pushed to it was
// never seen taken (a restart, a stop) reads the thread back first. A message the thread took is
// delivered and never sent again; one it did not take is sent again; a thread that can't be read
// starts a fresh session that is sent the message again, as Claude's is, and says so on the thread.
// What it decides is kept in the same write, so a launch that goes no further decides nothing twice.
// The thread's read is Codex's app-server, a child process 10db does not own, so it is stood in for
// here; the rows are real.

const THREAD = 'thr-1';
const U1 = 'c0ffee00-0000-4000-8000-000000000001';
const U2 = 'c0ffee00-0000-4000-8000-000000000002';
const U3 = 'c0ffee00-0000-4000-8000-000000000003';

let close: () => void;
let state: StateStore;
let taskId: TaskId;
let workstreamId: WorkstreamId;
let codex: AccountId;
let claude: AccountId;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  const project = seedProject(test.store, { name: 'alpha' });
  taskId = test.store.write((ctx) =>
    insertTask(ctx, project.id, {
      title: 'Settings page',
      acceptanceCriteria: ['x'],
      areas: ['ui'],
    }),
  ).value.id;
  workstreamId = test.store.write((ctx) =>
    insertWorkstream(ctx, taskId, { first: { model: 'gpt-5.6-sol', effort: 'low' } }),
  ).value.id;
  codex = seedAccount(test.store, { kind: AccountKind.CodexSignin, label: 'ChatGPT plan' }).id;
  claude = seedAccount(test.store, {
    kind: AccountKind.ClaudeSubscription,
    label: 'Claude work plan',
  }).id;
});
afterEach(() => {
  close();
});

/** A builder message, pushed under each of `uuids` in turn. */
function message(body: string, uuids: readonly string[]): TaskMessageId {
  return state.write((ctx) => {
    const m = insertBuilderMessage(ctx, taskId, { body, files: [] });
    for (const uuid of uuids) markTaskMessagePushedUnder(ctx, m.id, uuid);
    return m.id;
  });
}

/**
 * Codex's thread read, standing in for the app-server: which of the wanted uuids the thread took, or
 * why it can't be read.
 */
function thread(held: readonly string[] | string) {
  const reads: ConversationReadSpec[] = [];
  const adapter: Pick<SessionAdapter, 'readClientUuids'> = {
    readClientUuids: (spec) => {
      reads.push(spec);
      return typeof held === 'string'
        ? Promise.reject(new ConversationUnreadError(held))
        : Promise.resolve(held.filter((uuid) => spec.wanted.includes(uuid)));
    },
  };
  return { adapter, reads };
}

/** The lane's read-back of the action the workstream holds, as the runner calls it. */
function readBack(
  adapter: Pick<SessionAdapter, 'readClientUuids'>,
  action: NextAction,
  opts: { readonly account?: AccountId; readonly signal?: AbortSignal } = {},
): Promise<ReadBack> {
  state.write((ctx) => {
    patchWorkstream(ctx, workstreamId, null, { nextAction: action });
  });
  return readBackThread(
    { state, adapter, launcher },
    {
      workstreamId,
      fence: null,
      taskId,
      account: getAccountRow(state.db, opts.account ?? codex),
      cwd: '/w/checkout',
      action,
      onUnread: freshOf(action),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    },
  );
}

/** The action a lane starts fresh with: the same message, no conversation to resume. */
const freshOf = (action: NextAction): NextAction =>
  action.kind === 'feedback' ? { ...action, providerSessionId: null } : { kind: 'start' };

const kept = (): NextAction => getWorkstreamRow(state.db, workstreamId).nextAction;
const notices = (): string[] =>
  listTaskThread(state.db, taskId)
    .filter((m) => m.author === 'system')
    .map((m) => m.body);

const launcher = createLauncher({ base: {}, clientApp: 'test', keychain: createMemoryKeychain() });

const RESUMED: NextAction = {
  kind: 'resume',
  providerSessionId: THREAD,
  reason: TURN_CUT_SHORT,
};

describe('reading a Codex thread back before it is resumed', () => {
  it.each<{
    readonly name: string;
    /** The messages, by name, each pushed under the uuids listed. */
    readonly messages: Readonly<Record<string, readonly string[]>>;
    /** The action the lane would launch, naming the message it carries by name. */
    readonly action: (ids: Readonly<Record<string, TaskMessageId>>) => NextAction;
    readonly held: readonly string[];
    readonly account?: 'codex' | 'claude';
    /** Whether the thread is read at all. */
    readonly read: boolean;
    readonly delivered: readonly string[];
    readonly launches: (ids: Readonly<Record<string, TaskMessageId>>) => NextAction;
  }>([
    {
      name: 'the message it resumes for was taken: it is delivered and the thread resumes without it',
      messages: { m: [U1] },
      action: (ids) => feedback(ids['m']),
      held: [U1],
      read: true,
      delivered: ['m'],
      launches: () => RESUMED,
    },
    {
      name: 'the message it resumes for was not taken: it is sent again',
      messages: { m: [U1] },
      action: (ids) => feedback(ids['m']),
      held: [U3],
      read: true,
      delivered: [],
      launches: (ids) => feedback(ids['m']),
    },
    {
      name: 'the message was taken under the uuid it was pushed again under',
      messages: { m: [U1, U2] },
      action: (ids) => feedback(ids['m']),
      held: [U2],
      read: true,
      delivered: ['m'],
      launches: () => RESUMED,
    },
    {
      name: 'a message the thread was steered took is delivered, the action left as it is',
      messages: { n: [U2] },
      action: () => RESUMED,
      held: [U1, U2],
      read: true,
      delivered: ['n'],
      launches: () => RESUMED,
    },
    {
      name: 'of two, only the one the thread took is delivered',
      messages: { m: [U1], n: [U2] },
      action: (ids) => feedback(ids['m']),
      held: [U2],
      read: true,
      delivered: ['n'],
      launches: (ids) => feedback(ids['m']),
    },
    {
      name: 'the project runs on Claude: nothing is read, and the message is pushed again',
      messages: { m: [U1] },
      action: (ids) => feedback(ids['m']),
      held: [U1],
      account: 'claude',
      read: false,
      delivered: [],
      launches: (ids) => feedback(ids['m']),
    },
    {
      name: 'the lane starts fresh: there is no thread to read',
      messages: { m: [U1] },
      action: (ids) => feedback(ids['m'], null),
      held: [U1],
      read: false,
      delivered: [],
      launches: (ids) => feedback(ids['m'], null),
    },
    {
      name: 'no message was pushed: nothing is read',
      messages: { m: [] },
      action: (ids) => feedback(ids['m']),
      held: [],
      read: false,
      delivered: [],
      launches: (ids) => feedback(ids['m']),
    },
  ])('$name', async ({ messages, action, held, account, read, delivered, launches }) => {
    const ids = Object.fromEntries(
      Object.entries(messages).map(([name, uuids]) => [name, message(name, uuids)]),
    );
    const { adapter, reads } = thread(held);

    const answer = await readBack(adapter, action(ids), {
      account: account === 'claude' ? claude : codex,
    });

    expect(answer).toEqual({ kind: 'read', action: launches(ids) });
    // The action decided is kept, in the write that marks what the thread took.
    expect(kept()).toEqual(launches(ids));
    expect(reads.map((r) => r.providerSessionId)).toEqual(read ? [THREAD] : []);
    for (const [name, id] of Object.entries(ids))
      expect(getTaskMessageRow(state.db, id).deliveredAt !== null).toBe(delivered.includes(name));
    expect(notices()).toEqual([]);
  });

  it('looks only for the uuids of the messages in doubt, in turns since the oldest was written', async () => {
    const m = message('m', [U1, U2]);
    const n = message('n', [U3]);
    const { adapter, reads } = thread([]);
    await readBack(adapter, feedback(m));
    expect(reads[0]?.wanted).toEqual([U1, U2, U3]);
    expect(reads[0]?.since).toBe(getTaskMessageRow(state.db, m).createdAt);
    expect(getTaskMessageRow(state.db, n).deliveredAt).toBeNull();
  });

  it.each<[string, (m: TaskMessageId) => NextAction, (m: TaskMessageId) => NextAction]>([
    ['resumed for the message', (m) => feedback(m), (m) => feedback(m, null)],
    [
      'resumed after a crash',
      () => ({ kind: 'resume', providerSessionId: THREAD, reason: 'x' }),
      () => ({ kind: 'start' }),
    ],
  ])(
    'never guesses at a thread it cannot read, %s: it starts fresh, sends the message again and says so',
    async (_name, action, fresh) => {
      const m = message('m', [U1]);
      const { adapter } = thread(`Codex could not read back thread ${THREAD}: an error from Codex`);

      const answer = await readBack(adapter, action(m));

      expect(answer).toEqual({ kind: 'read', action: fresh(m) });
      expect(kept()).toEqual(fresh(m));
      expect(notices()).toEqual([THREAD_UNREAD_NOTICE]);
      // Still in doubt: the fresh session is sent it again, under a uuid of its own.
      expect(getTaskMessageRow(state.db, m).deliveredAt).toBeNull();
    },
  );

  it('stops at once with the lane, deciding and keeping nothing', async () => {
    const m = message('m', [U1]);
    const stop = new AbortController();
    const adapter: Pick<SessionAdapter, 'readClientUuids'> = {
      readClientUuids: (spec) =>
        new Promise((_, reject) => {
          spec.signal?.addEventListener('abort', () => {
            reject(new ConversationUnreadError('the read was stopped'));
          });
        }),
    };
    const reading = readBack(adapter, feedback(m), { signal: stop.signal });
    stop.abort();

    expect(await reading).toEqual({ kind: 'stopped' });
    expect(kept()).toEqual(feedback(m));
    expect(notices()).toEqual([]);
  });

  it('reads nothing for a message pushed by id alone, under no uuid it could be found by', async () => {
    const m = state.write((ctx) => {
      const row = insertBuilderMessage(ctx, taskId, { body: 'm', files: [] });
      markTaskMessagesPushed(ctx, [row.id]);
      return row.id;
    });
    const { adapter, reads } = thread([U1]);
    const answer = await readBack(adapter, feedback(m));
    expect(answer).toEqual({ kind: 'read', action: feedback(m) });
    expect(reads).toEqual([]);
  });
});

function feedback(
  messageId: TaskMessageId | undefined,
  providerSessionId: string | null = THREAD,
): NextAction {
  if (messageId === undefined) throw new Error('no such message in the row');
  return { kind: 'feedback', messageId, providerSessionId };
}
