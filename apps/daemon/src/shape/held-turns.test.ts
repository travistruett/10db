import { PlanDraft, ShapeMessageAuthor, ShapeMessageKind } from '@10db/contracts';
import { listShapeMessages } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrain, type Drain } from '../self-update';
import { reconcileDraft } from './rounds';
import { createServiceFixture, type ServiceFixture } from './service-fixture';

// A turn the drain holds has begun nothing, so the install does not wait for it. The queue is memory
// only: the quit ends it, and nothing may go missing without a word to the builder.

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
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const notices = () =>
  listShapeMessages(f.c.store.db, shapeId())
    .filter((m) => m.author === ShapeMessageAuthor.Note && m.kind === ShapeMessageKind.Notice)
    .map((m) => m.body);

describe('a turn held by the drain when 10db quits', () => {
  it('is reported in the conversation, naming the message, and no session starts for it', async () => {
    drain.begin(new Date(0));
    f.service.send(shapeId(), 'One more thing.');
    f.service.send(shapeId(), 'And another.');
    await tick();
    await f.restart();
    drain.end();
    await f.service.settled(shapeId());
    expect(notices()).toEqual([
      '10db quit before Claude read “One more thing.”, so it went unanswered. Send it again.',
      '10db quit before Claude read “And another.”, so it went unanswered. Send it again.',
    ]);
    expect(f.adapter.shapeSessions).toHaveLength(0);
  });

  it('is reported when it was a Propose', async () => {
    drain.begin(new Date(0));
    expect(f.service.propose(shapeId())).toEqual({ status: 'started' });
    await tick();
    await f.restart();
    expect(notices()).toEqual(['10db quit before Claude could propose. Press Propose again.']);
  });

  it('is reported when it was a rehearsal', async () => {
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
    drain.begin(new Date(0));
    expect(f.service.rehearse(shapeId()).status).toBe('started');
    await tick();
    await f.restart();
    expect(notices()).toEqual(['10db quit before the rehearsal ran. Press Rehearse again.']);
  });

  it('is reported when it was sent after the service closed, and the hold letting go starts no session for it', async () => {
    drain.begin(new Date(0));
    await f.service.close();
    // The HTTP server still takes a message while the daemon stops; close has already emptied the queue.
    f.service.send(shapeId(), 'Too late.');
    await tick();
    drain.stop();
    await f.service.settled(shapeId());
    expect(notices()).toEqual([
      '10db quit before Claude read “Too late.”, so it went unanswered. Send it again.',
    ]);
    expect(f.adapter.shapeSessions).toHaveLength(0);
  });

  it('says nothing when the turn ran before the quit', async () => {
    drain.begin(new Date(0));
    f.service.send(shapeId(), 'One more thing.');
    await tick();
    drain.end();
    await f.service.settled(shapeId());
    await f.restart();
    expect(notices()).toEqual([]);
    expect(f.adapter.shapeSessions).toHaveLength(1);
  });
});
