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
  insertBuilderMessage,
  listTaskThread,
  markTaskMessagesPushed,
  patchWorkstream,
  type StoredPicture,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestEngine, type TestEngine } from '../../test/engine';
import { pngOfSize } from '../../test/png';
import type { FakeScriptBook } from '../sessions';
import { FRESH_SESSION_NOTICE, taskFilesDir } from '../thread';

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

const crash = { do: 'crash' as const, message: 'the session stopped' };

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
    expect(second?.promptUuid).toBe(idUuid(message));
    expect(second?.prompt).not.toContain("This task's thread continues in a fresh session");
    expect(engine.adapter.sent.map((m) => m.uuid)).toEqual([idUuid(later)]);
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
    expect(engine.adapter.sent.map((m) => m.uuid)).toEqual([idUuid(later), idUuid(third)]);
    expect(getTaskMessageRow(engine.store.db, third).deliveredAt).toBeNull();
    expect(getWorkstream(engine.store.db, workstream.id)).toMatchObject({
      state: 'QUEUED',
      nextAction: { kind: 'feedback', messageId: third, providerSessionId: null },
    });
  });
});
