import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  idUuid,
  TaskMessageAuthor,
  type TaskId,
  type TaskMessageId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getTaskMessageRow,
  getWorkstream,
  getWorkstreamRow,
  insertBuilderMessage,
  listTaskThread,
  markTaskMessagePushedUnder,
  markTaskMessagesPushed,
  patchAccount,
  patchProject,
  patchWorkstream,
  seedAccount,
  type StoredPicture,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { handoffArgs, waitFor } from '../../test/fixtures';
import { pngOfSize } from '../../test/png';
import { ConversationUnreadError, type FakeScriptBook } from '../sessions';
import { FRESH_SESSION_NOTICE, taskFilesDir } from '../thread';
import { THREAD_UNREAD_NOTICE, TURN_CUT_SHORT } from './read-back';

// Workbench spec §6.3, §12: a builder message from the task's thread, as the `feedback` action. A
// session that can be resumed is handed it; one that cannot starts fresh from the thread's digest and
// then the message, and the thread says so. A message is delivered only when a turn lists its uuid; a
// session that ends without taking it queues the workstream again with it.

let engine: TestEngine;
afterEach(async () => {
  await engine.close();
});

/** A picture kept where the thread keeps the task's pictures. */
function picture(taskId: TaskId): StoredPicture {
  const dir = taskFilesDir(engine.dataDir, taskId);
  mkdirSync(dir, { recursive: true });
  const bytes = pngOfSize(400, 300);
  const storedPath = join(dir, 'header.png');
  writeFileSync(storedPath, bytes);
  return {
    name: 'header.png',
    mediaType: 'image/png',
    size: bytes.length,
    sha256: 'a'.repeat(64),
    storedPath,
  };
}

const say = (taskId: TaskId, body: string, files: StoredPicture[] = []): TaskMessageId =>
  engine.state.write((ctx) => insertBuilderMessage(ctx, taskId, { body, files })).id;

const feedbackOn = (
  id: WorkstreamId,
  messageId: TaskMessageId,
  providerSessionId: string | null,
): void => {
  engine.state.write((ctx) => {
    patchWorkstream(ctx, id, null, {
      nextAction: { kind: 'feedback', messageId, providerSessionId },
    });
  });
};

type FakeStep = FakeScriptBook[string][number][number];

const crash = { do: 'crash' as const, message: 'the session stopped' };
const working = { do: 'activity' as const, summary: 'Working on it' };

const pushed = (...ids: TaskMessageId[]): void => {
  engine.state.write((ctx) => {
    markTaskMessagesPushed(ctx, ids);
  });
};

/** The builder messages the sessions were handed after their prompts, by the id each names. */
const sentMessages = (): string[] =>
  engine.adapter.sent.map((m) => /\(message (tmg_[^)]+)\)/.exec(m.text)?.[1] ?? m.text);

/** The session id the fake reports for the workstream's first session. */
const firstProviderSession = (): string => `fake-${engine.adapter.prompts[0]?.sessionId ?? ''}`;

describe("a builder's message from the task's thread", () => {
  it("starts fresh from the thread's digest and then the message when there is no session to resume, and says so on the thread", async () => {
    const book: FakeScriptBook = { Alpha: [] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const shot = picture(task.id);
    say(task.id, 'Make the header smaller', [shot]);
    const message = say(task.id, 'Now the footer');
    book['Alpha'] = [
      [{ do: 'tool', toolName: 'Read', input: { file_path: shot.storedPath } }, crash],
    ];
    feedbackOn(workstream.id, message, null);

    engine.launch(workstream.id);
    await engine.runner.idle();

    const [started] = engine.adapter.prompts;
    expect(started?.resume).toBeNull();
    expect(started?.promptUuid).toBe(idUuid(message));
    expect(getTaskMessageRow(engine.state.db, message).pushUuids).toEqual([idUuid(message)]);
    const prompt = started?.prompt ?? '';
    const digestAt = prompt.indexOf("This task's thread continues in a fresh session");
    expect(digestAt).toBeGreaterThan(-1);
    expect(prompt.indexOf('Make the header smaller')).toBeGreaterThan(digestAt);
    expect(prompt.indexOf(`(message ${message}):\nNow the footer`)).toBeGreaterThan(
      prompt.indexOf('Make the header smaller'),
    );
    expect(prompt).toContain(`kept at ${shot.storedPath}`);
    // The pasted picture is in the data directory, and the session's own task's is its to read.
    expect(engine.adapter.observations).toContainEqual(
      expect.objectContaining({ kind: 'tool_allowed', detail: { toolName: 'Read' } }),
    );
    expect(
      listTaskThread(engine.store.db, task.id)
        .filter((m) => m.author === TaskMessageAuthor.System)
        .map((m) => m.body),
    ).toEqual([FRESH_SESSION_NOTICE]);
    expect(getTaskMessageRow(engine.store.db, message).pushedAt).not.toBeNull();
  });

  it('delivers a message only when a turn lists its uuid, queuing it again after a session that never took it', async () => {
    const book: FakeScriptBook = { Alpha: [] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    book['Alpha'] = [
      [{ do: 'activity', summary: 'Looking at the colours' }, crash],
      [{ do: 'consume' }, crash],
      [crash],
    ];
    feedbackOn(workstream.id, message, null);

    engine.launch(workstream.id);
    await engine.runner.idle();
    const first = engine.adapter.prompts[0];
    const row = getTaskMessageRow(engine.store.db, message);
    expect(row.pushedAt).not.toBeNull();
    expect(row.deliveredAt).toBeNull();
    // Resumed once, with the message, since no turn took it.
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: {
        kind: 'feedback',
        messageId: message,
        providerSessionId: `fake-${first?.sessionId ?? ''}`,
      },
    });

    // A message an earlier session was handed and no turn took goes to the next session as well.
    const later = say(task.id, 'And bigger');
    engine.state.write((ctx) => {
      markTaskMessagesPushed(ctx, [later]);
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    const second = engine.adapter.prompts[1];
    expect(second?.resume).toBe(`fake-${first?.sessionId ?? ''}`);
    // The resumed conversation already holds the message's own uuid, under which Claude Code runs
    // no turn: it goes under one of its own, which the turn's stamp still maps to the message.
    expect(second?.promptUuid).not.toBe(idUuid(message));
    expect(second?.promptUuid).not.toBeNull();
    expect(second?.prompt).toContain(`(message ${message})`);
    expect(second?.prompt).not.toContain("This task's thread continues in a fresh session");
    expect(sentMessages()).toEqual([later]);
    expect(getTaskMessageRow(engine.store.db, message).deliveredAt).not.toBeNull();
    expect(getTaskMessageRow(engine.store.db, later).deliveredAt).not.toBeNull();
    // Both taken, the crash resumes the session and hands it nothing again.
    expect(getWorkstream(engine.store.db, workstream.id).nextAction).toMatchObject({
      kind: 'resume',
    });

    // A session that was not started for a message ends without taking one it was handed: the
    // message starts the next session, fresh since this resume failed.
    const third = say(task.id, 'And rounder');
    engine.state.write((ctx) => {
      markTaskMessagesPushed(ctx, [third]);
    });
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(sentMessages()).toEqual([later, third]);
    expect(getTaskMessageRow(engine.store.db, third).deliveredAt).toBeNull();
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'feedback', messageId: third, providerSessionId: null },
    });
  });

  // Workbench spec §6.3: a session that ends with a message it never took, however it ends, queues
  // the workstream again with `feedback`, and a feedback keeps the message it was started for even
  // when an older one is untaken too.
  it.each<[string, FakeStep[], string]>([
    [
      'a usage pause',
      [working, { do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }],
      'PAUSED_LIMIT',
    ],
    ['an account hold', [working, { do: 'auth_error', error: 'account_on_hold' }], 'PAUSED_LIMIT'],
  ])('keeps the message a feedback was started for through %s', async (_name, steps, state) => {
    const book: FakeScriptBook = { Alpha: [steps] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const older = say(task.id, 'Make it blue');
    const message = say(task.id, 'Now the footer');
    pushed(older);
    feedbackOn(workstream.id, message, null);

    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(sentMessages()).toEqual([older]);
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state,
      nextAction: {
        kind: 'feedback',
        messageId: message,
        providerSessionId: firstProviderSession(),
      },
    });
  });

  it('runs the step again with a message its session never took, rather than verifying it', async () => {
    const book: FakeScriptBook = { Alpha: [[working, { do: 'turn_complete' }]] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    pushed(message);

    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(sentMessages()).toEqual([message]);
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: {
        kind: 'feedback',
        messageId: message,
        providerSessionId: firstProviderSession(),
      },
    });
  });

  it('starts the session after a handoff with the message the handed-off session never took', async () => {
    const book: FakeScriptBook = {
      Alpha: [
        [
          working,
          { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-fb-handoff', 'Do the rest') },
          { do: 'turn_complete' },
        ],
        [{ do: 'consume' }, crash],
      ],
    };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    pushed(message);

    engine.launch(workstream.id);
    await engine.runner.idle();

    const next = engine.adapter.prompts[1];
    expect(next?.resume).toBeNull();
    expect(next?.prompt).toContain(`(message ${message})`);
    expect(getTaskMessageRow(engine.store.db, message).deliveredAt).not.toBeNull();
  });

  it('starts fresh from the digest with the message once the project has moved to another account', async () => {
    const book: FakeScriptBook = {
      Alpha: [
        [working, crash],
        [{ do: 'consume' }, crash],
      ],
    };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    feedbackOn(workstream.id, message, null);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(getWorkstream(engine.store.db, workstream.id).nextAction).toMatchObject({
      kind: 'feedback',
      providerSessionId: firstProviderSession(),
    });

    const other = seedAccount(engine.store, { kind: 'claude_subscription', label: 'Second plan' });
    engine.state.write((ctx) => {
      patchAccount(ctx, other.id, { expectedIdentity: 'second@example.com' });
      patchProject(ctx, engine.project.id, { accountId: other.id });
    });
    engine.launch(workstream.id);
    await engine.runner.idle();

    const moved = engine.adapter.prompts[1];
    expect(moved?.accountId).toBe(other.id);
    expect(moved?.resume).toBeNull();
    expect(moved?.prompt).toContain(`(message ${message})`);
    expect(getTaskMessageRow(engine.store.db, message).deliveredAt).not.toBeNull();
    expect(moved?.prompt).toContain("This task's thread continues in a fresh session");
  });

  it('hands a message no turn took only to a session of the step it was written for', async () => {
    const book: FakeScriptBook = { Alpha: [[working, crash]] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha', ['api'], [], { flow: 'standard' });
    const review = getWorkstreamRow(engine.store.db, workstream.id).steps.findIndex(
      (step) => step.role !== 'implement',
    );
    engine.state.write((ctx) => {
      patchWorkstream(ctx, workstream.id, null, { stepIndex: review });
    });
    const message = say(task.id, 'Make it blue');
    pushed(message);

    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(engine.adapter.prompts).toHaveLength(1);
    expect(engine.adapter.sent).toEqual([]);
    expect(getWorkstream(engine.store.db, workstream.id).nextAction).toMatchObject({
      kind: 'resume',
    });
  });

  it('hands a builder message to a Codex lane under its uuid, delivered once a turn took it', async () => {
    const book: FakeScriptBook = { Alpha: [[{ do: 'consume' }, { do: 'turn_complete' }]] };
    engine = await createTestEngine(
      book,
      {},
      {},
      {
        account: { kind: 'codex_signin', label: 'ChatGPT plan' },
      },
    );
    engine.state.write((ctx) => {
      patchAccount(ctx, engine.project.accountId, {
        expectedIdentity: 'chatgpt@example.com · ws-1',
      });
    });
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    feedbackOn(workstream.id, message, null);

    engine.launch(workstream.id);
    await engine.runner.idle();

    const [started] = engine.adapter.prompts;
    expect(started?.promptUuid).toBe(idUuid(message));
    expect(started?.prompt).toContain(`(message ${message}):\nMake it blue`);
    expect(getTaskMessageRow(engine.store.db, message).deliveredAt).not.toBeNull();
    expect(getWorkstream(engine.store.db, workstream.id).state).not.toBe('FAILED');
  });

  describe('a Codex thread resumed after a restart with a message pushed to it and never seen taken', () => {
    const codexEngine = async (book: FakeScriptBook): Promise<TestEngine> => {
      const made = await createTestEngine(
        book,
        {},
        {},
        { account: { kind: 'codex_signin', label: 'ChatGPT plan' } },
      );
      made.state.write((ctx) => {
        patchAccount(ctx, made.project.accountId, {
          expectedIdentity: 'chatgpt@example.com · ws-1',
        });
      });
      return made;
    };
    const pushedUnderItsUuid = (id: TaskMessageId): void => {
      engine.state.write((ctx) => {
        markTaskMessagePushedUnder(ctx, id, idUuid(id));
      });
    };

    it('is read back, and a message it took is delivered and never sent again: the thread resumes', async () => {
      engine = await codexEngine({ Alpha: [[working, crash]] });
      const { task, workstream } = engine.addTask('Alpha');
      const message = say(task.id, 'Make it blue');
      pushedUnderItsUuid(message);
      feedbackOn(workstream.id, message, 'thr-before-restart');
      engine.adapter.readBack = () => Promise.resolve([idUuid(message)]);

      engine.launch(workstream.id);
      await engine.runner.idle();

      expect(engine.adapter.reads.map((r) => r.providerSessionId)).toEqual(['thr-before-restart']);
      const [resumed] = engine.adapter.prompts;
      expect(resumed?.resume).toBe('thr-before-restart');
      expect(resumed?.promptUuid).toBeNull();
      expect(resumed?.prompt).not.toContain('Make it blue');
      expect(resumed?.prompt).toContain(TURN_CUT_SHORT);
      expect(engine.adapter.sent).toEqual([]);
      expect(getTaskMessageRow(engine.store.db, message).deliveredAt).not.toBeNull();
    });

    it('starts a fresh session that is sent the message again, and says so, when the thread cannot be read back', async () => {
      engine = await codexEngine({ Alpha: [[working, crash]] });
      const { task, workstream } = engine.addTask('Alpha');
      const message = say(task.id, 'Make it blue');
      pushedUnderItsUuid(message);
      feedbackOn(workstream.id, message, 'thr-before-restart');
      engine.adapter.readBack = () =>
        Promise.reject(
          new ConversationUnreadError(
            'Codex could not read back thread thr-before-restart: an error from Codex',
          ),
        );

      engine.launch(workstream.id);
      await engine.runner.idle();

      const [fresh] = engine.adapter.prompts;
      expect(fresh?.resume).toBeNull();
      expect(fresh?.prompt).toContain(`(message ${message}):\nMake it blue`);
      // Under a uuid of its own: the unread thread may hold the row's.
      expect(fresh?.promptUuid).not.toBe(idUuid(message));
      expect(getWorkstream(engine.store.db, workstream.id).state).not.toBe('FAILED');
      expect(
        listTaskThread(engine.store.db, task.id)
          .filter((m) => m.author === 'system')
          .map((m) => m.body),
      ).toContain(THREAD_UNREAD_NOTICE);
    });

    it('keeps what the read decided when the launch goes no further, so the message is not sent again', async () => {
      engine = await codexEngine({ Alpha: [[working, crash]] });
      // An account with no confirmed identity is not ready: the launch stops after the read.
      engine.state.write((ctx) => {
        patchAccount(ctx, engine.project.accountId, { expectedIdentity: null });
      });
      const { task, workstream } = engine.addTask('Alpha');
      const message = say(task.id, 'Make it blue');
      pushedUnderItsUuid(message);
      feedbackOn(workstream.id, message, 'thr-before-restart');
      engine.adapter.readBack = () => Promise.resolve([idUuid(message)]);

      engine.launch(workstream.id);
      await engine.runner.idle();
      expect(engine.adapter.prompts).toEqual([]);
      expect(getWorkstream(engine.store.db, workstream.id).nextAction).toEqual({
        kind: 'resume',
        providerSessionId: 'thr-before-restart',
        reason: TURN_CUT_SHORT,
      });

      engine.state.write((ctx) => {
        patchAccount(ctx, engine.project.accountId, {
          expectedIdentity: 'chatgpt@example.com · ws-1',
        });
      });
      engine.launch(workstream.id);
      await engine.runner.idle();

      const [resumed] = engine.adapter.prompts;
      expect(resumed?.resume).toBe('thr-before-restart');
      expect(resumed?.prompt).not.toContain('Make it blue');
      expect(engine.adapter.sent).toEqual([]);
      expect(engine.adapter.reads).toHaveLength(1);
    });

    it('ends the read at once when the lane is stopped, sending nothing', async () => {
      engine = await codexEngine({ Alpha: [[working, crash]] });
      const { task, workstream } = engine.addTask('Alpha');
      const message = say(task.id, 'Make it blue');
      pushedUnderItsUuid(message);
      feedbackOn(workstream.id, message, 'thr-before-restart');
      engine.adapter.readBack = (spec) =>
        new Promise((_, reject) => {
          spec.signal?.addEventListener('abort', () => {
            reject(new ConversationUnreadError('the read was stopped'));
          });
        });

      engine.launch(workstream.id);
      await waitFor(() => engine.adapter.reads.length === 1);
      await engine.runner.stop(workstream.id, 'paused');
      await engine.runner.idle();

      expect(engine.adapter.prompts).toEqual([]);
      expect(getTaskMessageRow(engine.store.db, message).deliveredAt).toBeNull();
      expect(listTaskThread(engine.store.db, task.id).filter((m) => m.author === 'system')).toEqual(
        [],
      );
    });
  });

  it('notes a fresh session on the thread only once it has started', async () => {
    const book: FakeScriptBook = { Alpha: [[{ do: 'consume' }, crash]] };
    engine = await createTestEngine(book);
    const { task, workstream } = engine.addTask('Alpha');
    const message = say(task.id, 'Make it blue');
    feedbackOn(workstream.id, message, null);
    engine.adapter.seen = () => ({ email: 'someone-else@example.com' });

    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'PAUSED_LIMIT',
      nextAction: { kind: 'feedback', messageId: message, providerSessionId: null },
    });
    expect(
      listTaskThread(engine.store.db, task.id).filter((m) => m.author === TaskMessageAuthor.System),
    ).toEqual([]);
  });
});
