import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventType,
  RoutedBy,
  type InboxKind,
  type PersonId,
  type ProjectId,
  type QuestionCategory,
  type TaskId,
} from '@10db/contracts';
import { getInboxItem, insertInboxItem, setInboxRecipients } from './inbox';
import { assigneesFor, setRoutingRules } from './routing-rules';
import type { Store } from './store';
import { cancelTask, insertTask } from './tasks';
import { insertGoal, listGoalTasks } from './goals';
import { insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

type Rule = Parameters<typeof setRoutingRules>[2]['rules'][number];

function world() {
  const project = seedProject(store); // areas api, ui
  const person = (handle: string) =>
    store.write((ctx) => insertPerson(ctx, { handle, name: handle })).value;
  const builder = store.write((ctx) =>
    insertPerson(ctx, { handle: 'me', name: 'You', isBuilder: true }),
  ).value;
  const mark = person('mark');
  const ana = person('ana');
  const dana = person('dana');
  const goal = store.write((ctx) =>
    insertGoal(ctx, project.id, {
      ownerId: builder.id,
      brief: {
        title: 'G',
        objective: 'o',
        criteria: [{ text: 'ok', check: 'command' }],
        people: [],
        tasks: [
          { key: 'a', title: 'A', areas: ['api'], criteria: ['x'], depends_on: [] },
          { key: 'b', title: 'B', areas: ['ui'], criteria: ['x'], depends_on: [] },
        ],
      },
    }),
  ).value.goal;
  const goalTasks = listGoalTasks(store.db, goal.id);
  const taskIn = (area: string): TaskId => {
    const task = goalTasks.find((t) => t.areas.includes(area));
    if (!task) throw new Error(`no goal task in ${area}`);
    return task.id;
  };
  const loose = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Loose', acceptanceCriteria: ['x'], areas: ['ui'] }),
  ).value;
  const other = store.write((ctx) =>
    insertTask(ctx, project.id, { title: 'Other', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
  const route = (rules: Rule[]) =>
    store.write((ctx) => setRoutingRules(ctx, project.id, { rules }));
  const ask = (
    taskIds: TaskId[],
    over: {
      category?: QuestionCategory;
      topic?: string | null;
      kind?: InboxKind;
      passPage?: boolean;
    } = {},
  ) =>
    assigneesFor(store.db, {
      projectId: project.id,
      kind: over.kind ?? 'question',
      category: over.category ?? 'product',
      topic: over.topic ?? null,
      taskIds,
      passPage: over.passPage ?? false,
    });
  return {
    project,
    mark,
    ana,
    dana,
    goal,
    api: taskIn('api'),
    ui: taskIn('ui'),
    loose: loose.id,
    other: other.id,
    route,
    ask,
    person,
  };
}

const anyRoute = (personId: PersonId, over: Partial<Rule> = {}): Rule => ({
  category: 'product',
  area: null,
  personId,
  ...over,
});

describe('assigneesFor', () => {
  it('a project area route answers, at tier project_area', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([w.loose])).toEqual({ handles: ['mark'], tier: 'project_area', note: null });
  });

  it('an area route for work that claims another area gives nothing', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([w.other]).tier).toBe('builder');
  });

  it('a goal category route beats a project area route', () => {
    const w = world();
    w.route([anyRoute(w.ana.id, { area: 'ui' }), anyRoute(w.mark.id, { goalId: w.goal.id })]);
    expect(w.ask([w.ui])).toMatchObject({ handles: ['mark'], tier: 'goal' });
  });

  it('a goal area route beats a goal category route', () => {
    const w = world();
    w.route([
      anyRoute(w.mark.id, { goalId: w.goal.id }),
      anyRoute(w.ana.id, { goalId: w.goal.id, area: 'api' }),
    ]);
    expect(w.ask([w.api])).toMatchObject({ handles: ['ana'], tier: 'goal_area' });
    expect(w.ask([w.ui])).toMatchObject({ handles: ['mark'], tier: 'goal' });
  });

  it('a task route beats its goal', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { goalId: w.goal.id }), anyRoute(w.ana.id, { taskId: w.api })]);
    expect(w.ask([w.api])).toMatchObject({ handles: ['ana'], tier: 'task' });
  });

  it('a task route for design does not catch product', () => {
    const w = world();
    w.route([anyRoute(w.ana.id, { taskId: w.api, category: 'design' })]);
    expect(w.ask([w.api], { category: 'product' }).tier).toBe('builder');
    expect(w.ask([w.api], { category: 'design' }).handles).toEqual(['ana']);
  });

  it('a task with no goal uses the project', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { goalId: w.goal.id }), anyRoute(w.ana.id, { area: 'ui' })]);
    expect(w.ask([w.loose])).toMatchObject({ handles: ['ana'], tier: 'project_area' });
  });

  it('a goal route for Mark beats a project route for Ana, with no tie across scopes', () => {
    const w = world();
    w.route([anyRoute(w.ana.id, { area: 'ui' }), anyRoute(w.mark.id, { goalId: w.goal.id })]);
    expect(w.ask([w.ui]).handles).toEqual(['mark']);
  });

  it('a cancelled task has its route ignored', () => {
    const w = world();
    w.route([anyRoute(w.ana.id, { taskId: w.loose }), anyRoute(w.mark.id, { area: 'ui' })]);
    store.write((ctx) => cancelTask(ctx, w.loose));
    expect(w.ask([w.loose]).handles).toEqual(['mark']);
  });

  it('a permission card with a matching route goes to the builder', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([w.loose], { kind: 'permission' })).toEqual({
      handles: ['me'],
      tier: 'builder',
      note: null,
    });
  });

  it('a card with no task goes to the builder', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([]).tier).toBe('builder');
  });

  it('two tasks routed to Mark and Dana go to the builder; both to Mark go to Mark', () => {
    const w = world();
    w.route([
      anyRoute(w.mark.id, { taskId: w.api }),
      anyRoute(w.dana.id, { taskId: w.ui }),
      anyRoute(w.mark.id, { taskId: w.loose }),
    ]);
    expect(w.ask([w.api, w.ui]).handles).toEqual(['me']);
    expect(w.ask([w.api, w.loose]).handles).toEqual(['mark']);
  });

  it('a tie makes everyone a recipient, in the order the routes were added', () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' }), anyRoute(w.ana.id, { area: 'ui' })]);
    expect(w.ask([w.loose]).handles).toEqual(['mark', 'ana']);
    w.route([anyRoute(w.ana.id, { area: 'ui' }), anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([w.loose]).handles).toEqual(['ana', 'mark']);
  });

  it('nine people on one route go to the builder with the note', () => {
    const w = world();
    const nine = Array.from({ length: 9 }, (_, i) => w.person(`p${String(i)}`));
    w.route(nine.map((p) => anyRoute(p.id, { area: 'ui' })));
    expect(w.ask([w.loose])).toEqual({
      handles: ['me'],
      tier: 'builder',
      note: '9 people answer product questions here, more than a Slack group DM holds. Use Ask Someone to pick.',
    });
  });

  it("a pass page's question under a matching route goes to the builder", () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' })]);
    expect(w.ask([w.loose], { passPage: true }).handles).toEqual(['me']);
  });

  it('project category and topic routes only give tier triage, with the lane tags as the fallback', () => {
    const w = world();
    w.route([
      anyRoute(w.mark.id),
      anyRoute(w.ana.id, { category: 'design' }),
      { category: null, area: null, topic: 'billing', personId: w.dana.id },
    ]);
    expect(w.ask([w.loose], { topic: 'billing' })).toMatchObject({
      handles: ['dana'],
      tier: 'triage',
    });
    expect(w.ask([w.loose])).toMatchObject({ handles: ['mark'], tier: 'triage' });
    expect(w.ask([w.loose], { topic: 'unknown' })).toMatchObject({
      handles: ['mark'],
      tier: 'triage',
    });
    expect(w.ask([w.loose], { category: 'engineering' })).toMatchObject({
      handles: ['me'],
      tier: 'triage',
    });
  });

  it('no routes at all give the builder', () => {
    const w = world();
    expect(w.ask([w.loose])).toEqual({ handles: ['me'], tier: 'builder', note: null });
  });
});

describe('a new card', () => {
  it("takes the recipients and the rule recipients of its task's area route", () => {
    const w = world();
    w.route([anyRoute(w.mark.id, { area: 'ui' }), anyRoute(w.ana.id, { area: 'ui' })]);
    const ws = store.write((ctx) =>
      insertWorkstream(ctx, w.loose, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    ).value;
    const card = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: w.project.id,
        kind: 'question',
        title: 'Which shade?',
        body: '',
        options: [],
        recommendation: null,
        category: 'product',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [{ workstreamId: ws.id, sessionId: null }],
      }),
    ).value;
    expect(card).toMatchObject({ assignee: 'mark', assignees: ['mark', 'ana'], routedBy: 'rule' });
  });
});

describe('setInboxRecipients', () => {
  const newCard = (project: { id: ProjectId }) =>
    store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: project.id,
        kind: 'question',
        title: 'Which?',
        body: '',
        options: [],
        recommendation: null,
        category: 'engineering',
        urgency: 'normal',
        detail: null,
        foldKey: null,
        targets: [],
      }),
    ).value;

  it('sets the first handle as the assignee, keeps the list and the suggestion', () => {
    const card = newCard(seedProject(store));
    const ana = store.write((ctx) => insertPerson(ctx, { handle: 'zed', name: 'Zed' })).value;
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam', 'ana'],
        routedBy: RoutedBy.Judge,
        suggestion: { personIds: [ana.id], confidence: 0.7 },
      }),
    );
    expect(getInboxItem(store.db, card.id)).toMatchObject({
      assignee: 'sam',
      assignees: ['sam', 'ana'],
      routedBy: 'judge',
      routeSuggestion: { personIds: [ana.id], confidence: 0.7 },
    });
  });

  it('falls to the builder when the list is empty, and announces leaving triage_pending once', () => {
    const card = newCard(seedProject(store));
    store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam'],
        routedBy: RoutedBy.TriagePending,
        suggestion: null,
      }),
    );
    const first = store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: [],
        routedBy: RoutedBy.Builder,
        suggestion: null,
      }),
    );
    expect(first.value.assignee).toBe('me');
    expect(first.events.find((e) => e.type === EventType.InboxTriaged)?.data).toEqual({
      routedBy: 'builder',
      toBuilder: true,
    });
    const second = store.write((ctx) =>
      setInboxRecipients(ctx, card.id, {
        assignees: ['sam'],
        routedBy: RoutedBy.Rule,
        suggestion: null,
      }),
    );
    expect(second.events.some((e) => e.type === EventType.InboxTriaged)).toBe(false);
  });
});
