import {
  AccountKind,
  type AccountId,
  type NextAction,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  createTestStore,
  getAccountRow,
  getTaskMessageRow,
  insertBuilderMessage,
  insertTask,
  markTaskMessagePushedUnder,
  markTaskMessagesPushed,
  seedAccount,
  seedProject,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryKeychain } from '../../test/fixtures';
import { createLauncher } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { ConversationUnreadError, type SessionAdapter } from '../sessions';
import { readBackThread, TAKEN_BEFORE_RESTART } from './read-back';

// Workbench spec §12: a daemon that died with a builder message pushed to a Codex thread and never
// seen taken reads the thread back before it resumes it. A message the thread took is delivered and
// never sent again; one it did not take is sent again; a thread that can't be read is never guessed
// at. The thread's read is Codex's app-server, a child process 10db does not own, so it is stood in
// for here; the rows are real.

const THREAD = 'thr-1';
const U1 = 'c0ffee00-0000-4000-8000-000000000001';
const U2 = 'c0ffee00-0000-4000-8000-000000000002';
const U3 = 'c0ffee00-0000-4000-8000-000000000003';

let close: () => void;
let state: StateStore;
let taskId: TaskId;
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

/** Codex's thread read, standing in for the app-server: what the thread holds, or why it can't be read. */
function thread(held: readonly string[] | string) {
  const reads: string[] = [];
  const adapter: Pick<SessionAdapter, 'readClientUuids'> = {
    readClientUuids: (spec) => {
      reads.push(spec.providerSessionId);
      return typeof held === 'string'
        ? Promise.reject(new ConversationUnreadError(held))
        : Promise.resolve(held);
    },
  };
  return { adapter, reads };
}

const launcher = createLauncher({ base: {}, clientApp: 'test', keychain: createMemoryKeychain() });

const RESUMED: NextAction = {
  kind: 'resume',
  providerSessionId: THREAD,
  reason: TAKEN_BEFORE_RESTART,
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

    const answer = await readBackThread(
      { state, adapter, launcher },
      {
        taskId,
        account: getAccountRow(state.db, account === 'claude' ? claude : codex),
        cwd: '/w/checkout',
        action: action(ids),
      },
    );

    expect(answer).toEqual({ kind: 'read', action: launches(ids) });
    expect(reads).toEqual(read ? [THREAD] : []);
    for (const [name, id] of Object.entries(ids))
      expect(getTaskMessageRow(state.db, id).deliveredAt !== null).toBe(delivered.includes(name));
  });

  it('never guesses at a thread it cannot read: it says why, marking nothing', async () => {
    const m = message('m', [U1]);
    const { adapter } = thread(`Codex could not read back thread ${THREAD}: an error from Codex`);

    const answer = await readBackThread(
      { state, adapter, launcher },
      { taskId, account: getAccountRow(state.db, codex), cwd: '/w/checkout', action: feedback(m) },
    );

    expect(answer.kind).toBe('unread');
    expect(answer.kind === 'unread' ? answer.message : '').toContain(THREAD);
    expect(getTaskMessageRow(state.db, m).deliveredAt).toBeNull();
  });

  it('reads nothing for a message pushed by id alone, under no uuid it could be found by', async () => {
    const m = state.write((ctx) => {
      const row = insertBuilderMessage(ctx, taskId, { body: 'm', files: [] });
      markTaskMessagesPushed(ctx, [row.id]);
      return row.id;
    });
    const { adapter, reads } = thread([U1]);
    const answer = await readBackThread(
      { state, adapter, launcher },
      { taskId, account: getAccountRow(state.db, codex), cwd: '/w/checkout', action: feedback(m) },
    );
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
