import { EventType } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../schema';
import { listEventsAfter } from './events';
import { insertProposal, insertSource } from './knowledge';
import type { Store } from './store';
import { insertTask, insertTaskFromProposal, listTasks } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seedProposal(projectId: ReturnType<typeof seedProject>['id']) {
  return store.write((ctx) =>
    insertProposal(ctx, {
      projectId,
      kind: 'new_task',
      title: 'Add caching',
      body: 'Cache the query.',
      sourceId: insertSource(ctx, 'agent', {}),
    }),
  ).value;
}

describe('insertTaskFromProposal', () => {
  it('files an open task with the given title and description and no areas or criteria yet', () => {
    const project = seedProject(store);
    const proposalId = seedProposal(project.id);
    const task = store.write((ctx) =>
      insertTaskFromProposal(ctx, {
        proposalId,
        projectId: project.id,
        title: 'Add caching',
        description: 'Cache the query.',
      }),
    ).value;
    expect(task).toMatchObject({
      projectId: project.id,
      title: 'Add caching',
      description: 'Cache the query.',
      status: 'open',
      acceptanceCriteria: [],
      areas: [],
      dependsOn: [],
    });
  });

  it('stores the placement and reason it is given', () => {
    const project = seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    const task = store.write((ctx) =>
      insertTaskFromProposal(
        ctx,
        {
          proposalId: seedProposal(project.id),
          projectId: project.id,
          title: 'Add caching',
          description: '',
        },
        { workspaceMode: 'worktree', reason: 'touches deps' },
      ),
    ).value;
    expect(task).toMatchObject({ workspaceMode: 'worktree', placementReason: 'touches deps' });
  });

  it('persists the link from the task row to its proposal', () => {
    const project = seedProject(store);
    const proposalId = seedProposal(project.id);
    const task = store.write((ctx) =>
      insertTaskFromProposal(ctx, {
        proposalId,
        projectId: project.id,
        title: 'Add caching',
        description: 'Cache the query.',
      }),
    ).value;
    expect(
      store.db
        .select({ id: schema.tasks.id, proposalId: schema.tasks.proposalId })
        .from(schema.tasks)
        .all(),
    ).toEqual([{ id: task.id, proposalId }]);
  });

  it('puts the task after the open tasks already on the board', () => {
    const project = seedProject(store);
    const first = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] }),
    ).value;
    const proposalId = seedProposal(project.id);
    const filed = store.write((ctx) =>
      insertTaskFromProposal(ctx, {
        proposalId,
        projectId: project.id,
        title: 'Add caching',
        description: 'Cache the query.',
      }),
    ).value;
    expect(filed.boardOrder).toBeGreaterThan(first.boardOrder);
    expect(listTasks(store.db, project.id).map((t) => t.id)).toEqual([first.id, filed.id]);
  });

  it('emits task.created with the proposal id, and a task made by hand carries none', () => {
    const project = seedProject(store);
    const proposalId = seedProposal(project.id);
    const filed = store.write((ctx) =>
      insertTaskFromProposal(ctx, {
        proposalId,
        projectId: project.id,
        title: 'Add caching',
        description: 'Cache the query.',
      }),
    ).value;
    const byHand = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'B', acceptanceCriteria: ['b'], areas: ['api'] }),
    ).value;
    const created = listEventsAfter(store.db, 0, 1000).filter(
      (e) => e.type === EventType.TaskCreated,
    );
    expect(created).toEqual([
      expect.objectContaining({ entityId: filed.id, data: { projectId: project.id, proposalId } }),
      expect.objectContaining({
        entityId: byHand.id,
        data: { projectId: project.id, proposalId: null },
      }),
    ]);
  });

  it('refuses a title the task contract rejects and files nothing', () => {
    const project = seedProject(store);
    const proposalId = seedProposal(project.id);
    expect(() =>
      store.write((ctx) =>
        insertTaskFromProposal(ctx, {
          proposalId,
          projectId: project.id,
          title: '',
          description: 'Cache the query.',
        }),
      ),
    ).toThrow(z.ZodError);
    expect(listTasks(store.db, project.id)).toEqual([]);
  });
});
