import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answeredCardsForTask, insertInboxItem, updateInboxItem } from './inbox';
import { insertTask } from './tasks';
import { insertWorkstream } from './workstreams';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seedRun(title: string) {
  const project = seedProject(store);
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title, acceptanceCriteria: ['it works'], areas: ['api'] }),
  ).value;
  const workstream = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { project, task, workstream };
}

function card(
  run: ReturnType<typeof seedRun>,
  over: Partial<Parameters<typeof insertInboxItem>[1]> = {},
) {
  return store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId: run.project.id,
      kind: 'question',
      title: 'Ship with criterion 1 unmeasured?',
      body: 'No live session could run.',
      options: [
        { label: 'Ship unmeasured', description: '' },
        { label: 'Hold', description: '' },
      ],
      recommendation: null,
      category: 'engineering',
      urgency: 'normal',
      detail: null,
      foldKey: null,
      targets: [{ workstreamId: run.workstream.id, sessionId: null }],
      ...over,
    }),
  ).value;
}

const answer = (
  id: Parameters<typeof updateInboxItem>[1],
  state: 'ANSWERED' | 'DELIVERING' | 'RESOLVED' = 'ANSWERED',
) =>
  store.write((ctx) =>
    updateInboxItem(ctx, id, {
      state,
      answer: { choice: 'Ship unmeasured', note: 'Follow-up runs it.' },
    }),
  ).value;

describe('answeredCardsForTask', () => {
  it('lists the cards answered on the task, oldest first, with question, choice and note', () => {
    const run = seedRun('Read picture');
    const first = card(run, { title: 'First?' });
    const second = card(run, { title: 'Second?' });
    answer(second.id, 'RESOLVED');
    answer(first.id, 'DELIVERING');
    expect(answeredCardsForTask(store.db, run.task.id)).toEqual([
      {
        id: first.id,
        kind: 'question',
        question: 'First?',
        choice: 'Ship unmeasured',
        note: 'Follow-up runs it.',
      },
      {
        id: second.id,
        kind: 'question',
        question: 'Second?',
        choice: 'Ship unmeasured',
        note: 'Follow-up runs it.',
      },
    ]);
  });

  it('leaves out open, cancelled and permission cards and cards of other tasks', () => {
    const run = seedRun('Read picture');
    const other = seedRun('Other task');
    card(run, { title: 'Still open?' });
    const cancelled = card(run, { title: 'Withdrawn?' });
    store.write((ctx) => updateInboxItem(ctx, cancelled.id, { state: 'CANCELLED' }));
    answer(card(run, { kind: 'permission', title: 'Allow Bash?' }).id);
    answer(card(other, { title: 'Elsewhere?' }).id);
    expect(answeredCardsForTask(store.db, run.task.id)).toEqual([]);
  });

  it('gives a card with no note a null note', () => {
    const run = seedRun('Read picture');
    const item = card(run);
    store.write((ctx) =>
      updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'Hold' } }),
    );
    expect(answeredCardsForTask(store.db, run.task.id)[0]?.note).toBeNull();
  });
});
