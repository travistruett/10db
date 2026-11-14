import type { ProjectId, TaskId, WorkstreamId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  insertSkipFollowUp,
  markSkipFollowUpStarted,
  pendingSkipFollowUps,
  skipFollowUpOf,
} from './skip-follow-ups';
import type { Store } from './store';
import { cancelTask, insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

// T4 Task 10: a follow-up is pending until it is stamped, and removing it or finishing it ends it.

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const taskOf = (projectId: ProjectId, title: string): TaskId =>
  store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value.id;

function followUp(): { source: WorkstreamId; follow: TaskId } {
  const project = seedProject(store).id;
  const sourceTask = taskOf(project, 'Alpha');
  const source = store.write((ctx) =>
    insertWorkstream(ctx, sourceTask, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
  ).value.id;
  const follow = taskOf(project, 'Run what "Alpha" skipped');
  store.write((ctx) => {
    insertSkipFollowUp(ctx, { taskId: follow, sourceWorkstreamId: source, sourceBatchId: null });
  });
  return { source, follow };
}

describe('skip follow-ups', () => {
  it("a pending follow-up lists until it is stamped, and is the source run's while it runs", () => {
    const { source, follow } = followUp();
    expect(pendingSkipFollowUps(store.db).map((f) => f.taskId)).toEqual([follow]);
    store.write((ctx) => {
      markSkipFollowUpStarted(ctx, follow);
    });
    expect(pendingSkipFollowUps(store.db)).toEqual([]);
    expect(skipFollowUpOf(store.db, source)?.title).toBe('Run what "Alpha" skipped');
    store.write((ctx) => {
      setTaskStatus(ctx, follow, 'done');
    });
    expect(skipFollowUpOf(store.db, source)).toBeNull();
  });

  it('a removed follow-up is no longer pending', () => {
    const { source, follow } = followUp();
    store.write((ctx) => cancelTask(ctx, follow));
    expect(pendingSkipFollowUps(store.db)).toEqual([]);
    expect(skipFollowUpOf(store.db, source)).toBeNull();
  });
});
