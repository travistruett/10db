import {
  EventType,
  mintId,
  NotFoundError,
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  deleteUnsentBuilderMessage,
  dropAllowThisOffers,
  getTaskFile,
  getTaskMessageRow,
  insertBuilderMessage,
  insertSystemNotice,
  insertTask,
  listTaskThread,
  listUndeliveredTaskMessages,
  markTaskFilesInline,
  markTaskMessagesDelivered,
  markTaskMessagePushedUnder,
  markTaskMessagesHandedBack,
  markTaskMessagesPushed,
  markTaskMessagesTakenUnder,
  offeredText,
  offerAllowThis,
  offerToAgent,
  takeOffer,
  seedProject,
  type Store,
} from './index';

// Workbench spec §11: a task's thread is rows, so it survives a restart, and a pasted picture's row
// names the message it came with.

let store: Store;
let close: () => void;
let taskId: TaskId;
let otherTaskId: TaskId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  const project = seedProject(store, { name: 'alpha' });
  const task = (title: string) =>
    store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['ui'] }),
    ).value.id;
  taskId = task('Settings page');
  otherTaskId = task('Board page');
});
afterEach(() => {
  close();
});

const U1 = 'c0ffee00-0000-4000-8000-000000000001';
const U2 = 'c0ffee00-0000-4000-8000-000000000002';
const U3 = 'c0ffee00-0000-4000-8000-000000000003';

const picture = (name: string, sha: string) => ({
  name,
  mediaType: 'image/png' as const,
  size: 120,
  sha256: sha.repeat(64),
  storedPath: `/data/tasks/${taskId}/files/${sha.repeat(64)}.png`,
});

describe('a task thread', () => {
  it('keeps a builder message with its pictures, oldest first, each picture under its own message', () => {
    const first = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, {
        body: 'Make the header smaller',
        files: [picture('before.png', 'a'), picture('after.png', 'b')],
      }),
    );
    store.write((ctx) => insertBuilderMessage(ctx, otherTaskId, { body: 'Elsewhere', files: [] }));
    const second = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: 'And the footer', files: [] }),
    ).value;

    const thread = listTaskThread(store.db, taskId);
    expect(thread.map((m) => m.body)).toEqual(['Make the header smaller', 'And the footer']);
    expect(thread[0]).toMatchObject({
      id: first.value.id,
      taskId,
      author: TaskMessageAuthor.Builder,
      kind: TaskMessageKind.Message,
      pushedAt: null,
      deliveredAt: null,
    });
    expect(thread[0]?.files.map((f) => [f.name, f.messageId, f.inlineSent])).toEqual([
      ['before.png', first.value.id, false],
      ['after.png', first.value.id, false],
    ]);
    expect(thread[1]).toMatchObject({ id: second.id, files: [] });
    expect(thread[0]?.files[0]).not.toHaveProperty('storedPath');
    expect(
      first.events.map((e) => [e.type, e.entityType, e.entityId, e.data['messageId']]),
    ).toEqual([[EventType.TaskMessageAdded, 'task', taskId, first.value.id]]);
  });

  it('gets one picture by its id, with where it is kept', () => {
    const message = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: '', files: [picture('shot.png', 'c')] }),
    ).value;
    const id = message.files[0]?.id;
    if (id === undefined) throw new Error('no file');
    expect(getTaskFile(store.db, id)).toMatchObject({
      taskId,
      messageId: message.id,
      sha256: 'c'.repeat(64),
      storedPath: `/data/tasks/${taskId}/files/${'c'.repeat(64)}.png`,
    });
    expect(() => getTaskFile(store.db, mintId('TaskFile'))).toThrow(NotFoundError);
  });

  it('writes nothing for an unknown task, and nothing when the write it is part of fails', () => {
    expect(() =>
      store.write((ctx) =>
        insertBuilderMessage(ctx, mintId('Task'), { body: 'x', files: [picture('a.png', 'd')] }),
      ),
    ).toThrow(NotFoundError);
    expect(() =>
      store.write((ctx) => {
        insertBuilderMessage(ctx, taskId, { body: 'half', files: [picture('a.png', 'e')] });
        throw new Error('the picture never reached the disk');
      }),
    ).toThrow('the picture never reached the disk');
    expect(listTaskThread(store.db, taskId)).toEqual([]);
    expect(store.db.$client.prepare('select count(*) as n from task_files').get()).toEqual({
      n: 0,
    });
  });

  it('marks a message pushed, then delivered once, and lists those pushed and not delivered', () => {
    const add = (id: TaskId, body: string, files = [] as ReturnType<typeof picture>[]) =>
      store.write((ctx) => insertBuilderMessage(ctx, id, { body, files })).value;
    const first = add(taskId, 'First', [picture('a.png', 'a')]);
    const second = add(taskId, 'Second');
    const unpushed = add(taskId, 'Not handed over yet');
    const elsewhere = add(otherTaskId, 'Another task');
    store.write((ctx) => {
      markTaskMessagesPushed(ctx, [first.id, second.id, elsewhere.id]);
    });
    expect(listUndeliveredTaskMessages(store.db, taskId).map((m) => m.body)).toEqual([
      'First',
      'Second',
    ]);
    expect(
      listUndeliveredTaskMessages(store.db, taskId)[0]?.files.map((f) => f.storedPath),
    ).toEqual([picture('a.png', 'a').storedPath]);

    // Another task's message is not this task's to mark, and a mark is made once.
    const marked = store.write((ctx) =>
      markTaskMessagesDelivered(ctx, taskId, [second.id, elsewhere.id]),
    ).value;
    expect(marked).toEqual([second.id]);
    const deliveredAt = getTaskMessageRow(store.db, second.id).deliveredAt;
    expect(deliveredAt).not.toBeNull();
    expect(store.write((ctx) => markTaskMessagesDelivered(ctx, taskId, [second.id])).value).toEqual(
      [],
    );
    expect(getTaskMessageRow(store.db, second.id).deliveredAt).toBe(deliveredAt);
    expect(getTaskMessageRow(store.db, elsewhere.id).deliveredAt).toBeNull();
    expect(listUndeliveredTaskMessages(store.db, taskId).map((m) => m.id)).toEqual([first.id]);
    expect(getTaskMessageRow(store.db, unpushed.id).pushedAt).toBeNull();
    expect(() => getTaskMessageRow(store.db, mintId('TaskMessage'))).toThrow(NotFoundError);
  });

  it('keeps every client uuid a message was pushed under, in order, and stamps it pushed', () => {
    const message = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: 'Make it blue', files: [] }),
    ).value;
    expect(getTaskMessageRow(store.db, message.id).pushUuids).toEqual([]);
    store.write((ctx) => {
      markTaskMessagePushedUnder(ctx, message.id, U1);
      markTaskMessagePushedUnder(ctx, message.id, U2);
    });
    const row = getTaskMessageRow(store.db, message.id);
    expect(row.pushUuids).toEqual([U1, U2]);
    expect(row.pushedAt).not.toBeNull();
    expect(row.deliveredAt).toBeNull();
  });

  // Workbench spec §12: after a restart, a message pushed and not seen taken is taken when the
  // conversation it went to holds a client uuid it was pushed under; else it is sent again.
  it.each<{
    readonly name: string;
    readonly pushes: readonly string[];
    /** How the message was marked pushed: under client uuids, or by id alone. */
    readonly byIdAlone?: boolean;
    readonly delivered?: boolean;
    readonly otherTask?: boolean;
    readonly held: readonly string[];
    readonly taken: boolean;
  }>([
    {
      name: 'pushed once, under a uuid the conversation holds',
      pushes: [U1],
      held: [U1],
      taken: true,
    },
    {
      name: 'pushed twice, the conversation holding the later uuid',
      pushes: [U1, U2],
      held: [U2],
      taken: true,
    },
    {
      name: 'pushed twice, the conversation holding the first uuid',
      pushes: [U1, U2],
      held: [U1],
      taken: true,
    },
    {
      name: 'pushed, the conversation holding only other uuids',
      pushes: [U1],
      held: [U3],
      taken: false,
    },
    { name: 'pushed, the conversation holding nothing', pushes: [U1], held: [], taken: false },
    { name: 'never pushed', pushes: [], held: [U1], taken: false },
    {
      name: 'pushed by id alone, under no uuid',
      pushes: [],
      byIdAlone: true,
      held: [U1],
      taken: false,
    },
    {
      name: 'already delivered',
      pushes: [U1],
      delivered: true,
      held: [U1],
      taken: false,
    },
    {
      name: "another task's, under a uuid the conversation holds",
      pushes: [U1],
      otherTask: true,
      held: [U1],
      taken: false,
    },
  ])(
    'a message $name is taken: $taken',
    ({ pushes, byIdAlone, delivered, otherTask, held, taken }) => {
      const owner = otherTask === true ? otherTaskId : taskId;
      const message = store.write((ctx) =>
        insertBuilderMessage(ctx, owner, { body: 'Make it blue', files: [] }),
      ).value;
      store.write((ctx) => {
        for (const uuid of pushes) markTaskMessagePushedUnder(ctx, message.id, uuid);
        if (byIdAlone === true) markTaskMessagesPushed(ctx, [message.id]);
        if (delivered === true) markTaskMessagesDelivered(ctx, owner, [message.id]);
      });
      const deliveredBefore = getTaskMessageRow(store.db, message.id).deliveredAt;

      const marked = store.write((ctx) => markTaskMessagesTakenUnder(ctx, taskId, held)).value;

      expect(marked).toEqual(taken ? [message.id] : []);
      const after = getTaskMessageRow(store.db, message.id).deliveredAt;
      if (taken) expect(after).not.toBeNull();
      else expect(after).toBe(deliveredBefore);
    },
  );

  it("marks the pictures a session holds as blocks, and a fresh session's start clears the rest", () => {
    const message = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, {
        body: '',
        files: [picture('a.png', 'a'), picture('b.png', 'b')],
      }),
    ).value;
    const [a, b] = message.files.map((f) => f.id);
    if (a === undefined || b === undefined) throw new Error('no files');
    const inline = () => listTaskThread(store.db, taskId)[0]?.files.map((f) => f.inlineSent);
    store.write((ctx) => {
      markTaskFilesInline(ctx, taskId, [a], false);
    });
    expect(inline()).toEqual([true, false]);
    store.write((ctx) => {
      markTaskFilesInline(ctx, taskId, [b], true);
    });
    expect(inline()).toEqual([false, true]);
  });

  it('takes back a message no session was handed, with its pictures, and never one a session was', () => {
    // An earlier message holds the same picture, so its file stays.
    store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: 'Earlier', files: [picture('a.png', 'a')] }),
    );
    const refused = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, {
        body: 'Refused',
        files: [picture('a.png', 'a'), picture('b.png', 'b')],
      }),
    ).value;
    const handed = store.write((ctx) =>
      insertBuilderMessage(ctx, taskId, { body: 'Handed', files: [] }),
    ).value;
    store.write((ctx) => {
      markTaskMessagesPushed(ctx, [handed.id]);
    });

    const { value: removed, events } = store.write((ctx) =>
      deleteUnsentBuilderMessage(ctx, taskId, refused.id),
    );
    expect(removed).toEqual([picture('b.png', 'b').storedPath]);
    expect(events.map((e) => e.type)).toEqual([EventType.TaskChanged]);
    expect(
      store.write((ctx) => deleteUnsentBuilderMessage(ctx, taskId, handed.id)).value,
    ).toBeNull();
    expect(listTaskThread(store.db, taskId).map((m) => m.body)).toEqual(['Earlier', 'Handed']);
    expect(() =>
      store.write((ctx) => deleteUnsentBuilderMessage(ctx, otherTaskId, handed.id)),
    ).toThrow(NotFoundError);
  });

  it('hands back a message a session dropped: no longer pushed, its uuids kept, and never taken back', () => {
    const add = (id: TaskId, body: string) =>
      store.write((ctx) => insertBuilderMessage(ctx, id, { body, files: [] })).value;
    const dropped = add(taskId, 'Dropped');
    const delivered = add(taskId, 'Delivered');
    const elsewhere = add(otherTaskId, 'Another task');
    store.write((ctx) => {
      markTaskMessagePushedUnder(ctx, dropped.id, U1);
      markTaskMessagePushedUnder(ctx, delivered.id, U2);
      markTaskMessagesDelivered(ctx, taskId, [delivered.id]);
      markTaskMessagePushedUnder(ctx, elsewhere.id, U3);
    });

    const handed = store.write((ctx) =>
      markTaskMessagesHandedBack(ctx, taskId, [dropped.id, delivered.id, elsewhere.id]),
    ).value;

    expect(handed).toEqual([dropped.id]);
    expect(getTaskMessageRow(store.db, dropped.id)).toMatchObject({
      pushedAt: null,
      deliveredAt: null,
      pushUuids: [U1],
    });
    expect(getTaskMessageRow(store.db, delivered.id).pushedAt).not.toBeNull();
    expect(getTaskMessageRow(store.db, elsewhere.id).pushedAt).not.toBeNull();
    // It went to a session once, so it is never taken back as unsent; nor is it in doubt.
    expect(
      store.write((ctx) => deleteUnsentBuilderMessage(ctx, taskId, dropped.id)).value,
    ).toBeNull();
    expect(listUndeliveredTaskMessages(store.db, taskId)).toEqual([]);
  });

  it('writes a notice of its own to the thread, from the system', () => {
    const notice = store.write((ctx) => insertSystemNotice(ctx, taskId, 'Started a fresh session'));
    expect(listTaskThread(store.db, taskId)).toEqual([
      expect.objectContaining({
        id: notice.value.id,
        author: TaskMessageAuthor.System,
        kind: TaskMessageKind.Notice,
        body: 'Started a fresh session',
        files: [],
      }),
    ]);
    expect(notice.events.map((e) => e.type)).toEqual([EventType.TaskMessageAdded]);
  });

  it('reads a notice offered with Send to Agent as sendable, with the text it sends', () => {
    const plain = store.write((ctx) => insertSystemNotice(ctx, taskId, 'Signed off')).value;
    const finding = store.write((ctx) => {
      const made = insertSystemNotice(ctx, taskId, 'Review: the label is cut off');
      offerToAgent(ctx, made.id, 'Fix the cut-off label in src/settings/page.tsx');
      return made;
    }).value;

    expect(listTaskThread(store.db, taskId).map((m) => [m.id, m.sendable])).toEqual([
      [plain.id, false],
      [finding.id, true],
    ]);
    expect(offeredText(store.db, finding.id)).toBe(
      'Fix the cut-off label in src/settings/page.tsx',
    );
    expect(offeredText(store.db, plain.id)).toBeNull();
  });

  it('an Allow this offer shows on the notice, and taking it clears both', () => {
    const denied = store.write((ctx) => {
      const made = insertSystemNotice(ctx, taskId, 'Auto mode stopped this Bash call');
      offerAllowThis(ctx, made.id, 'I approve this exact Bash call.');
      return made;
    }).value;

    expect(listTaskThread(store.db, taskId).map((m) => [m.sendable, m.allowThis])).toEqual([
      [true, true],
    ]);
    expect(store.write((ctx) => takeOffer(ctx, denied.id)).value).toBe(
      'I approve this exact Bash call.',
    );
    expect(listTaskThread(store.db, taskId).map((m) => [m.sendable, m.allowThis])).toEqual([
      [false, false],
    ]);
    // Taken once: a second take finds nothing.
    expect(store.write((ctx) => takeOffer(ctx, denied.id)).value).toBeNull();
  });

  it("dropping a pass's offers clears them and leaves a Send to Agent offer", () => {
    const { allow, finding, elsewhere } = store.write((ctx) => {
      const allowed = insertSystemNotice(ctx, taskId, 'Auto mode stopped this Bash call');
      offerAllowThis(ctx, allowed.id, 'I approve this exact Bash call.');
      const found = insertSystemNotice(ctx, taskId, 'Review: the label is cut off');
      offerToAgent(ctx, found.id, 'Fix the label');
      const other = insertSystemNotice(ctx, otherTaskId, 'Auto mode stopped this Bash call');
      offerAllowThis(ctx, other.id, 'I approve this exact Bash call.');
      return { allow: allowed, finding: found, elsewhere: other };
    }).value;

    store.write((ctx) => {
      dropAllowThisOffers(ctx, [taskId]);
    });

    expect(offeredText(store.db, allow.id)).toBeNull();
    expect(listTaskThread(store.db, taskId).map((m) => [m.id, m.sendable, m.allowThis])).toEqual([
      [allow.id, false, false],
      [finding.id, true, false],
    ]);
    // Another task's offer is its own pass's.
    expect(listTaskThread(store.db, otherTaskId).map((m) => [m.id, m.allowThis])).toEqual([
      [elsewhere.id, true],
    ]);
  });
});
