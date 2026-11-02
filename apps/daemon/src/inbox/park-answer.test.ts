import {
  mintId,
  PARK_TASK_CHOICE,
  PARKED_NOTICE_KEY,
  WorkstreamState,
  type WorkstreamId,
} from '@10db/contracts';
import {
  clearWorkstreamNotices,
  createTestStore,
  getTask,
  getWorkstream,
  listBoardColumns,
  listRecentDecisions,
  schema,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createInboxService, type InboxService } from './index';
import { createParkAnswers } from './park-answer';

let close: () => void;
let state: StateStore;
let inbox: InboxService;
let cancelled: WorkstreamId[];
let cancelFails: boolean;
let base: ReturnType<typeof createTestStore>['store'];

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  cancelled = [];
  cancelFails = false;
  const park = createParkAnswers({
    state,
    cancel: (id) => {
      if (cancelFails) return Promise.reject(new Error('could not stop'));
      cancelled.push(id);
      return Promise.resolve(
        void state.write((ctx) =>
          transitionWorkstream(ctx, id, {
            to: WorkstreamState.Cancelled,
            fence: null,
            reason: 'cancelled by the builder',
          }),
        ),
      );
    },
    log: silentLogger,
  });
  inbox = createInboxService({
    state,
    onParkedAnswer: () => undefined,
    onParkAnswer: park,
  });
});
afterEach(() => {
  close();
});

function askOn(ctx: ReturnType<typeof seedWorkstream>) {
  return inbox.ask({
    projectId: ctx.project.id,
    workstreamId: ctx.workstream.id,
    sessionId: mintId('Session'),
    kind: 'question',
    title: 'Can you capture the live GitHub checks?',
    body: 'The lane has no network for it',
    options: [
      { label: 'Defer', description: 'make no change and end this step' },
      { label: 'Retry', description: 'try again' },
    ],
    recommendation: null,
    category: 'engineering',
    urgency: 'normal',
    detail: null,
    signal: new AbortController().signal,
  });
}

async function settled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('a question card', () => {
  it('offers Park the task after the lane’s own options, whatever it wrote', () => {
    const ctx = seedWorkstream(base);
    const { item } = askOn(ctx);
    expect(item.options.map((o) => o.label)).toEqual(['Defer', 'Retry', PARK_TASK_CHOICE]);
  });

  it('does not add it twice when the lane wrote it', () => {
    const ctx = seedWorkstream(base);
    const { item } = inbox.ask({
      projectId: ctx.project.id,
      workstreamId: ctx.workstream.id,
      sessionId: mintId('Session'),
      kind: 'question',
      title: 'q',
      body: '',
      options: [
        { label: 'Go on', description: '' },
        { label: 'park the task', description: 'mine' },
      ],
      recommendation: null,
      category: 'engineering',
      urgency: 'normal',
      detail: null,
      signal: new AbortController().signal,
    });
    expect(item.options.map((o) => o.label)).toEqual(['Go on', 'park the task']);
  });
});

describe('answering Park the task', () => {
  it('stops the run, parks the task in the Icebox and leaves the question and answer on the run', async () => {
    const ctx = seedWorkstream(base);
    const { item } = askOn(ctx);
    const answered = inbox.answer(item.id, { choice: PARK_TASK_CHOICE, note: 'later' });
    // The card closes with the answer; the session is not handed it.
    expect(answered.state).toBe('RESOLVED');
    expect(answered.answer).toEqual({ choice: PARK_TASK_CHOICE, note: 'later' });
    await settled();

    expect(cancelled).toEqual([ctx.workstream.id]);
    const icebox = listBoardColumns(state.db, ctx.project.id).find((c) => c.name === 'Icebox');
    expect(getTask(state.db, ctx.task.id).boardColumnId).toBe(icebox?.id);
    const run = getWorkstream(state.db, ctx.workstream.id);
    expect(run.state).toBe(WorkstreamState.Cancelled);
    expect(run.notice?.key).toBe(PARKED_NOTICE_KEY);
    expect(run.notice?.line).toContain('Can you capture the live GitHub checks?');
    expect(run.notice?.body).toContain(PARK_TASK_CHOICE);
    expect(run.notice?.body).toContain('later');
    expect(run.notice?.body).toContain('The lane has no network for it');
  });

  it('records no decision: parking is 10db’s control over the run, not an answer to the question', async () => {
    const ctx = seedWorkstream(base);
    const { item } = askOn(ctx);
    expect(item.category).toBe('engineering');
    inbox.answer(item.id, { choice: PARK_TASK_CHOICE, note: 'later' });
    await settled();
    expect(listRecentDecisions(state.db, ctx.project.id, 20)).toEqual([]);
  });

  it('still records a lane’s own answer to an engineering question as a decision', () => {
    const ctx = seedWorkstream(base);
    const { item } = askOn(ctx);
    inbox.answer(item.id, { choice: 'Retry' });
    expect(listRecentDecisions(state.db, ctx.project.id, 20).map((d) => d.choice)).toEqual([
      'Retry',
    ]);
  });

  it('does not deliver the answer to the waiting session', async () => {
    const ctx = seedWorkstream(base);
    const { item, answer } = askOn(ctx);
    let delivered = false;
    void answer.then(() => {
      delivered = true;
    });
    inbox.answer(item.id, { choice: PARK_TASK_CHOICE });
    await settled();
    expect(delivered).toBe(false);
  });

  it('makes an Icebox column when the project has none', async () => {
    const ctx = seedWorkstream(base);
    state.write((c) => {
      // The test store holds this one project, so these are all its columns.
      c.tx.delete(schema.boardColumns).run();
    });
    const { item } = askOn(ctx);
    inbox.answer(item.id, { choice: PARK_TASK_CHOICE });
    await settled();
    const columns = listBoardColumns(state.db, ctx.project.id);
    expect(columns.map((c) => c.name)).toEqual(['Icebox']);
    expect(getTask(state.db, ctx.task.id).boardColumnId).toBe(columns[0]?.id);
  });

  it('still records the answer when the run cannot be stopped', async () => {
    const ctx = seedWorkstream(base);
    cancelFails = true;
    const { item } = askOn(ctx);
    const answered = inbox.answer(item.id, { choice: PARK_TASK_CHOICE });
    await settled();
    expect(answered.state).toBe('RESOLVED');
    expect(getTask(state.db, ctx.task.id).boardColumnId).toBeNull();
  });

  it('leaves a lane’s own choice alone, however it is worded', async () => {
    const ctx = seedWorkstream(base);
    const { item, answer } = askOn(ctx);
    const given = answer.then((a) => a.choice);
    inbox.answer(item.id, { choice: 'Defer' });
    expect(await given).toBe('Defer');
    await settled();
    expect(cancelled).toEqual([]);
    expect(getTask(state.db, ctx.task.id).boardColumnId).toBeNull();
  });
});

describe('the notice a parked run keeps', () => {
  it('survives a daemon start, which clears the other runs’ notices', async () => {
    const ctx = seedWorkstream(base);
    const { item } = askOn(ctx);
    inbox.answer(item.id, { choice: PARK_TASK_CHOICE });
    await settled();
    state.write((c) => clearWorkstreamNotices(c));
    expect(getWorkstream(state.db, ctx.workstream.id).notice?.key).toBe(PARKED_NOTICE_KEY);
  });
});
