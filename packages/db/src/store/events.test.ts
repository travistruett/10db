import { EventType, TaskStatus, type SessionId, type WorkstreamId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { deleteSessionEventsEndedBefore } from './events';
import { insertSession } from './sessions';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';
import { insertTask } from './tasks';
import { insertWorkstream } from './workstreams';

let hashes = 0;

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = undefined;
});
afterEach(() => {
  close();
});

const CUTOFF = '2026-11-13T00:00:00.000Z';
const OLD = '2026-10-01T00:00:00.000Z';
const YOUNG = '2026-11-20T00:00:00.000Z';
const PRUNED = [EventType.SessionContext, EventType.SessionActivity] as const;

let project: ReturnType<typeof seedProject> | undefined;

function seedTask(status: TaskStatus, updatedAt: string) {
  project ??= seedProject(store);
  const projectId = project.id;
  return store.write((ctx) => {
    const task = insertTask(ctx, projectId, {
      title: 'T',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    const ws = insertWorkstream(ctx, task.id, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    ctx.tx
      .update(schema.tasks)
      .set({ status, updatedAt })
      .where(eq(schema.tasks.id, task.id))
      .run();
    return ws;
  }).value;
}

/** A session of the workstream with one row of each type, all at `at`. */
function seedSession(workstreamId: WorkstreamId, endedAt: string | null, at = OLD): SessionId {
  return store.write((ctx) => {
    const session = insertSession(ctx, {
      workstreamId,
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
      mode: 'managed',
      mcpTokenHash: `hash-${String((hashes += 1))}`,
    });
    ctx.tx.update(schema.sessions).set({ endedAt }).where(eq(schema.sessions.id, session.id)).run();
    // Each session gets both pruned types and a session.ended row; only the two types may go.
    for (const type of [...PRUNED, EventType.SessionEnded]) addEvent(ctx.tx, type, session.id, at);
    return session.id;
  }).value;
}

function addEvent(
  tx: Parameters<Parameters<Store['write']>[0]>[0]['tx'],
  type: EventType,
  entityId: string,
  at: string,
) {
  tx.insert(schema.events).values({ type, entityType: 'session', entityId, data: {}, at }).run();
}

function eventsOf(id: string) {
  return store.db
    .select({ type: schema.events.type, at: schema.events.at })
    .from(schema.events)
    .where(eq(schema.events.entityId, id))
    .all()
    .filter((row) => row.type.startsWith('session.') && row.type !== 'session.started')
    .map((row) => `${row.type}@${row.at}`)
    .sort();
}

describe('deleteSessionEventsEndedBefore', () => {
  it('deletes only the two types of finished, old sessions, one batch at a time', () => {
    const done = seedTask(TaskStatus.Done, OLD);
    const endedOld = seedSession(done.id, OLD);
    const endedYoung = seedSession(done.id, YOUNG);
    const neverEnded = seedSession(done.id, null);
    const cancelled = seedTask(TaskStatus.Cancelled, OLD);
    const cancelledOld = seedSession(cancelled.id, OLD);
    const open = seedTask(TaskStatus.Open, OLD);
    const openOld = seedSession(open.id, OLD);
    const recent = seedTask(TaskStatus.Done, YOUNG);
    const recentOld = seedSession(recent.id, OLD);
    // A young activity row of a session that qualifies otherwise.
    store.write((ctx) => {
      addEvent(ctx.tx, EventType.SessionActivity, endedOld, YOUNG);
    });

    let total = 0;
    for (;;) {
      const n = store.write((ctx) => deleteSessionEventsEndedBefore(ctx, CUTOFF, 1)).value;
      if (n === 0) break;
      // One batch never deletes more than its limit.
      expect(n).toBe(1);
      total += n;
    }

    const ended = `${EventType.SessionEnded}@${OLD}`;
    const kept = (type: EventType, at: string) => `${type}@${at}`;
    expect(total).toBe(6);
    expect(eventsOf(endedOld)).toEqual([kept(EventType.SessionActivity, YOUNG), ended].sort());
    expect(eventsOf(neverEnded)).toEqual([ended]);
    expect(eventsOf(cancelledOld)).toEqual([ended]);
    const untouched = [
      kept(EventType.SessionActivity, OLD),
      kept(EventType.SessionContext, OLD),
      ended,
    ].sort();
    expect(eventsOf(endedYoung)).toEqual(untouched);
    expect(eventsOf(openOld)).toEqual(untouched);
    expect(eventsOf(recentOld)).toEqual(untouched);
  });
});
