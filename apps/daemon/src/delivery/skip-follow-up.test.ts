import type { TaskId } from '@10db/contracts';
import {
  createTestStore,
  getTask,
  insertBatch,
  insertSkipFollowUp,
  insertTask,
  listTaskThread,
  schema,
  type Store,
} from '@10db/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { startPendingSkipFollowUps } from './skip-follow-up';

// A follow-up of Run these now starts from where its source stands each time it is looked at: it waits
// on the source's open pull request, saying so on its own task, and starts once that can't be read.

let close: () => void = () => undefined;
afterEach(() => {
  close();
});

/** A source run whose shipped batch's pull request is `prState`, and a follow-up of it not yet started. */
function shippedSource(prState: 'open' | 'unknown') {
  const test = createTestStore();
  close = test.close;
  const store: Store = test.store;
  const state: StateStore = createStateStore(store, createEventBus());
  const { project, workstream } = seedWorkstream(store);
  const follow = store.write((ctx) => {
    ctx.tx
      .update(schema.projects)
      .set({ delivery: 'pull_request' })
      .where(eq(schema.projects.id, project.id))
      .run();
    const batch = insertBatch(ctx, { projectId: project.id, title: 'Alpha', baseBranch: 'main' });
    ctx.tx
      .update(schema.batches)
      .set({
        state: 'SHIPPED',
        prState,
        prChecks: 'none',
        prCheckedAt: '2026-11-14T09:00:00.000Z',
      })
      .where(eq(schema.batches.id, batch.id))
      .run();
    ctx.tx
      .update(schema.workstreams)
      .set({ batchId: batch.id })
      .where(eq(schema.workstreams.id, workstream.id))
      .run();
    const task = insertTask(ctx, project.id, {
      title: 'Run what "Alpha" skipped',
      acceptanceCriteria: ['it ran'],
      areas: ['api'],
    });
    insertSkipFollowUp(ctx, {
      taskId: task.id,
      sourceWorkstreamId: workstream.id,
      sourceBatchId: batch.id,
    });
    return task;
  }).value;
  const started: TaskId[] = [];
  const deps = {
    state,
    starts: {
      join: () => {
        throw new Error('a shipped source has no batch to join');
      },
      base: (taskId: TaskId) => {
        started.push(taskId);
      },
    },
    log: silentLogger,
  };
  return {
    store,
    follow,
    started,
    run: () => {
      startPendingSkipFollowUps(deps);
    },
  };
}

describe('startPendingSkipFollowUps', () => {
  it('waits on an open pull request and says why on the follow-up, once', () => {
    const s = shippedSource('open');
    s.run();
    s.run();
    expect(s.started).toEqual([]);
    expect(
      listTaskThread(s.store.db, s.follow.id)
        .filter((m) => m.kind === 'notice')
        .map((m) => m.body),
    ).toEqual([
      "Waiting for the source's pull request to merge or close: a second batch never ships on a branch another batch owns.",
    ]);
  });

  it("starts from the base when the pull request can't be read, saying so in its description", () => {
    const s = shippedSource('unknown');
    s.run();
    expect(s.started).toEqual([s.follow.id]);
    expect(getTask(s.store.db, s.follow.id).description).toContain(
      "10db couldn't read the source's pull request, so its work may not be on the base this follow-up starts from.",
    );
  });
});
