import { CriterionCheck, type QuestionRouteDto } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertGoal, listGoalTasks } from './goals';
import { questionRoutesForTask } from './question-routes';
import { setRoutingRules } from './routing-rules';
import type { Store } from './store';
import { insertTask } from './tasks';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

function world() {
  const project = seedProject(store);
  const person = (handle: string) =>
    store.write((ctx) => insertPerson(ctx, { handle, name: handle })).value;
  const builder = store.write((ctx) =>
    insertPerson(ctx, { handle: 'me', name: 'You', isBuilder: true }),
  ).value;
  const goal = store.write((ctx) =>
    insertGoal(ctx, project.id, {
      ownerId: builder.id,
      brief: {
        title: 'G',
        objective: 'o',
        criteria: [{ text: 'ok', check: CriterionCheck.Command }],
        people: [],
        tasks: [{ key: 'a', title: 'A', areas: ['api'], criteria: ['x'], depends_on: [] }],
      },
    }),
  ).value.goal;
  const inGoal = listGoalTasks(store.db, goal.id)[0];
  const loose = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Loose', acceptanceCriteria: ['x'], areas: ['ui'] }),
  ).value;
  return { project, goal, inGoal, loose, person };
}

const names = (routes: QuestionRouteDto[]) =>
  routes.map((r) => [
    r.category ?? `topic:${r.topic ?? ''}`,
    r.from,
    r.people.map((p) => p.handle),
  ]);

describe('questionRoutesForTask', () => {
  it('names the people each category goes to and which scope says so', () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana');
    w.person('sarah');
    store.write((ctx) =>
      setRoutingRules(ctx, w.project.id, {
        rules: [
          { category: 'product', area: 'ui', personId: mark.id },
          { category: 'design', area: null, personId: ana.id },
          { category: 'business', area: null, personId: mark.id },
        ],
      }),
    );
    expect(names(questionRoutesForTask(store.db, w.loose.id))).toEqual([
      ['product', 'area', ['mark']],
      ['design', 'project', ['ana']],
      ['business', 'project', ['mark']],
    ]);
  });

  it('lets a goal route beat a project route, and a tie name both people in routing order', () => {
    const w = world();
    const mark = w.person('mark');
    const ana = w.person('ana');
    store.write((ctx) =>
      setRoutingRules(ctx, w.project.id, {
        rules: [
          { category: 'product', area: null, personId: ana.id },
          { category: 'product', area: null, goalId: w.goal.id, personId: mark.id },
          { category: 'product', area: null, goalId: w.goal.id, personId: ana.id },
        ],
      }),
    );
    expect(names(questionRoutesForTask(store.db, w.inGoal?.id ?? w.loose.id))).toEqual([
      ['product', 'goal', ['mark', 'ana']],
    ]);
  });

  it("lists the project's topics with their people", () => {
    const w = world();
    const sarah = w.person('sarah');
    store.write((ctx) =>
      setRoutingRules(ctx, w.project.id, {
        rules: [
          { category: null, area: null, topic: 'billing', personId: sarah.id },
          { category: null, area: null, topic: 'pricing', personId: sarah.id },
        ],
      }),
    );
    expect(names(questionRoutesForTask(store.db, w.loose.id))).toEqual([
      ['topic:billing', 'topic', ['sarah']],
      ['topic:pricing', 'topic', ['sarah']],
    ]);
  });

  it('gives an unrouted task nothing', () => {
    const w = world();
    expect(questionRoutesForTask(store.db, w.loose.id)).toEqual([]);
  });

  it('ignores a route of another task', () => {
    const w = world();
    const mark = w.person('mark');
    store.write((ctx) =>
      setRoutingRules(ctx, w.project.id, {
        rules: [{ category: 'product', area: null, taskId: w.loose.id, personId: mark.id }],
      }),
    );
    expect(names(questionRoutesForTask(store.db, w.loose.id))).toEqual([
      ['product', 'task', ['mark']],
    ]);
    expect(questionRoutesForTask(store.db, w.inGoal?.id ?? w.loose.id)).toEqual([]);
  });
});
