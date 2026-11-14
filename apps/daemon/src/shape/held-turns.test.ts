import { PlanDraft, ShapeMessageAuthor, ShapeMessageKind } from '@10db/contracts';
import { listItems, listShapeMessages, shapeConversation } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrain, type Drain } from '../self-update';
import type { FakeShapeBehaviour } from '../sessions';
import { reconcileDraft } from './rounds';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// Sessions spec §6.3, §6.4 through Plan: the queue is durable. What waits when 10db quits is kept,
// and after the restart it waits under one "Send now" line: nothing runs unattended, and nothing is
// lost without a word to the builder.

let f: ServiceFixture;
let drain: Drain;
beforeEach(() => {
  drain = createDrain();
  f = createServiceFixture({ hold: drain });
});
afterEach(async () => {
  await f.close();
  drain.stop();
});

const shapeId = () => f.c.shape.id;
const conversation = () => shapeConversation(f.c.store.db, shapeId()).id;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const notices = () =>
  listShapeMessages(f.c.store.db, shapeId())
    .filter((m) => m.author === ShapeMessageAuthor.Note && m.kind === ShapeMessageKind.Notice)
    .map((m) => m.body);
const sendNowLines = () =>
  listItems(f.c.store.db, conversation()).filter((i) => i.kind === 'turn_marker');

/** Turns that wait until the session is stopped. */
const hanging: FakeShapeBehaviour = (turn) =>
  new Promise((resolve) => {
    turn.signal.addEventListener('abort', () => {
      resolve({});
    });
  });

function proposedTask(): void {
  const m = f.c.say();
  f.c.store.write((ctx) =>
    reconcileDraft(
      ctx,
      shapeId(),
      PlanDraft.parse({
        looseTasks: [
          {
            key: 'a',
            title: 'Task a',
            criteria: ['It works'],
            areas: ['api'],
            size: 'S',
            ceremony: 'direct',
            sourceMessageIds: [m],
          },
        ],
      }),
    ),
  );
}

describe('what waits when 10db quits', () => {
  it('keeps a message queued behind a running turn under one Send now, and Send Now sends it', async () => {
    f.adapter.shapeBehaviour = hanging;
    f.service.send(shapeId(), 'One thing.');
    await tick();
    const queued = f.service.send(shapeId(), 'One more thing.');
    await tick();
    await f.restart();
    expect(notices().filter((n) => n.startsWith('10db quit'))).toEqual([]);
    expect(f.adapter.shapeSessions).toHaveLength(1);
    expect(sendNowLines()).toHaveLength(1);
    expect(f.service.view(shapeId()).turn.queued).toBeGreaterThanOrEqual(1);
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Both read.' });
    f.engine.sendNow(conversation());
    await f.service.settled(shapeId());
    expect(f.adapter.shapeSessions).toHaveLength(2);
    expect(f.adapter.shapeSessions[1]?.spec.prompt).toContain(`[m:${queued.id}] One more thing.`);
  });

  it.each([
    ['a Propose', 'propose'],
    ['a rehearsal', 'rehearse'],
  ] as const)('keeps %s queued behind a running turn under Send now', async (_name, press) => {
    if (press === 'rehearse') proposedTask();
    f.adapter.shapeBehaviour = hanging;
    f.service.send(shapeId(), 'One thing.');
    await tick();
    if (press === 'propose') expect(f.service.propose(shapeId())).toEqual({ status: 'started' });
    else expect(f.service.rehearse(shapeId()).status).toBe('started');
    await tick();
    await f.restart();
    expect(notices().filter((n) => n.startsWith('10db quit'))).toEqual([]);
    expect(sendNowLines()).toHaveLength(1);
    f.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
    f.engine.sendNow(conversation());
    await f.service.settled(shapeId());
    expect(f.adapter.shapeSessions[1]?.spec.prompt).toMatch(
      press === 'propose' ? /pressed Propose/ : /rehears/i,
    );
  });

  it('keeps a message sent after the service closed queued, and runs nothing until Send now', async () => {
    drain.begin(new Date(0));
    await f.service.close();
    // The HTTP server still takes a message while the daemon stops.
    f.service.send(shapeId(), 'Too late.');
    await tick();
    drain.stop();
    await f.service.settled(shapeId());
    expect(f.adapter.shapeSessions).toHaveLength(0);
    expect(f.service.turnsInProgress()).toBe(0);
    await f.restart();
    expect(f.adapter.shapeSessions).toHaveLength(0);
    expect(sendNowLines()).toHaveLength(1);
    expect(notices()).toEqual([]);
  });

  it('says nothing when the turn ran before the quit', async () => {
    drain.begin(new Date(0));
    f.service.send(shapeId(), 'One more thing.');
    await tick();
    drain.end();
    await f.service.settled(shapeId());
    await f.restart();
    expect(notices()).toEqual([]);
    expect(sendNowLines()).toEqual([]);
    expect(f.adapter.shapeSessions).toHaveLength(1);
  });
});
