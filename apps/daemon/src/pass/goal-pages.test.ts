import type { ProjectInput, TaskId } from '@10db/contracts';
import { insertEvidence, insertGoal, insertWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { goalPassPages } from './goal-pages';

// Workbench spec §4.2: Work on This opens a pass on the pages a goal's tasks committed in, found with
// `classifyPath` over the paths of their commits.

const PROJECT: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
    { name: 'billing', globs: ['src/billing/**'], role: 'page' },
    { name: 'src', globs: ['src/**'], role: 'shared' },
  ],
};

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

/** A goal of the project with a task per key, each on the shared `src` area. */
function goalWith(keys: readonly string[]) {
  return h.state.write((ctx) => {
    const made = insertGoal(ctx, h.project.id, {
      brief: {
        title: 'Rework',
        objective: 'Rework the screens.',
        tasks: keys.map((key) => ({ key, title: `Rework ${key}`, areas: ['src'] })),
      },
    });
    const id = (key: string): TaskId => {
      const task = made.taskIds.get(key);
      if (!task) throw new Error(`the brief makes ${key}`);
      return task;
    };
    return { goal: made.goal, id };
  });
}

/** Records `shas` as commits the task's lane made, as the commit tool's evidence does. */
function committed(taskId: TaskId, shas: readonly string[]): void {
  h.state.write((ctx) => {
    const ws = insertWorkstream(ctx, taskId, {
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
    insertEvidence(ctx, {
      workstreamId: ws.id,
      kind: 'agent',
      command: 'commit',
      exitCode: 0,
      summary: 'committed',
      logPath: null,
      commitShas: shas,
    });
  });
}

describe("a goal's pass pages", () => {
  it('names each page its tasks committed in, in the order of the areas, and the tasks that did', async () => {
    h = createDeliveryHarness(PROJECT);
    const { goal, id } = goalWith(['people', 'both', 'shared']);
    committed(id('people'), [h.commit('src/people/list.tsx', 'list\n')]);
    committed(id('both'), [
      h.commit('src/settings/form.tsx', 'form\n'),
      h.commit('src/people/card.tsx', 'card\n'),
    ]);
    committed(id('shared'), [h.commit('src/shared.ts', 'shared\n'), 'f'.repeat(40)]);
    const outside = h.addTask('Billing: tidy', { areas: ['billing'] });
    committed(outside.id, [h.commit('src/billing/page.tsx', 'billing\n')]);

    const pages = await goalPassPages({ db: h.store.db, git: h.git }, goal.id);

    expect(pages).toEqual({ pages: ['settings', 'people'], fromTasks: [id('people'), id('both')] });
  });

  it('names no page for a goal whose tasks committed nothing', async () => {
    h = createDeliveryHarness(PROJECT);
    const { goal } = goalWith(['a']);

    expect(await goalPassPages({ db: h.store.db, git: h.git }, goal.id)).toEqual({
      pages: [],
      fromTasks: [],
    });
  });
});
