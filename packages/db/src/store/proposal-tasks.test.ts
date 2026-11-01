import { EventType } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../schema';
import { listEventsAfter } from './events';
import { insertProposal, insertSource } from './knowledge';
import type { Store } from './store';
import { insertTask, insertTaskFromProposal, listTasks } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seedProposal(
  projectId: ReturnType<typeof seedProject>['id'],
  ref: Record<string, string> = {},
) {
  return store.write((ctx) =>
    insertProposal(ctx, {
      projectId,
      kind: 'new_task',
      title: 'Add caching',
      body: 'Cache the query.',
      sourceId: insertSource(ctx, 'agent', ref),
    }),
  ).value;
}

function file(
  projectId: ReturnType<typeof seedProject>['id'],
  proposalId: ReturnType<typeof seedProposal>,
) {
  return store.write((ctx) =>
    insertTaskFromProposal(ctx, {
      proposalId,
      projectId,
      title: 'Add caching',
      description: 'Cache the query.',
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

describe('insertTaskFromProposal areas', () => {
  const repoOnly = { areas: [{ name: 'repo', globs: ['**'] }] };

  it('takes the areas of the task whose session raised the proposal', () => {
    const project = seedProject(store);
    const raiser = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Raiser',
        acceptanceCriteria: ['a'],
        areas: ['ui', 'api'],
      }),
    ).value;
    const workstream = store.write((ctx) => insertWorkstream(ctx, raiser.id)).value;
    const proposalId = seedProposal(project.id, {
      sessionId: 'ses_x',
      workstreamId: workstream.id,
    });
    expect(file(project.id, proposalId).areas).toEqual(['ui', 'api']);
  });

  it("takes the project's only area when no raising task names any", () => {
    const project = seedProject(store, repoOnly);
    expect(file(project.id, seedProposal(project.id)).areas).toEqual(['repo']);
  });

  it('leaves the areas empty when nothing says which: several areas and no raising task', () => {
    const project = seedProject(store);
    expect(file(project.id, seedProposal(project.id)).areas).toEqual([]);
  });

  it("falls back to the project's only area when the raising task has none", () => {
    const project = seedProject(store, repoOnly);
    const raiser = file(project.id, seedProposal(project.id));
    store.write((ctx) => {
      ctx.tx.update(schema.tasks).set({ areas: [] }).where(eq(schema.tasks.id, raiser.id)).run();
    });
    const workstream = store.write((ctx) => insertWorkstream(ctx, raiser.id)).value;
    const proposalId = seedProposal(project.id, { workstreamId: workstream.id });
    expect(file(project.id, proposalId).areas).toEqual(['repo']);
  });
});
