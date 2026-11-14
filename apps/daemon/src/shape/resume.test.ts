import {
  mintId,
  NotFoundError,
  PlanDraft,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeProposalState,
  ShapeState,
  ShapeToolInputs,
  TaskStatus,
  type ShapeMessageId,
  type TaskId,
} from '@10db/contracts';
import {
  getShape,
  insertShapeMessage,
  insertTask,
  insertWorkstream,
  listShapeMessages,
  listShapeProposals,
  listTasks,
  patchShape,
  schema,
  setTaskStatus,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { must } from './conversation-fixture';
import { convertProposals } from './convert';
import { buildDigest } from './digest';
import { reconcileDraft } from './rounds';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Shape spec §12: Open conversation reopens a conversation with an event injected as a note. The
// reopened session sees each converted row with its current state, read-only, and re-planning
// proposes additions, changes and removals for unstarted tasks only.

let f: ServiceFixture;
beforeEach(() => {
  f = createServiceFixture();
});
afterEach(async () => {
  await f.close();
});

const shapeId = () => f.c.shape.id;
const write = <T>(fn: (ctx: WriteContext) => T): T => f.c.store.write(fn).value;

const loose = (m: ShapeMessageId, key: string) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [m],
});

function propose(draft: Record<string, unknown>): void {
  const out = write((ctx) => reconcileDraft(ctx, shapeId(), PlanDraft.parse(draft)));
  if (!out.ok) throw new Error(out.errors.join('; '));
}

/** Converts the loose tasks `keys`, returning the tasks they became in order. */
function convertTasks(...keys: string[]): TaskId[] {
  const m = f.c.say();
  propose({ looseTasks: keys.map((k) => loose(m, k)) });
  const out = write((ctx) =>
    convertProposals(
      ctx,
      shapeId(),
      listShapeProposals(ctx.tx, shapeId())
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.id),
    ),
  );
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.results.flatMap((r) => r.taskIds);
}

/** Marks a task finished with this many lane minutes, as a finished workstream leaves it. */
function finishTask(taskId: TaskId, minutes: number): void {
  write((ctx) => {
    const ws = insertWorkstream(ctx, taskId, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .insert(schema.taskLaneTimes)
      .values({
        workstreamId: ws.id,
        taskId,
        laneMinutes: minutes,
        sessionsOnly: false,
        createdAt: ctx.now,
      })
      .run();
    setTaskStatus(ctx, taskId, TaskStatus.Done);
  });
}

const messages = () => listShapeMessages(f.c.store.db, shapeId());
const prompts = () => f.adapter.shapeSessions.map((s) => s.spec.prompt);

/** What a session's propose_plan call answers: the error text when refused, otherwise null. */
async function callPropose(draft: Record<string, unknown>): Promise<string | null> {
  write((ctx) => {
    patchShape(ctx, shapeId(), { proposeUnlocked: true });
  });
  const handler = must(
    f.service.toolsFor({ sessionId: mintId('Session'), shapeId: shapeId() }).propose_plan,
    'propose_plan',
  );
  try {
    await handler(ShapeToolInputs.propose_plan.parse({ draft: PlanDraft.parse(draft) }));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('resuming a conversation', () => {
  it('records the event as a note a proposal may cite, and starts no turn', async () => {
    convertTasks('a');
    const note = f.service.resume(shapeId(), 'Task a ran out of attempts.');
    expect(note).toMatchObject({
      author: ShapeMessageAuthor.Note,
      kind: ShapeMessageKind.Event,
      body: 'Task a ran out of attempts.',
    });
    expect(messages().some((m) => m.id === note.id)).toBe(true);
    await f.service.settled(shapeId());
    expect(prompts()).toEqual([]);
  });

  it('refuses a conversation that does not exist', () => {
    expect(() => f.service.resume('shape_missing' as never, 'x')).toThrow(NotFoundError);
  });

  it('tells the next turn the event under its id, and each converted row with its state', async () => {
    const [unstarted, started] = convertTasks('a', 'b').map((id) => must(id, 'task'));
    write((ctx) =>
      insertWorkstream(ctx, must(started, 'started'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    const note = f.service.resume(shapeId(), 'Task b is running late.');
    f.service.send(shapeId(), 'What should change?');
    await f.service.settled(shapeId());
    const prompt = must(prompts()[0], 'prompt');
    expect(prompt).toContain(`[m:${note.id}] Task b is running late.`);
    expect(prompt).toContain(`${unstarted ?? ''} "Task a" — not started`);
    expect(prompt).toMatch(new RegExp(`${started ?? ''} "Task b" — started \\(queued\\)`));
  });

  it('names a task that finished outside its size, with its size and its actual, and no other', async () => {
    const made = convertTasks('a', 'b');
    const off = must(made[0], 'first task');
    const near = must(made[1], 'second task');
    finishTask(off, 300);
    finishTask(near, 40);
    f.service.resume(shapeId(), 'Task a is done.');
    f.service.send(shapeId(), 'What should change?');
    await f.service.settled(shapeId());
    const prompt = must(prompts()[0], 'prompt');
    expect(prompt).toContain('Finished outside their size');
    expect(prompt).toContain(`task ${off} "Task a" — sized S (~0.5 h), took 5 h of lane time`);
    expect(prompt).not.toContain(`task ${near} "Task b" — sized`);
  });

  it('says nothing about sizes when every finished task was within one bucket', async () => {
    finishTask(must(convertTasks('a')[0], 'task'), 40);
    f.service.resume(shapeId(), 'Task a is done.');
    f.service.send(shapeId(), 'What should change?');
    await f.service.settled(shapeId());
    expect(must(prompts()[0], 'prompt')).not.toContain('Finished outside their size');
  });

  it('gives a fresh session the mis-sized task in its digest', () => {
    const off = must(convertTasks('a')[0], 'task');
    finishTask(off, 300);
    expect(buildDigest(f.c.store.db, shapeId())).toContain(
      `task ${off} "Task a" — sized S (~0.5 h), took 5 h of lane time`,
    );
  });

  it('gives a fresh session the same state in its digest, the event citable', () => {
    convertTasks('a');
    write((ctx) =>
      insertShapeMessage(ctx, shapeId(), {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Converted.',
      }),
    );
    const note = f.service.resume(shapeId(), 'Task a ran out of attempts.');
    const digest = buildDigest(f.c.store.db, shapeId());
    expect(digest).toContain(`[m:${note.id}] Task a ran out of attempts.`);
    expect(digest).toContain('"Task a" — not started');
  });
});

describe('telling a reopened conversation which tasks mis-sized', () => {
  const HEADING = 'Finished outside their size';
  const lineOf = (taskId: TaskId) =>
    `task ${taskId} "Task a" — sized S (~0.5 h), took 5 h of lane time`;
  const times = (text: string, part: string) => text.split(part).length - 1;
  const storeSdkSession = () => {
    write((ctx) => {
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
  };
  const send = async (text: string) => {
    f.service.send(shapeId(), text);
    await f.service.settled(shapeId());
  };

  it('tells a resumed session on the next message, once, with no resume call', async () => {
    const off = must(convertTasks('a')[0], 'task');
    finishTask(off, 300);
    storeSdkSession();

    await send('What should change?');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.resumeProviderSessionId).toBe('sdk-1');
    expect(session.spec.prompt).toContain(HEADING);
    expect(session.spec.prompt).toContain(lineOf(off));

    await send('And now?');
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0]).not.toContain(HEADING);
  });

  it('tells a live session about a task that finished between its turns', async () => {
    const off = must(convertTasks('a')[0], 'task');
    await send('First.');
    finishTask(off, 300);
    await send('Second.');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.sent[0]).toContain(lineOf(off));
  });

  it('says nothing to a session when no finished task is outside one bucket', async () => {
    finishTask(must(convertTasks('a')[0], 'task'), 40);
    storeSdkSession();
    await send('What should change?');
    expect(must(prompts()[0], 'prompt')).not.toContain(HEADING);
  });

  it('keeps the note through a failed start and a restart, then never repeats it', async () => {
    const off = must(convertTasks('a')[0], 'task');
    finishTask(off, 300);
    storeSdkSession();
    const realOpen = f.adapter.open.bind(f.adapter);
    f.adapter.open = (): never => {
      throw new Error('Claude is not available');
    };
    await send('First.');
    f.adapter.open = realOpen;

    await f.restart();
    await send('Second.');
    expect(must(prompts()[0], 'prompt')).toContain(lineOf(off));

    await f.restart();
    await send('Third.');
    expect(must(prompts()[1], 'prompt')).not.toContain(HEADING);
  });

  it('tells a session from the digest alone, and not again afterwards', async () => {
    const off = must(convertTasks('a')[0], 'task');
    finishTask(off, 300);
    write((ctx) =>
      insertShapeMessage(ctx, shapeId(), {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Converted.',
      }),
    );
    await send('What should change?');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.prompt).toContain('fresh session');
    expect(times(session.spec.prompt, lineOf(off))).toBe(1);

    await send('And now?');
    expect(session.sent[0]).not.toContain(HEADING);
  });

  it('says it once when an engine event reopens the conversation too', async () => {
    const off = must(convertTasks('a')[0], 'task');
    finishTask(off, 300);
    storeSdkSession();
    f.service.resume(shapeId(), 'Task a is done.');
    await send('What should change?');
    expect(times(must(prompts()[0], 'prompt'), lineOf(off))).toBe(1);
  });
});

describe('telling a reopened conversation what Convert made', () => {
  const HEADING = 'Converted so far, read-only';
  const times = (text: string, part: string) => text.split(part).length - 1;
  const send = async (text: string) => {
    f.service.send(shapeId(), text);
    await f.service.settled(shapeId());
  };

  it('gives a resumed session each converted row with its id and state on the next message', async () => {
    const [unstarted, started] = convertTasks('a', 'b').map((id) => must(id, 'task'));
    write((ctx) => {
      insertWorkstream(ctx, must(started, 'started'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    await send('What should change?');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.spec.resumeProviderSessionId).toBe('sdk-1');
    expect(session.spec.prompt).toContain(HEADING);
    expect(session.spec.prompt).toContain(`task ${unstarted ?? ''} "Task a" — not started`);
    expect(session.spec.prompt).toMatch(
      new RegExp(`task ${started ?? ''} "Task b" — started \\(queued\\)`),
    );
  });

  it('tells a live session as it stands at its next turn', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    await send('First.');
    write((ctx) =>
      insertWorkstream(ctx, must(first, 'task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    await send('Second.');
    const session = must(f.adapter.shapeSessions[0], 'a session');
    expect(session.sent[0]).toMatch(new RegExp(`task ${first ?? ''} "Task a" — started`));
  });

  it('carries no such lines when nothing was converted', async () => {
    write((ctx) => {
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    await send('Hello.');
    expect(must(prompts()[0], 'prompt')).not.toContain(HEADING);
  });

  it('gives the converted rows of a partial Convert, with proposals still pending', async () => {
    const m = f.c.say();
    propose({ looseTasks: [loose(m, 'a'), loose(m, 'b')] });
    const out = write((ctx) =>
      convertProposals(
        ctx,
        shapeId(),
        listShapeProposals(ctx.tx, shapeId())
          .filter((r) => r.key === 'a')
          .map((r) => r.id),
      ),
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    const converted = must(out.results.flatMap((r) => r.taskIds)[0], 'task');
    write((ctx) => {
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Proposed);

    await send('What should change?');
    expect(must(prompts()[0], 'prompt')).toContain(`task ${converted} "Task a" — not started`);
  });

  it('keeps telling a conversation a re-plan round moved back to Proposed', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    propose({ looseTasks: [loose(f.c.say(), 'b')] });
    write((ctx) => {
      insertWorkstream(ctx, must(first, 'task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Proposed);

    await send('What should change?');
    expect(must(prompts()[0], 'prompt')).toMatch(
      new RegExp(`task ${first ?? ''} "Task a" — started`),
    );
  });

  it('says it once, as it stands at the turn, when a resume event came first', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) => {
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    f.service.resume(shapeId(), 'Task a is done.');
    write((ctx) =>
      insertWorkstream(ctx, must(first, 'task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    await send('What should change?');
    const prompt = must(prompts()[0], 'prompt');
    expect(times(prompt, `task ${first ?? ''} "Task a"`)).toBe(1);
    expect(prompt).toMatch(new RegExp(`task ${first ?? ''} "Task a" — started`));
  });

  it('sends the lines as they stand after a failed start, not as they stood at it', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) => {
      patchShape(ctx, shapeId(), { sdkSessionId: 'sdk-1' });
    });
    f.service.resume(shapeId(), 'Task a is done.');
    const realOpen = f.adapter.open.bind(f.adapter);
    f.adapter.open = (): never => {
      throw new Error('Claude is not available');
    };
    await send('First.');
    f.adapter.open = realOpen;

    write((ctx) =>
      insertWorkstream(ctx, must(first, 'task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    await send('Second.');
    const prompt = must(prompts()[0], 'prompt');
    expect(times(prompt, `task ${first ?? ''} "Task a"`)).toBe(1);
    expect(prompt).toMatch(new RegExp(`task ${first ?? ''} "Task a" — started`));
  });

  it('puts the lines in a digested start once, after a resume event too', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) =>
      insertShapeMessage(ctx, shapeId(), {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Converted.',
      }),
    );
    f.service.resume(shapeId(), 'Task a is done.');
    await send('What should change?');
    expect(times(must(prompts()[0], 'prompt'), `task ${first ?? ''} "Task a"`)).toBe(1);
  });

  it('puts the lines in a digested start once', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) =>
      insertShapeMessage(ctx, shapeId(), {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Text,
        body: 'Converted.',
      }),
    );
    await send('What should change?');
    expect(times(must(prompts()[0], 'prompt'), `task ${first ?? ''} "Task a"`)).toBe(1);
  });
});

describe('re-planning a reopened conversation', () => {
  const cite = (): ShapeMessageId => f.service.resume(shapeId(), 'Reopened to re-plan.').id;

  it('proposes a change and a removal for tasks that have not started, and a new task', async () => {
    const made = convertTasks('a', 'b');
    const first = must(made[0], 'first task');
    const second = must(made[1], 'second task');
    const event = cite();
    expect(
      await callPropose({
        changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }],
        removals: [{ taskId: second, why: 'Not needed', sourceMessageIds: [event] }],
        looseTasks: [loose(event, 'c')],
      }),
    ).toBeNull();
    const rows = listShapeProposals(f.c.store.db, shapeId());
    expect(
      rows
        .filter((r) => r.state === ShapeProposalState.Pending)
        .map((r) => r.key)
        .sort(),
    ).toEqual(['c', `change:${first}`, `remove:${second}`].sort());
  });

  it('moves a converted conversation back to Proposed once a round proposes something', async () => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Converted);
    const event = cite();
    await callPropose({
      changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }],
    });
    expect(getShape(f.c.store.db, shapeId()).state).toBe(ShapeState.Proposed);
  });

  it.each([
    ['a change to a task that has started', 'change'],
    ['a removal of a task that has started', 'removal'],
  ])('refuses %s', async (_name, kind) => {
    const [first] = convertTasks('a').map((id) => must(id, 'task'));
    write((ctx) =>
      insertWorkstream(ctx, must(first, 'task'), {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      }),
    );
    const event = cite();
    const answer = await callPropose(
      kind === 'change'
        ? { changes: [{ taskId: first, title: 'Renamed', sourceMessageIds: [event] }] }
        : { removals: [{ taskId: first, why: 'Gone', sourceMessageIds: [event] }] },
    );
    expect(answer).toMatch(/has started/);
    expect(listShapeProposals(f.c.store.db, shapeId()).filter((r) => r.kind !== 'task')).toEqual(
      [],
    );
  });

  it('refuses a task this conversation did not create', async () => {
    convertTasks('a');
    const handFiled = write((ctx) =>
      insertTask(ctx, f.c.project.id, {
        title: 'Hand filed',
        acceptanceCriteria: ['x'],
        areas: ['api'],
      }),
    ).id;
    const event = cite();
    const answer = await callPropose({
      changes: [{ taskId: handFiled, title: 'Renamed', sourceMessageIds: [event] }],
    });
    expect(answer).toMatch(/was not created by this conversation/);
    expect(listTasks(f.c.store.db, f.c.project.id).find((t) => t.id === handFiled)?.title).toBe(
      'Hand filed',
    );
  });
});
