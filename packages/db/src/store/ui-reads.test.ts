import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestEventSeq, listEventsAfter } from './events';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { getWorkstream, insertWorkstream, listWorkstreams } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

describe('reads the UI needs', () => {
  it('reports the latest event seq, or 0 before any event', () => {
    expect(latestEventSeq(store.db)).toBe(0);
    seedProject(store);
    const events = listEventsAfter(store.db, 0, 100);
    expect(latestEventSeq(store.db)).toBe(events.at(-1)?.seq);
  });

  it('carries the task title on every workstream', () => {
    const project = seedProject(store);
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Write the greeting',
        acceptanceCriteria: ['done'],
        areas: ['api'],
      }),
    ).value;
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    expect(ws.taskTitle).toBe('Write the greeting');
    expect(getWorkstream(store.db, ws.id).taskTitle).toBe('Write the greeting');
    expect(listWorkstreams(store.db).map((w) => w.taskTitle)).toEqual(['Write the greeting']);
  });
});
