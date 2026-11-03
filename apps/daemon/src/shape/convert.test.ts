import {
  mintId,
  PlanDraft,
  ShapeProposalState,
  ShapeState,
  TaskStatus,
  type TaskId,
} from '@10db/contracts';
import {
  getDecision,
  getShape,
  getTask,
  insertWorkstream,
  listGoalTasks,
  listLandingGroups,
  listShapeLinks,
  listShapeProposals,
  listTasks,
  listWorkstreams,
  searchDecisions,
  insertDecision,
  insertSource,
  type WriteContext,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertProposals, type ConvertOutcome } from './convert';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { dropProposal, reconcileDraft } from './rounds';

// Shape spec §11: Convert is one transaction, refuses a partial selection by name, is idempotent,
// and starts nothing.

let c: ConversationFixture;
beforeEach(() => {
  c = seedConversation();
});
afterEach(() => {
  c.close();
});

const write = <T>(fn: (ctx: WriteContext) => T): T => c.store.write(fn).value;
const propose = (draft: Record<string, unknown>) => {
  const out = write((ctx) => reconcileDraft(ctx, c.shape.id, PlanDraft.parse(draft)));
  if (!out.ok) throw new Error(out.errors.join('; '));
};
const rowOf = (key: string) => {
  const found = listShapeProposals(c.store.db, c.shape.id).find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};
const convert = (...keys: string[]): ConvertOutcome =>
  write((ctx) =>
    convertProposals(
      ctx,
      c.shape.id,
      keys.map((k) => rowOf(k).id),
    ),
  );
const converted = (...keys: string[]) => {
  const out = convert(...keys);
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out;
};
const tasks = () => listTasks(c.store.db, c.project.id);
const taskTitled = (title: string) => {
  const found = tasks().find((t) => t.title === title);
  if (!found) throw new Error(`no task titled ${title}`);
  return found;
};

const loose = (m: string, key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [m],
  ...extra,
});
const goalOf = (
  m: string,
  key: string,
  taskKeys: string[],
  extra: Record<string, unknown> = {},
) => ({
  key,
  title: `Goal ${key}`,
  objective: 'Do the thing.',
  ceremony: 'direct',
  sourceMessageIds: [m],
  tasks: taskKeys.map((t) => ({ key: t, title: `Task ${t}`, areas: ['api'], size: 'S' })),
  ...extra,
});
const decisionOf = (m: string, key: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'decision',
  scope: 'project',
  question: 'Which way?',
  choice: 'This way',
  rationale: 'It is simpler.',
  sourceMessageIds: [m],
  ...extra,
});

describe('a full selection', () => {
  it('writes goals, loose tasks and decisions in dependency order, with the dependencies between them', () => {
    const m = c.say();
    propose({
      goals: [
        goalOf(m, 'density', ['d1', 'd2'], {
          tasks: [
            { key: 'd1', title: 'Setting', areas: ['api'], size: 'S' },
            {
              key: 'd2',
              title: 'Cards',
              areas: ['api'],
              size: 'S',
              depends_on: ['d1'],
              dependsOnOutside: ['scroll'],
            },
          ],
        }),
      ],
      looseTasks: [loose(m, 'scroll'), loose(m, 'after', { dependsOn: ['d1'] })],
      records: [decisionOf(m, 'dec')],
    });
    const out = converted('density', 'scroll', 'after', 'dec');

    expect(out.createdNow).toBe(4);
    const byTitle = new Map(tasks().map((t) => [t.title, t]));
    expect(byTitle.size).toBe(4);
    expect(byTitle.get('Cards')?.dependsOn).toEqual(
      expect.arrayContaining([byTitle.get('Setting')?.id, byTitle.get('Task scroll')?.id]),
    );
    expect(byTitle.get('Task after')?.dependsOn).toEqual([byTitle.get('Setting')?.id]);
    const goalId = must(out.results.find((r) => r.key === 'density')?.goalId, 'the goal');
    expect(
      listGoalTasks(c.store.db, goalId)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Cards', 'Setting']);
    expect(tasks().every((t) => t.status === TaskStatus.Open)).toBe(true);
    // Read the decision back through search.
    expect(searchDecisions(c.store.db, c.project.id, 'simpler', 5).map((d) => d.choice)).toEqual([
      'This way',
    ]);
  });

  it('starts nothing', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')], goals: [goalOf(m, 'g', ['g1'])] });
    converted('a', 'g');
    expect(tasks()).toHaveLength(2);
    expect(listWorkstreams(c.store.db, { projectId: c.project.id })).toEqual([]);
  });

  it('marks the proposals accepted, links what it made, and ends the conversation as converted', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')], records: [decisionOf(m, 'dec')] });
    converted('a', 'dec');
    expect(listShapeProposals(c.store.db, c.shape.id).map((r) => r.state)).toEqual([
      ShapeProposalState.Accepted,
      ShapeProposalState.Accepted,
    ]);
    const links = listShapeLinks(c.store.db, c.shape.id);
    expect(links.map((l) => l.key).sort()).toEqual(['a', 'dec']);
    expect(links.find((l) => l.key === 'a')?.taskId).toBe(tasks()[0]?.id);
    expect(links.find((l) => l.key === 'dec')?.decisionId).toBeTruthy();
    expect(getShape(c.store.db, c.shape.id).state).toBe(ShapeState.Converted);
  });

  it('leaves the conversation proposed while something is still pending', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a'), loose(m, 'b')] });
    converted('a');
    expect(getShape(c.store.db, c.shape.id).state).toBe(ShapeState.Proposed);
  });
});

describe('a partial selection', () => {
  it('refuses a missing dependency by name, writing nothing', () => {
    const m = c.say();
    propose({
      looseTasks: [
        loose(m, 'density', { title: 'Compact density' }),
        loose(m, 'scroll', { title: 'Thin scrollbars', dependsOn: ['density'] }),
      ],
    });
    const out = convert('scroll');
    expect(out).toEqual({
      ok: false,
      errors: ["Thin scrollbars depends on Compact density, which isn't selected"],
    });
    expect(tasks()).toEqual([]);
    expect(rowOf('scroll').state).toBe(ShapeProposalState.Pending);
    expect(listShapeLinks(c.store.db, c.shape.id)).toEqual([]);
  });

  it('names a goal task’s outside dependency too, and lists every refusal', () => {
    const m = c.say();
    propose({
      goals: [
        goalOf(m, 'g', ['g1'], {
          tasks: [
            { key: 'g1', title: 'Cards', areas: ['api'], size: 'S', dependsOnOutside: ['x', 'y'] },
          ],
        }),
      ],
      looseTasks: [loose(m, 'x', { title: 'X first' }), loose(m, 'y', { title: 'Y first' })],
    });
    const out = convert('g');
    expect(out).toEqual({
      ok: false,
      errors: [
        "Cards depends on X first, which isn't selected",
        "Cards depends on Y first, which isn't selected",
      ],
    });
  });

  it('lets a later Convert depend on an earlier one', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'first'), loose(m, 'second', { dependsOn: ['first'] })],
    });
    converted('first');
    converted('second');
    const [a, b] = ['Task first', 'Task second'].map((t) => tasks().find((x) => x.title === t));
    expect(b?.dependsOn).toEqual([a?.id]);
  });

  it('refuses a selection that is not pending or not this conversation’s', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a'), loose(m, 'b')] });
    write((ctx) => {
      dropProposal(ctx, rowOf('b').id);
    });
    expect(convert('b')).toMatchObject({ ok: false });
    expect(
      write((ctx) => convertProposals(ctx, c.shape.id, [mintId('ShapeProposal')])),
    ).toMatchObject({
      ok: false,
    });
  });

  it('refuses a kind it cannot write yet, by name', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'a')],
      questions: [{ key: 'ask', text: 'When?', for: 'Ana', sourceMessageIds: [m] }],
    });
    const out = convert('a', 'ask');
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? [] : out.errors).toEqual([expect.stringContaining('ask')]);
    expect(tasks()).toEqual([]);
  });
});

describe('a second Convert of the same proposals', () => {
  it('creates once, and answers with what the first one created', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')], goals: [goalOf(m, 'g', ['g1'])] });
    const first = converted('a', 'g');
    const second = converted('a', 'g');
    expect(first.createdNow).toBe(2);
    expect(second.createdNow).toBe(0);
    expect(second.results).toEqual(first.results);
    expect(tasks()).toHaveLength(2);
    expect(listShapeLinks(c.store.db, c.shape.id)).toHaveLength(3);
  });

  it('converts only the rest when part of the selection was converted already', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a'), loose(m, 'b')] });
    converted('a');
    const out = converted('a', 'b');
    expect(out.createdNow).toBe(1);
    expect(tasks()).toHaveLength(2);
  });
});

describe('records', () => {
  it('writes a supersede chain, and the old decision leaves search', () => {
    const old = write((ctx) =>
      insertDecision(ctx, {
        projectId: c.project.id,
        question: 'Cache?',
        choice: 'No cache',
        rationale: 'Simple',
        decidedBy: 'builder',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      }),
    );
    const m = c.say();
    propose({
      records: [
        decisionOf(m, 'dec', {
          question: 'Cache?',
          choice: 'Cache in memory',
          rationale: 'Faster',
          supersedes: old,
        }),
      ],
    });
    converted('dec');
    const found = searchDecisions(c.store.db, c.project.id, 'Cache', 5).map((d) => d.choice);
    expect(found).toEqual(['Cache in memory']);
  });

  it('writes a you-scoped decision for every project', () => {
    const m = c.say();
    propose({ records: [decisionOf(m, 'dec', { scope: 'you', rationale: 'Always' })] });
    converted('dec');
    expect(searchDecisions(c.store.db, c.project.id, 'Always', 5)).toHaveLength(1);
    const decisionId = must(listShapeLinks(c.store.db, c.shape.id)[0]?.decisionId, 'the decision');
    expect(getDecision(c.store.db, decisionId)).toMatchObject({
      projectId: null,
      scope: 'you',
    });
  });
});

describe('additions, changes and removals', () => {
  it('adds a task under a converted goal, changes one that has not started, and removes another', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1', 'g2'])] });
    const first = converted('g');
    const goalId = must(first.results.find((r) => r.key === 'g')?.goalId, 'the goal');
    const t1 = taskTitled('Task g1');
    const t2 = taskTitled('Task g2');
    const m2 = c.say('Add one, rename one, drop one.');
    propose({
      goals: [goalOf(m, 'g', ['g1', 'g2'])],
      additions: [{ ...loose(m2, 'g3'), goalId }],
      changes: [{ taskId: t1.id, title: 'Renamed', sourceMessageIds: [m2] }],
      removals: [{ taskId: t2.id, why: 'Not needed', sourceMessageIds: [m2] }],
    });
    converted('g3', `change:${t1.id}`, `remove:${t2.id}`);
    expect(getTask(c.store.db, t1.id).title).toBe('Renamed');
    expect(getTask(c.store.db, t2.id).status).toBe(TaskStatus.Cancelled);
    expect(listGoalTasks(c.store.db, goalId).some((t) => t.title === 'Task g3')).toBe(true);
  });

  it('leaves nothing behind when a write fails part-way', () => {
    const m = c.say();
    propose({
      goals: [
        goalOf(m, 'g', ['g1', 'g2'], {
          tasks: [
            { key: 'g1', title: 'First', areas: ['api'], size: 'S' },
            { key: 'g2', title: 'Second', areas: ['api'], size: 'S', depends_on: ['g1'] },
          ],
        }),
      ],
    });
    converted('g');
    const first = tasks().find((t) => t.title === 'First') as { id: TaskId };
    const m2 = c.say('Add one and drop the first.');
    propose({
      goals: [],
      looseTasks: [loose(m2, 'fresh')],
      removals: [{ taskId: first.id, why: 'Not needed', sourceMessageIds: [m2] }],
    });
    // The second task waits on the first, so removing the first is refused after the new task was written.
    expect(() => convert('fresh', `remove:${first.id}`)).toThrow();
    expect(
      tasks()
        .map((t) => t.title)
        .sort(),
    ).toEqual(['First', 'Second']);
    expect(rowOf('fresh').state).toBe(ShapeProposalState.Pending);
  });

  it('refuses a change once its task has started, writing nothing', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')] });
    converted('a');
    const id = taskTitled('Task a').id;
    const m2 = c.say('Rename it.');
    propose({ changes: [{ taskId: id, title: 'Renamed', sourceMessageIds: [m2] }] });
    write((ctx) => insertWorkstream(ctx, id));
    const out = convert(`change:${id}`);
    expect(out).toMatchObject({ ok: false });
    expect(getTask(c.store.db, id).title).toBe('Task a');
  });

  it('refuses the same change again after a drop, and allows a different one', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')] });
    converted('a');
    const id = taskTitled('Task a').id;
    const m2 = c.say('Rename it.');
    const change = (title: string) => ({
      looseTasks: [],
      changes: [{ taskId: id, title, sourceMessageIds: [m2] }],
    });
    propose(change('Renamed'));
    write((ctx) => {
      dropProposal(ctx, rowOf(`change:${id}`).id);
    });
    expect(() => {
      propose(change('Renamed'));
    }).toThrow(/dropped/);
    propose(change('Renamed differently'));
    expect(rowOf(`change:${id}`).state).toBe(ShapeProposalState.Pending);
  });
});

describe('landings (§10.4)', () => {
  const landingOf = (m: string, key: string, keys: string[], title = 'Real areas') => ({
    key,
    title,
    keys,
    sourceMessageIds: [m],
  });

  it("writes a landing group for a goal's tasks and a loose task, and sets each task's group", () => {
    const m = c.say();
    propose({
      goals: [goalOf(m, 'areas', ['r1', 'r2'])],
      looseTasks: [loose(m, 'solo'), loose(m, 'other')],
      landings: [landingOf(m, 'l1', ['r1', 'r2', 'solo'])],
    });
    const out = converted('areas', 'solo', 'other', 'l1');
    expect(out.results.map((r) => r.kind)).toEqual(['goal', 'task', 'task', 'landing']);
    const groups = listLandingGroups(c.store.db, c.project.id);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: 'Real areas', shapeId: c.shape.id });
    const grouped = tasks()
      .filter((t) => t.landingGroupId === groups[0]?.id)
      .map((t) => t.title)
      .sort();
    expect(grouped).toEqual(['Task r1', 'Task r2', 'Task solo']);
    expect(taskTitled('Task other').landingGroupId ?? null).toBeNull();
    expect(rowOf('l1').state).toBe(ShapeProposalState.Accepted);
  });

  it('refuses a landing naming a task that is neither selected nor converted, and writes nothing', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'a'), loose(m, 'b')],
      landings: [landingOf(m, 'l1', ['a', 'b'])],
    });
    const out = convert('a', 'l1');
    expect(out).toMatchObject({ ok: false });
    expect(!out.ok && out.errors.join('\n')).toMatch(/Real areas.*Task b.*isn't selected/);
    expect(tasks()).toEqual([]);
    expect(listLandingGroups(c.store.db, c.project.id)).toEqual([]);
  });

  it('a landing converted after its tasks groups the tasks Convert already made', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'a'), loose(m, 'b')],
      landings: [landingOf(m, 'l1', ['a', 'b'])],
    });
    converted('a', 'b');
    expect(listLandingGroups(c.store.db, c.project.id)).toEqual([]);
    converted('l1');
    const [group] = listLandingGroups(c.store.db, c.project.id);
    expect(tasks().every((t) => t.landingGroupId === group?.id)).toBe(true);
  });

  it('starts none of its tasks, and a repeated Convert makes the group once', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'a'), loose(m, 'b')],
      landings: [landingOf(m, 'l1', ['a', 'b'])],
    });
    converted('a', 'b', 'l1');
    const again = converted('a', 'b', 'l1');
    expect(again.createdNow).toBe(0);
    expect(listLandingGroups(c.store.db, c.project.id)).toHaveLength(1);
    expect(listWorkstreams(c.store.db, { projectId: c.project.id })).toEqual([]);
  });

  it('refuses a landing that takes a task already in another landing', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'a'), loose(m, 'b')],
      landings: [landingOf(m, 'l1', ['a', 'b'])],
    });
    converted('a', 'b', 'l1');
    expect(() => {
      propose({
        looseTasks: [loose(m, 'x')],
        landings: [landingOf(m, 'l3', ['x', 'a'], 'Third')],
      });
    }).toThrow(/a is already in a landing/);
  });
});
