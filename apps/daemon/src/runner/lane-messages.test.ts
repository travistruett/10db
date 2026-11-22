import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountKind, idUuid, mintId, Provider, type TaskId } from '@10db/contracts';
import {
  createTestStore,
  getTaskMessageRow,
  insertBuilderMessage,
  insertTask,
  listUndeliveredTaskMessages,
  markTaskFilesInline,
  seedProject,
  type TaskMessageRow,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir, testPolicy } from '../../test/fixtures';
import { pngOfSize } from '../../test/png';
import { createEventBus, createStateStore, type StateStore } from '../events';
import {
  FakeAdapter,
  type FakeScriptBook,
  type InterruptReceipt,
  type SessionHandle,
  type LaneSessionSpec,
} from '../sessions';
import { createLaneMessages, outgoingMessage } from './lane-messages';
import { pictureLimitsFor } from '../conversation';

// Workbench spec §6.3: a builder message reaches a lane session under its row's uuid, and is marked
// delivered only when a turn is seen to take it (`user_message_uuids`, which the fake stamps as the SDK
// does), never because it was pushed. An interrupt leaves a message it names as still queued alone
// and pushes again one that may have been lost.

let close: () => void;
let state: StateStore;
let taskId: TaskId;
let dir: TempDir;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  dir = tempDir('lane-messages');
  const project = seedProject(test.store, { name: 'alpha' });
  taskId = test.store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['ui'] }),
  ).value.id;
});
afterEach(() => {
  close();
  dir.cleanup();
});

const say = (body: string, pictures = 0): TaskMessageRow => {
  const files = Array.from({ length: pictures }, (_, i) => {
    const storedPath = join(dir.path, `${body}-${String(i)}.png`);
    const png = pngOfSize(400, 300);
    writeFileSync(storedPath, png);
    return {
      name: `shot-${String(i)}.png`,
      mediaType: 'image/png' as const,
      size: png.length,
      sha256: 'a'.repeat(64),
      storedPath,
    };
  });
  const id = state.write((ctx) => insertBuilderMessage(ctx, taskId, { body, files })).id;
  return getTaskMessageRow(state.db, id);
};

function startSession(adapter: FakeAdapter): SessionHandle {
  const spec: LaneSessionSpec = {
    sessionId: mintId('Session'),
    conversationId: null,
    policy: testPolicy(),
    profile: { kind: 'lane', workstreamId: mintId('Workstream'), sequence: 1, allowedTools: [] },
    cwd: dir.path,
    prompt: 'Task: Alpha\nDo it.',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    resumeProviderSessionId: null,
    env: {},
    account: {
      accountId: mintId('Account'),
      label: 'Claude plan',
      kind: AccountKind.ClaudeSubscription,
      harness: Provider.Claude,
      identity: null,
    },
    projectMcpServers: {},
    yourMcpServers: {},
    sandbox: null,
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', toolTimeoutMs: 1000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
  };
  return adapter.open(spec);
}

const undelivered = () => listUndeliveredTaskMessages(state.db, taskId).map((m) => m.body);

describe('lane messages', () => {
  it('pushes a message under its uuid with its pictures, and marks it delivered only when a turn lists that uuid', async () => {
    const book: FakeScriptBook = {
      Alpha: [
        [
          { do: 'await_message', contains: 'Second' },
          { do: 'activity', summary: 'Reading both messages' },
          { do: 'consume' },
          { do: 'hang' },
        ],
      ],
    };
    const adapter = new FakeAdapter(book);
    const handle = startSession(adapter);
    const messages = createLaneMessages({
      state,
      taskId,
      handle,
      limits: pictureLimitsFor(AccountKind.ClaudeSubscription),
    });
    const first = say('First', 1);
    const second = say('Second');
    messages.push(first);
    messages.push(second);
    expect(adapter.sent.map((m) => [m.uuid, m.images])).toEqual([
      [idUuid(first.id), 1],
      [idUuid(second.id), 0],
    ]);
    expect(getTaskMessageRow(state.db, first.id).pushedAt).not.toBeNull();
    // The uuid is kept with the row, so a conversation read back after a restart can be matched.
    expect(getTaskMessageRow(state.db, first.id).pushUuids).toEqual([idUuid(first.id)]);
    expect(getTaskMessageRow(state.db, first.id).files[0]?.inlineSent).toBe(true);

    for await (const event of handle.events) {
      if (event.type === 'activity') expect(undelivered()).toEqual(['First', 'Second']);
      if (event.type === 'consumed') {
        expect(messages.consumed(event.uuids)).toEqual([first.id, second.id]);
        break;
      }
    }
    expect(undelivered()).toEqual([]);
    expect(getTaskMessageRow(state.db, second.id).deliveredAt).not.toBeNull();
    // A uuid that is no message of this task is not evidence for any.
    expect(messages.consumed([idUuid(mintId('ConversationItem')), 'not-a-uuid'])).toEqual([]);
    await handle.stop();
  });

  it.each<[string, (untaken: readonly string[]) => InterruptReceipt, string[]]>([
    [
      'every message is named still queued: none is pushed again',
      (untaken) => ({ stillQueued: [...untaken] }),
      [],
    ],
    [
      'only the first is named: the other, not seen taken, is pushed again',
      (untaken) => ({ stillQueued: untaken.slice(0, 1) }),
      ['And bigger'],
    ],
    [
      'there is no receipt: every message is pushed again',
      () => null,
      ['Make it blue', 'And bigger'],
    ],
  ])('after an interrupt where %s, and none is delivered', async (_name, receipt, again) => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'hang' }]] });
    adapter.interruptReceipt = receipt;
    const handle = startSession(adapter);
    const messages = createLaneMessages({
      state,
      taskId,
      handle,
      limits: pictureLimitsFor(AccountKind.ClaudeSubscription),
    });
    messages.push(say('Make it blue'));
    messages.push(say('And bigger'));

    await messages.interrupt();
    expect(adapter.interrupts).toHaveLength(1);
    const pushedAgain = adapter.sent.slice(2);
    expect(pushedAgain.map((m) => m.text.split('\n')[1])).toEqual(again);
    // Sent again under a uuid of its own, which Claude Code would otherwise drop as one it holds,
    // and under the same message id, so the session can tell it is one message.
    for (const repeat of pushedAgain) {
      expect(adapter.sent.slice(0, 2).map((m) => m.uuid)).not.toContain(repeat.uuid);
      expect(adapter.sent.slice(0, 2).map((m) => m.text)).toContain(repeat.text);
    }
    expect(undelivered()).toEqual(['Make it blue', 'And bigger']);
    for (const repeat of pushedAgain) {
      const row = listUndeliveredTaskMessages(state.db, taskId).find((m) =>
        repeat.text.includes(m.id),
      );
      expect(row?.pushUuids.at(-1)).toBe(repeat.uuid);
    }
    // A turn that takes a message under the uuid it was sent again under delivers it.
    expect(messages.consumed(pushedAgain.map((m) => m.uuid ?? ''))).toHaveLength(again.length);
    await handle.stop();
  });

  it('keeps the uuid on the row before the session is handed the message', () => {
    const message = say('Make it blue');
    let keptWhenSent: readonly string[] | null = null;
    // The session boundary: what the row holds at the moment the message is handed over.
    const handle: Pick<SessionHandle, 'send' | 'interrupt'> = {
      send: () => {
        keptWhenSent = getTaskMessageRow(state.db, message.id).pushUuids;
      },
      interrupt: () => Promise.resolve(null),
    };
    const messages = createLaneMessages({
      state,
      taskId,
      handle,
      limits: pictureLimitsFor(AccountKind.CodexSignin),
    });
    messages.push(message);
    expect(keptWhenSent).toEqual([idUuid(message.id)]);
  });

  it('sends Codex every picture as its file on every push, held already or over the budget: a Codex lane cannot open one by its path', () => {
    const shot = say('Make it blue', 2);
    state.write((ctx) => {
      markTaskFilesInline(ctx, taskId, [shot.files[0]?.id ?? mintId('ConversationFile')], false);
    });
    const limits = pictureLimitsFor(AccountKind.CodexSignin);
    const spentAll = limits.inlineMaxBytes;

    const out = outgoingMessage(getTaskMessageRow(state.db, shot.id), spentAll, limits, true);

    expect(out.images.map((image) => image.path)).toEqual(shot.files.map((f) => f.storedPath));
    expect(out.text).not.toContain('kept at');
    // A Claude session is sent neither: one it holds, and one over what the budget has left.
    expect(outgoingMessage(getTaskMessageRow(state.db, shot.id), spentAll, limits).images).toEqual(
      [],
    );
  });
});
