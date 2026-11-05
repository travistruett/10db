import {
  KnowledgeListDto,
  mintId,
  PlanDraft,
  ShapeProposalState,
  ShapeState,
  TaskStatus,
  topicKeyFrom,
  type TaskId,
} from '@10db/contracts';
import {
  cancelTask,
  findRecords,
  getDecision,
  getPrinciple,
  getShape,
  getTask,
  insertWorkstream,
  listGoalTasks,
  listInbox,
  listLandingGroups,
  listPrinciples,
  listShapeLinks,
  listShapeProposals,
  listShapeQuestions,
  listTasks,
  listWorkstreams,
  patchProject,
  patchTask,
  searchDecisions,
  searchPrinciples,
  insertDecision,
  insertSource,
  patchShapeProposal,
  type WriteContext,
} from '@10db/db';
import { defineWebSocketHelper } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type ApiServices } from '../api';
import { createKnowledgeServices } from '../daemon';
import { createEventBus, createStateStore } from '../events';
import { convertProposals, type ConvertOutcome } from './convert';
import { must, seedConversation, type ConversationFixture } from './conversation-fixture';
import { dropProposal, editProposal, reconcileDraft, restoreProposal } from './rounds';
import { removeDraftGoalOf } from './undo';

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

const principleOf = (m: string, key: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: 'principle',
  scope: 'project',
  statement: 'Never sleep in tests',
  rationale: 'Sleeps make the suite flaky.',
  sourceMessageIds: [m],
  ...extra,
});

describe('principle records', () => {
  it('writes a confirmed principle by the builder, linked to its proposal, defaulting to a policy', () => {
    const m = c.say('Never sleep in tests.');
    propose({ records: [principleOf(m, 'no-sleeps')] });
    const out = converted('no-sleeps');
    const principleId = must(out.results[0]?.principleId, 'the principle');
    expect(getPrinciple(c.store.db, principleId)).toMatchObject({
      statement: 'Never sleep in tests',
      rationale: 'Sleeps make the suite flaky.',
      kind: 'policy',
      topicKey: topicKeyFrom('Never sleep in tests'),
      scope: 'project',
      projectId: c.project.id,
      status: 'confirmed',
      state: 'current',
      confirmedBy: 'me',
    });
    const link = must(
      listShapeLinks(c.store.db, c.shape.id).find((l) => l.principleId === principleId),
      'the link',
    );
    expect(link).toMatchObject({ key: 'no-sleeps', goalId: null, taskId: null, decisionId: null });
    expect(searchPrinciples(c.store.db, c.project.id, 'sleep', 5).map((p) => p.id)).toEqual([
      principleId,
    ]);
  });

  it('keeps the kind, topic key and builder-wide scope the record names', () => {
    const m = c.say();
    propose({
      records: [
        principleOf(m, 'prefer-small', {
          scope: 'you',
          principleKind: 'heuristic',
          topicKey: 'tasks.small',
          statement: 'Prefer small tasks',
        }),
      ],
    });
    const out = converted('prefer-small');
    expect(
      getPrinciple(c.store.db, must(out.results[0]?.principleId, 'the principle')),
    ).toMatchObject({ kind: 'heuristic', topicKey: 'tasks.small', scope: 'you', projectId: null });
  });

  it('replaces the current principle with the same topic key and scope, which leaves find_records', () => {
    const m = c.say();
    propose({ records: [principleOf(m, 'first', { topicKey: 'tests.sleep' })] });
    const first = must(converted('first').results[0]?.principleId, 'the first principle');
    propose({
      records: [
        principleOf(m, 'first', { topicKey: 'tests.sleep' }),
        principleOf(m, 'second', {
          topicKey: 'tests.sleep',
          statement: 'Never sleep in tests; wait on a condition',
        }),
      ],
    });
    const second = must(converted('second').results[0]?.principleId, 'the second principle');
    expect(getPrinciple(c.store.db, first)).toMatchObject({
      state: 'superseded',
      supersededById: second,
    });
    expect(getPrinciple(c.store.db, second)).toMatchObject({
      state: 'current',
      supersedesId: first,
    });
    expect(
      listPrinciples(c.store.db, { projectId: c.project.id, history: true }).map((p) => p.id),
    ).toEqual(expect.arrayContaining([first, second]));
    expect(findRecords(c.store.db, c.project.id, 'sleep', 10).map((r) => r.id)).toEqual([second]);
  });

  it('answers the replaced principle superseded from GET knowledge with history on, and leaves it out without', async () => {
    const m = c.say();
    propose({ records: [principleOf(m, 'first', { topicKey: 'tests.sleep' })] });
    const first = must(converted('first').results[0]?.principleId, 'the first principle');
    propose({
      records: [
        principleOf(m, 'first', { topicKey: 'tests.sleep' }),
        principleOf(m, 'second', { topicKey: 'tests.sleep', statement: 'Wait on a condition' }),
      ],
    });
    const second = must(converted('second').results[0]?.principleId, 'the second principle');

    // The real route over the real knowledge services, on the store Convert wrote to.
    const token = 'convert-test-token';
    const api = createApp({
      onUnexpectedError: (error) => {
        throw error;
      },
      startedAt: new Date('2026-11-03T12:00:00.000Z'),
      allowedOrigins: [],
      token,
      services: createKnowledgeServices({
        state: createStateStore(c.store, createEventBus()),
        searchAvailable: true,
      }) as unknown as ApiServices,
      upgradeWebSocket: defineWebSocketHelper(() => new Response(null, { status: 426 })),
      mcp: () => Promise.resolve(new Response('mcp')),
      builderMcp: () => Promise.resolve(new Response('builder')),
    });
    const get = async (query: string) => {
      const res = await api.request(`/projects/${c.project.id}/knowledge${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      return KnowledgeListDto.parse(await res.json());
    };

    const withHistory = await get('?history=1');
    expect(withHistory.items.map((i) => [i.id, i.state])).toEqual(
      expect.arrayContaining([
        [first, 'superseded'],
        [second, 'current'],
      ]),
    );
    expect((await get('')).items.map((i) => i.id)).toEqual([second]);
  });

  it('answers the same results again without writing a second principle', () => {
    const m = c.say();
    propose({ records: [principleOf(m, 'no-sleeps')] });
    const first = converted('no-sleeps');
    const again = converted('no-sleeps');
    expect(again.createdNow).toBe(0);
    expect(again.results).toEqual(first.results);
    expect(listPrinciples(c.store.db, { projectId: c.project.id, history: true })).toHaveLength(1);
  });

  it('refuses an area principle for an area the project does not have, writing nothing', () => {
    const m = c.say();
    propose({ records: [principleOf(m, 'nowhere', { scope: 'area', area: 'billing' })] });
    const out = convert('nowhere');
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/nowhere.*no area named billing/),
    ]);
    expect(listPrinciples(c.store.db, { projectId: c.project.id, history: true })).toEqual([]);
  });
});

describe('question records', () => {
  const questionOf = (m: string, key: string, extra: Record<string, unknown> = {}) => ({
    key,
    text: 'Who pays for the extra seats?',
    for: 'finance',
    sourceMessageIds: [m],
    ...extra,
  });

  it('stores the question under the task it is about, linked to its proposal, and sends nothing', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'seats')],
      questions: [questionOf(m, 'who-pays', { about: 'seats' })],
    });
    const out = converted('seats', 'who-pays');
    const task = taskTitled('Task seats');
    const [question] = listShapeQuestions(c.store.db, c.shape.id);
    expect(question).toMatchObject({
      key: 'who-pays',
      text: 'Who pays for the extra seats?',
      forWho: 'finance',
      sourceMessageIds: [m],
      taskId: task.id,
      goalId: null,
    });
    expect(out.results.find((r) => r.key === 'who-pays')?.questionId).toBe(question?.id);
    expect(
      listShapeLinks(c.store.db, c.shape.id).find((l) => l.questionId === question?.id),
    ).toMatchObject({ key: 'who-pays', taskId: null });
    expect(listInbox(c.store.db, { projectId: c.project.id })).toEqual([]);
  });

  it('stores a question about a goal, and a question about nothing', () => {
    const m = c.say();
    propose({
      goals: [goalOf(m, 'density', ['d1'])],
      questions: [questionOf(m, 'q-goal', { about: 'density' }), questionOf(m, 'q-free')],
    });
    const out = converted('density', 'q-goal', 'q-free');
    const goalId = must(out.results.find((r) => r.key === 'density')?.goalId, 'the goal');
    const stored = listShapeQuestions(c.store.db, c.shape.id);
    expect(stored.find((q) => q.key === 'q-goal')).toMatchObject({ goalId, taskId: null });
    expect(stored.find((q) => q.key === 'q-free')).toMatchObject({ goalId: null, taskId: null });
  });

  it('refuses a question about a task that is not selected, naming it', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'seats')],
      questions: [questionOf(m, 'who-pays', { about: 'seats' })],
    });
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/who-pays is about Task seats, which isn't selected/),
    ]);
    expect(listShapeQuestions(c.store.db, c.shape.id)).toEqual([]);
  });

  // A stored proposal that is not a live goal or task cannot hold a question.
  const askAbout = (m: string, about: string, draft: Record<string, unknown> = {}) =>
    write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({ ...draft, questions: [questionOf(m, 'who-pays', { about })] }),
      ),
    );

  it.each([
    ['a decision', 'rule'],
    ['a principle', 'habit'],
    ['another question', 'first-q'],
  ])('refuses to propose a question about %s', (_, about) => {
    const m = c.say();
    propose({
      records: [decisionOf(m, 'rule'), principleOf(m, 'habit')],
      questions: [questionOf(m, 'first-q')],
    });
    const out = askAbout(m, about);
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(new RegExp(`Question 1, about: ${about} is not a goal or task`)),
    ]);
  });

  it.each([
    ['goal', 'g', (m: string) => ({ goals: [goalOf(m, 'g', ['g1'])] })],
    ['task', 't', (m: string) => ({ looseTasks: [loose(m, 't')] })],
  ])('refuses to propose a question about a dropped %s', (_, about, draftOf) => {
    const m = c.say();
    propose(draftOf(m));
    write((ctx) => {
      dropProposal(ctx, rowOf(about).id);
    });
    const out = askAbout(m, about);
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(new RegExp(`Question 1, about: ${about} is not a goal or task`)),
    ]);
  });

  it('refuses to propose a question about a task inside a dropped goal, naming what is wrong', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])] });
    write((ctx) => {
      dropProposal(ctx, rowOf('g').id);
    });
    const out = askAbout(m, 'g1');
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/Question 1, about: g1 is not a goal or task/),
    ]);
  });

  // A round replaces every unpinned pending row its draft leaves out, so those rows will be gone.
  it.each([
    ['goal', 'g', (m: string) => ({ goals: [goalOf(m, 'g', ['g1'])] })],
    ['task', 't', (m: string) => ({ looseTasks: [loose(m, 't')] })],
  ])('refuses to propose a question about a %s the draft leaves out', (_, about, draftOf) => {
    const m = c.say();
    propose(draftOf(m));
    const out = askAbout(m, about);
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(new RegExp(`Question 1, about: ${about} is not a goal or task`)),
    ]);
    expect(rowOf(about).state).toBe(ShapeProposalState.Pending);
  });

  it.each([
    ['a pinned goal', 'g', 'g'],
    ['a task inside a pinned goal', 'g', 'g1'],
    ['a pinned task', 't', 't'],
  ])('takes a question about %s the draft leaves out', (_, pinned, about) => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])], looseTasks: [loose(m, 't')] });
    write((ctx) => {
      editProposal(ctx, rowOf(pinned).id, { title: 'Pinned title' });
    });
    expect(askAbout(m, about)).toMatchObject({ ok: true });
    expect(rowOf(pinned).state).toBe(ShapeProposalState.Pending);
    converted(pinned, 'who-pays');
    expect(listShapeQuestions(c.store.db, c.shape.id).map((q) => q.key)).toEqual(['who-pays']);
  });

  // A restated goal keeps the draft's tasks, whatever is pinned on the goal itself.
  it('refuses to propose a question about a task a pinned goal loses when restated', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1', 'g2'])] });
    write((ctx) => {
      editProposal(ctx, rowOf('g').id, { title: 'Pinned title' });
    });
    const out = askAbout(m, 'g1', { goals: [goalOf(m, 'g', ['g2'])] });
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/Question 1, about: g1 is not a goal or task/),
    ]);
  });

  it.each<[string, (ctx: WriteContext) => void]>([
    [
      'its own pin',
      (ctx) => {
        editProposal(ctx, rowOf('g').id, { 'tasks.g1.title': 'Pinned task' });
      },
    ],
    [
      'the pin on the whole goal',
      (ctx) => {
        restoreProposal(ctx, rowOf('g').id);
      },
    ],
  ])('takes a question about a task a restated goal keeps by %s', (_, pin) => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1', 'g2'])] });
    write(pin);
    expect(askAbout(m, 'g1', { goals: [goalOf(m, 'g', ['g2'])] })).toMatchObject({ ok: true });
    converted('g', 'who-pays');
    expect(listShapeQuestions(c.store.db, c.shape.id).map((q) => q.key)).toEqual(['who-pays']);
  });

  it('takes a question about a goal or a task already converted', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])] });
    converted('g');
    expect(askAbout(m, 'g')).toMatchObject({ ok: true });
    expect(askAbout(m, 'g1')).toMatchObject({ ok: true });
  });

  it('says why Convert refuses a question about a task inside a goal that was dropped', () => {
    const m = c.say();
    propose({
      goals: [goalOf(m, 'g', ['g1'])],
      questions: [questionOf(m, 'who-pays', { about: 'g1' })],
    });
    write((ctx) => {
      dropProposal(ctx, rowOf('g').id);
    });
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      'who-pays is about g1, whose goal g was dropped, so it cannot hold a question',
    ]);
  });

  it('says why Convert refuses a question about a task inside a goal a later plan replaced', () => {
    const m = c.say();
    propose({
      goals: [goalOf(m, 'g', ['g1'])],
      questions: [questionOf(m, 'who-pays', { about: 'g1' })],
    });
    // The pin keeps the question through the round that replaces its goal.
    write((ctx) => {
      editProposal(ctx, rowOf('who-pays').id, { text: 'Who pays now?' });
    });
    propose({ looseTasks: [loose(m, 'next')] });
    expect(rowOf('g').state).toBe(ShapeProposalState.Superseded);
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      'who-pays is about g1, whose goal g was replaced by a later plan, so it cannot hold a question',
    ]);
  });

  it('says why Convert refuses a question about a goal that was dropped', () => {
    const m = c.say();
    propose({
      goals: [goalOf(m, 'g', ['g1'])],
      questions: [questionOf(m, 'who-pays', { about: 'g' })],
    });
    write((ctx) => {
      dropProposal(ctx, rowOf('g').id);
    });
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      'who-pays is about g, which was dropped, so it cannot hold a question',
    ]);
  });

  it('says why Convert refuses a question about a proposal that is not a goal or task', () => {
    const m = c.say();
    propose({
      records: [decisionOf(m, 'rule')],
      questions: [questionOf(m, 'who-pays')],
    });
    const question = rowOf('who-pays');
    write((ctx) => {
      patchShapeProposal(ctx, question.id, {
        body: { ...(question.body as object), about: 'rule' },
      });
    });
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      'who-pays is about rule, which is a decision, not a goal or task',
    ]);
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

  it('refuses by name a pending addition whose goal Remove Draft Goal took back, and writes nothing', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])] });
    const goalId = must(converted('g').results[0]?.goalId, 'the goal');
    const m2 = c.say('Add one.');
    propose({
      goals: [goalOf(m, 'g', ['g1'])],
      additions: [{ ...loose(m2, 'g3'), goalId }],
    });
    write((ctx) => {
      removeDraftGoalOf(ctx, c.shape.id, goalId);
    });
    const before = tasks().length;
    const out = convert('g3');
    expect(out.ok ? [] : out.errors).toEqual([
      `g3 is added to goal ${goalId}, which no longer exists: state it again against the goal's current id, or drop it`,
    ]);
    expect(tasks().length).toBe(before);
    expect(rowOf('g3').state).toBe(ShapeProposalState.Pending);
  });

  it('names the addition and writes nothing when one selected addition lost its goal beside others that did not', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1']), goalOf(m, 'h', ['h1'])] });
    const out0 = converted('g', 'h');
    const gId = must(out0.results.find((r) => r.key === 'g')?.goalId, 'goal g');
    const hId = must(out0.results.find((r) => r.key === 'h')?.goalId, 'goal h');
    const m2 = c.say('Add two.');
    propose({
      goals: [goalOf(m, 'g', ['g1']), goalOf(m, 'h', ['h1'])],
      additions: [
        { ...loose(m2, 'to-g'), goalId: gId },
        { ...loose(m2, 'to-h'), goalId: hId },
      ],
    });
    write((ctx) => {
      removeDraftGoalOf(ctx, c.shape.id, gId);
    });
    const before = tasks().length;
    const out = convert('to-g', 'to-h');
    expect(out.ok ? [] : out.errors).toEqual([
      `to-g is added to goal ${gId}, which no longer exists: state it again against the goal's current id, or drop it`,
    ]);
    expect(tasks().length).toBe(before);
  });

  it('leaves no question attached to a task a removal cancels, and keeps it stored', () => {
    const m = c.say();
    propose({
      looseTasks: [loose(m, 'seats')],
      questions: [
        {
          key: 'who-pays',
          text: 'Who pays for the extra seats?',
          for: 'finance',
          about: 'seats',
          sourceMessageIds: [m],
        },
      ],
    });
    converted('seats', 'who-pays');
    const task = taskTitled('Task seats');
    expect(listShapeQuestions(c.store.db, c.shape.id)[0]?.taskId).toBe(task.id);

    const m2 = c.say('Drop it.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m2] }] });
    converted(`remove:${task.id}`);

    expect(getTask(c.store.db, task.id).status).toBe(TaskStatus.Cancelled);
    expect(listShapeQuestions(c.store.db, c.shape.id)).toMatchObject([
      { key: 'who-pays', taskId: null, goalId: null },
    ]);
    expect(rowOf('who-pays').state).toBe(ShapeProposalState.Accepted);
  });

  it('refuses to propose a question about a task a converted removal cancelled', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'seats')] });
    converted('seats');
    const task = taskTitled('Task seats');
    const m2 = c.say('Drop it.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m2] }] });
    converted(`remove:${task.id}`);

    const m3 = c.say('Who pays for it?');
    const out = write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          questions: [
            {
              key: 'who-pays',
              text: 'Who pays for the extra seats?',
              for: 'finance',
              about: 'seats',
              sourceMessageIds: [m3],
            },
          ],
        }),
      ),
    );
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/Question 1, about: seats was removed/),
    ]);
  });

  describe('a task the single-task Remove action cancelled', () => {
    /** A converted task cancelled and detached as the daemon's removeTask does, with no remove_task proposal. */
    const removedByAction = () => {
      const m = c.say();
      propose({ looseTasks: [loose(m, 'seats')] });
      converted('seats');
      const task = taskTitled('Task seats');
      write((ctx) => {
        cancelTask(ctx, task.id);
      });
      return task;
    };

    it('refuses to propose a question about it, saying it was removed', () => {
      removedByAction();
      const m2 = c.say('Who pays for it?');
      const out = write((ctx) =>
        reconcileDraft(ctx, c.shape.id, PlanDraft.parse({ questions: [whoPays(m2, 'seats')] })),
      );
      expect(out.ok ? [] : out.errors).toEqual([
        expect.stringMatching(/Question 1, about: seats was removed/),
      ]);
    });

    it('refuses Convert of a question pending about it, and stores nothing against the cancelled task', () => {
      const m = c.say();
      propose({ looseTasks: [loose(m, 'seats')] });
      converted('seats');
      const task = taskTitled('Task seats');
      const m2 = c.say('Who pays?');
      propose({ questions: [whoPays(m2, 'seats')] });
      write((ctx) => {
        editProposal(ctx, rowOf('who-pays').id, { text: 'Who pays now?' });
      });
      write((ctx) => {
        cancelTask(ctx, task.id);
      });
      const out = convert('who-pays');
      expect(out.ok ? [] : out.errors).toEqual([
        expect.stringMatching(/who-pays is about seats, which was removed/),
      ]);
      expect(listShapeQuestions(c.store.db, c.shape.id)).toEqual([]);
    });

    /** Goal g's task g1, converted and cancelled by the Remove action, with no remove_task proposal. */
    const removedGoalTaskByAction = () => {
      const m = c.say();
      propose({ goals: [goalOf(m, 'g', ['g1'])] });
      converted('g');
      const task = taskTitled('Task g1');
      write((ctx) => {
        cancelTask(ctx, task.id);
      });
      return task;
    };

    it('takes a question about the key a selected pending task reuses, on the new task, not the cancelled one', () => {
      const removed = removedGoalTaskByAction();
      const m = c.say('Bring it back, and who pays?');
      propose({ looseTasks: [loose(m, 'g1')], questions: [whoPays(m, 'g1')] });

      converted('g1', 'who-pays');
      const [stored] = listShapeQuestions(c.store.db, c.shape.id);
      const made = must(
        tasks().find((t) => t.title === 'Task g1' && t.id !== removed.id),
        'the new task',
      );
      expect(stored).toMatchObject({ key: 'who-pays', taskId: made.id });
      expect(stored?.taskId).not.toBe(removed.id);
      expect(rowOf('who-pays').state).toBe(ShapeProposalState.Accepted);
    });

    it('takes a question about the key a goal reuses, on the goal, not the cancelled task', () => {
      const removed = removedGoalTaskByAction();
      const m = c.say('A goal for it, and who pays?');
      propose({ goals: [goalOf(m, 'g1', ['g2'])], questions: [whoPays(m, 'g1')] });

      const out = converted('g1', 'who-pays');
      const goalId = must(out.results.find((r) => r.key === 'g1')?.goalId, 'the goal');
      const stored = listShapeQuestions(c.store.db, c.shape.id);
      expect(stored).toMatchObject([{ key: 'who-pays', goalId, taskId: null }]);
      expect(stored.some((q) => q.taskId === removed.id)).toBe(false);
      expect(rowOf('who-pays').state).toBe(ShapeProposalState.Accepted);
    });
  });

  const whoPays = (m: string, about: string) => ({
    key: 'who-pays',
    text: 'Who pays for the extra seats?',
    for: 'finance',
    about,
    sourceMessageIds: [m],
  });
  /** A converted task, with a pinned question about it and its removal both pending. */
  const removalBesideQuestion = () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'seats')] });
    converted('seats');
    const task = taskTitled('Task seats');
    const m2 = c.say('Who pays?');
    propose({ questions: [whoPays(m2, 'seats')] });
    write((ctx) => {
      editProposal(ctx, rowOf('who-pays').id, { text: 'Who pays now?' });
    });
    const m3 = c.say('Drop it.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m3] }] });
    return task;
  };

  it('refuses Convert of a question about a task a converted removal cancelled, saying it was removed', () => {
    const task = removalBesideQuestion();
    converted(`remove:${task.id}`);
    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/who-pays is about seats, which was removed/),
    ]);
    expect(listShapeQuestions(c.store.db, c.shape.id)).toEqual([]);
    expect(rowOf('who-pays').state).toBe(ShapeProposalState.Pending);
  });

  it('refuses a question about a task whose removal converts in the same call', () => {
    const task = removalBesideQuestion();
    const out = convert(`remove:${task.id}`, 'who-pays');
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/who-pays is about seats, which was removed/),
    ]);
    expect(getTask(c.store.db, task.id).status).not.toBe(TaskStatus.Cancelled);
    expect(listShapeQuestions(c.store.db, c.shape.id)).toEqual([]);
  });

  it('refuses at propose a question about a task the same draft removes', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'seats')] });
    converted('seats');
    const task = taskTitled('Task seats');
    const m2 = c.say('Drop it, and who pays?');
    const out = write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m2] }],
          questions: [whoPays(m2, 'seats')],
        }),
      ),
    );
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/Question 1, about: seats was removed/),
    ]);
  });

  /** A converted task seats, a pinned task `after` waiting on it and a pinned landing of it, and seats' removal pending. */
  const removalBesideDependents = () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'seats'), loose(m, 'other')] });
    converted('seats', 'other');
    const task = taskTitled('Task seats');
    const m2 = c.say('Then this.');
    propose({
      looseTasks: [loose(m2, 'after', { dependsOn: ['seats'] })],
      landings: [{ key: 'l1', title: 'Seats', keys: ['seats', 'other'], sourceMessageIds: [m2] }],
    });
    write((ctx) => {
      editProposal(ctx, rowOf('after').id, { title: 'After seats' });
      editProposal(ctx, rowOf('l1').id, { title: 'Seats together' });
    });
    const m3 = c.say('Drop seats.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m3] }] });
    return task;
  };

  it('refuses Convert of a task depending on, and a landing including, a task a removal cancelled', () => {
    const task = removalBesideDependents();
    converted(`remove:${task.id}`);
    const out = convert('after', 'l1');
    expect(out.ok ? [] : out.errors).toEqual([
      'After seats depends on seats, which was removed, so nothing can depend on it',
      'Seats together includes seats, which was removed, so it cannot be in a landing',
    ]);
    expect(rowOf('after').state).toBe(ShapeProposalState.Pending);
  });

  it('refuses a landing of a task whose removal converts in the same call', () => {
    const task = removalBesideDependents();
    const out = convert(`remove:${task.id}`, 'l1');
    expect(out.ok ? [] : out.errors).toEqual([
      'Seats together includes seats, which was removed, so it cannot be in a landing',
    ]);
    expect(getTask(c.store.db, task.id).status).not.toBe(TaskStatus.Cancelled);
  });

  it('refuses at propose a task depending on, and a landing including, a task a removal cancelled', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'seats')] });
    converted('seats');
    const task = taskTitled('Task seats');
    const m2 = c.say('Drop it.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m2] }] });
    converted(`remove:${task.id}`);

    const m3 = c.say('Something after it.');
    const out = write((ctx) =>
      reconcileDraft(
        ctx,
        c.shape.id,
        PlanDraft.parse({
          looseTasks: [loose(m3, 'after', { dependsOn: ['seats'] })],
          landings: [{ key: 'l1', title: 'Seats', keys: ['seats'], sourceMessageIds: [m3] }],
        }),
      ),
    );
    expect(out.ok ? [] : out.errors).toEqual([
      expect.stringMatching(/Loose task 1, depends on: seats was removed/),
      expect.stringMatching(/Landing 1, keys: seats was removed/),
    ]);
  });

  /** Goal g's task g1, converted and removed, so a later round can take the key g1 again. */
  const removedGoalTask = () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])] });
    converted('g');
    const task = taskTitled('Task g1');
    const m2 = c.say('Drop it.');
    propose({ removals: [{ taskId: task.id, why: 'Not needed', sourceMessageIds: [m2] }] });
    converted(`remove:${task.id}`);
    return task;
  };

  it('holds a question about a removed key to the new task, which must be selected', () => {
    const removed = removedGoalTask();
    const m = c.say('Bring it back, and who pays?');
    propose({ looseTasks: [loose(m, 'g1')], questions: [whoPays(m, 'g1')] });

    const out = convert('who-pays');
    expect(out.ok ? [] : out.errors).toEqual(["who-pays is about Task g1, which isn't selected"]);
    expect(listShapeQuestions(c.store.db, c.shape.id)).toEqual([]);

    converted('g1', 'who-pays');
    const [stored] = listShapeQuestions(c.store.db, c.shape.id);
    expect(stored?.taskId).toEqual(expect.any(String));
    expect(stored?.taskId).not.toBe(removed.id);
  });

  it('keeps a pinned task under a removed key when the draft restates only its question', () => {
    removedGoalTask();
    const m = c.say('Bring it back.');
    propose({ looseTasks: [loose(m, 'g1')] });
    write((ctx) => {
      editProposal(ctx, rowOf('g1').id, { title: 'Pinned task' });
    });
    const m2 = c.say('Who pays?');
    propose({ questions: [whoPays(m2, 'g1')] });
    expect(rowOf('g1').state).toBe(ShapeProposalState.Pending);
    expect(rowOf('who-pays').state).toBe(ShapeProposalState.Pending);
  });

  it('lets a task wait on a removed key a pending task took again, once that task is selected', () => {
    const removed = removedGoalTask();
    const m = c.say('Bring it back, and something after it.');
    propose({ looseTasks: [loose(m, 'g1'), loose(m, 'after', { dependsOn: ['g1'] })] });

    const out = convert('after');
    expect(out.ok ? [] : out.errors).toEqual([
      "Task after depends on Task g1, which isn't selected",
    ]);

    converted('g1', 'after');
    const g1 = tasks().find((t) => t.title === 'Task g1' && t.id !== removed.id);
    expect(taskTitled('Task after').dependsOn).toEqual([g1?.id]);
  });

  it('puts a landing of a removed key a pending task took again on that task, once it is selected', () => {
    const removed = removedGoalTask();
    const m = c.say('Bring it back, and land it.');
    propose({
      looseTasks: [loose(m, 'g1')],
      landings: [{ key: 'l1', title: 'Back again', keys: ['g1'], sourceMessageIds: [m] }],
    });

    const out = convert('l1');
    expect(out.ok ? [] : out.errors).toEqual(["Back again includes Task g1, which isn't selected"]);

    const landing = converted('g1', 'l1').results.find((r) => r.key === 'l1');
    const g1 = must(
      tasks().find((t) => t.title === 'Task g1' && t.id !== removed.id),
      'the new task',
    );
    expect(landing?.taskIds).toEqual([g1.id]);
    expect(g1.landingGroupId).toEqual(expect.any(String));
    expect(getTask(c.store.db, removed.id).landingGroupId ?? null).toBeNull();
  });

  describe('a removed key only a goal holds again', () => {
    const refusals = (m: string): string[] => {
      const out = write((ctx) =>
        reconcileDraft(
          ctx,
          c.shape.id,
          PlanDraft.parse({
            looseTasks: [loose(m, 'after', { dependsOn: ['g1'] })],
            landings: [{ key: 'l1', title: 'Goal', keys: ['g1'], sourceMessageIds: [m] }],
          }),
        ),
      );
      return out.ok ? [] : [...out.errors];
    };
    const removedKeyRefusals = [
      expect.stringMatching(/Loose task 1, depends on: g1 was removed/),
      expect.stringMatching(/Landing 1, keys: g1 was removed/),
    ];

    it('is refused at propose when a converted goal holds it', () => {
      removedGoalTask();
      const m = c.say('A goal for it.');
      propose({ goals: [goalOf(m, 'g1', ['g2'])] });
      converted('g1');
      expect(refusals(c.say('Something after it.'))).toEqual(removedKeyRefusals);
    });

    it('is refused at propose when a pinned pending goal holds it', () => {
      removedGoalTask();
      const m = c.say('A goal for it.');
      propose({ goals: [goalOf(m, 'g1', ['g2'])] });
      write((ctx) => {
        editProposal(ctx, rowOf('g1').id, { title: 'Pinned goal' });
      });
      expect(refusals(c.say('Something after it.'))).toEqual(removedKeyRefusals);
    });
  });

  it('converts a goal whose task takes a removed task’s key, as a new task', () => {
    const removed = removedGoalTask();
    const m = c.say('A goal that reuses g1.');
    propose({ goals: [goalOf(m, 'h', ['g1', 'g2'])] });

    const out = converted('h');
    const made = tasks().filter((t) => t.title === 'Task g1' && t.id !== removed.id);
    expect(made).toHaveLength(1);
    expect(out.results.find((r) => r.key === 'h')?.taskIds).toContain(made[0]?.id);
    expect(getTask(c.store.db, removed.id).status).toBe(TaskStatus.Cancelled);
  });

  describe('a goal whose task takes the key of a converted task that is still live', () => {
    it('is refused by name at propose when a converted loose task holds the key', () => {
      const m = c.say('A task.');
      propose({ looseTasks: [loose(m, 'a')] });
      converted('a');
      const m2 = c.say('A goal that reuses a.');
      expect(() => {
        propose({ goals: [goalOf(m2, 'h', ['a'])] });
      }).toThrow(/Goal h, task 1, key: a is a task this conversation already converted/);
      expect(tasks().filter((t) => t.title === 'Task a')).toHaveLength(1);
    });

    it('is refused by name at propose when a converted goal’s task holds the key', () => {
      const m = c.say();
      propose({ goals: [goalOf(m, 'g', ['g1'])] });
      converted('g');
      const m2 = c.say('Another goal that reuses g1.');
      expect(() => {
        propose({ goals: [goalOf(m2, 'h', ['g1'])] });
      }).toThrow(/Goal h, task 1, key: g1 is a task this conversation already converted/);
    });

    it('is refused by name at Convert, not thrown, while the removal that frees the key is not selected', () => {
      const m = c.say();
      propose({ goals: [goalOf(m, 'g', ['g1'])] });
      converted('g');
      const old = taskTitled('Task g1');
      const m2 = c.say('Drop g1, and a goal that reuses it.');
      propose({
        goals: [goalOf(m2, 'h', ['g1'])],
        removals: [{ taskId: old.id, why: 'Not needed', sourceMessageIds: [m2] }],
      });

      const out = convert('h');
      expect(out.ok ? [] : out.errors).toEqual([
        expect.stringMatching(/h: its task g1 takes the key of a task this conversation converted/),
      ]);
      expect(tasks().filter((t) => t.title === 'Task g1')).toEqual([
        expect.objectContaining({ id: old.id }),
      ]);

      converted('h', `remove:${old.id}`);
      const made = tasks().filter((t) => t.title === 'Task g1' && t.id !== old.id);
      expect(made).toHaveLength(1);
      expect(getTask(c.store.db, old.id).status).toBe(TaskStatus.Cancelled);
    });
  });

  it('resolves a task that waits on a removed key a goal took again to the goal’s new task', () => {
    const removed = removedGoalTask();
    const m = c.say('A goal that reuses g1, and a task after it.');
    propose({
      goals: [goalOf(m, 'h', ['g1'])],
      looseTasks: [loose(m, 'after', { dependsOn: ['g1'] })],
    });

    converted('h', 'after');
    const g1 = must(
      tasks().find((t) => t.title === 'Task g1' && t.id !== removed.id),
      'the new task',
    );
    expect(taskTitled('Task after').dependsOn).toEqual([g1.id]);
  });

  it('puts a question on a goal that took a removed task’s key, not on the cancelled task', () => {
    removedGoalTask();
    const m = c.say('A goal for it, and who pays?');
    propose({ goals: [goalOf(m, 'g1', ['g2'])], questions: [whoPays(m, 'g1')] });

    const out = converted('g1', 'who-pays');
    const goalId = must(out.results.find((r) => r.key === 'g1')?.goalId, 'the goal');
    expect(listShapeQuestions(c.store.db, c.shape.id)).toMatchObject([{ goalId, taskId: null }]);
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

// Task placement spec P2: the rule runs when a task is made and when its areas are edited, whichever
// door the task comes through, so Convert places what it makes and what it changes.
describe('placement', () => {
  beforeEach(() => {
    write((ctx) => patchProject(ctx, c.project.id, { delivery: 'pull_request' }));
  });

  it('puts a loose task with an isolated area in a separate copy, with a reason', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a', { areas: ['migrations'] }), loose(m, 'b')] });
    converted('a', 'b');
    expect(taskTitled('Task a')).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'touches migrations',
    });
    expect(taskTitled('Task b')).toMatchObject({ workspaceMode: 'shared', placementReason: null });
  });

  it("puts a goal's task with an isolated area in a separate copy, with a reason", () => {
    const m = c.say();
    propose({
      goals: [
        goalOf(m, 'g', ['g1', 'g2'], {
          tasks: [
            { key: 'g1', title: 'Lock', areas: ['deps'], size: 'S' },
            { key: 'g2', title: 'Plain', areas: ['api'], size: 'S' },
          ],
        }),
      ],
    });
    converted('g');
    expect(taskTitled('Lock')).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'touches deps',
    });
    expect(taskTitled('Plain')).toMatchObject({ workspaceMode: 'shared', placementReason: null });
  });

  it('leaves a task shared in a project with local delivery', () => {
    write((ctx) => patchProject(ctx, c.project.id, { delivery: 'local' }));
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a', { areas: ['migrations'] })] });
    converted('a');
    expect(taskTitled('Task a')).toMatchObject({ workspaceMode: 'shared', placementReason: null });
  });

  it('moves an unstarted task to a separate copy when a change adds an isolated area', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')] });
    converted('a');
    const id = taskTitled('Task a').id;
    expect(getTask(c.store.db, id)).toMatchObject({ workspaceMode: 'shared' });
    const m2 = c.say('It touches the lockfile.');
    propose({ changes: [{ taskId: id, areas: ['api', 'deps'], sourceMessageIds: [m2] }] });
    converted(`change:${id}`);
    expect(getTask(c.store.db, id)).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'touches deps',
    });
  });

  it('leaves a task the builder placed where the builder put it', () => {
    const m = c.say();
    propose({ looseTasks: [loose(m, 'a')] });
    converted('a');
    const id = taskTitled('Task a').id;
    write((ctx) => patchTask(ctx, id, { workspaceMode: 'shared' }));
    const m2 = c.say('It touches the lockfile.');
    propose({ changes: [{ taskId: id, areas: ['deps'], sourceMessageIds: [m2] }] });
    converted(`change:${id}`);
    expect(getTask(c.store.db, id)).toMatchObject({
      workspaceMode: 'shared',
      placementReason: 'chosen by the builder',
    });
  });

  it('puts a task added to a converted goal in a separate copy, with a reason', () => {
    const m = c.say();
    propose({ goals: [goalOf(m, 'g', ['g1'])] });
    const goalId = must(converted('g').results[0]?.goalId, 'the goal id');
    const m2 = c.say('One more, for the schema.');
    propose({
      additions: [loose(m2, 'extra', { areas: ['migrations'], goalId })],
    });
    converted('extra');
    expect(taskTitled('Task extra')).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: 'touches migrations',
    });
  });

  // Task placement spec P3: a join still pending has not written, so its task's placement can't move.
  describe('while a join of the task is pending', () => {
    /** A converted task, and a pending change of the given fields to it. */
    const changing = (fields: Record<string, unknown>) => {
      const m = c.say();
      propose({ looseTasks: [loose(m, 'a')] });
      converted('a');
      const id = taskTitled('Task a').id;
      const m2 = c.say('It touches the lockfile.');
      propose({ changes: [{ taskId: id, ...fields, sourceMessageIds: [m2] }] });
      return id;
    };
    const convertWhileJoining = (id: TaskId) =>
      write((ctx) =>
        convertProposals(ctx, c.shape.id, [rowOf(`change:${id}`).id], (task) =>
          task === id ? 'Task a is joining a batch' : null,
        ),
      );

    it("refuses a change of the task's areas and writes nothing", () => {
      const id = changing({ areas: ['api', 'deps'], title: 'Renamed' });
      expect(convertWhileJoining(id)).toEqual({
        ok: false,
        errors: [`change:${id}: Task a is joining a batch`],
      });
      expect(getTask(c.store.db, id)).toMatchObject({
        title: 'Task a',
        areas: ['api'],
        workspaceMode: 'shared',
        placementReason: null,
      });
      expect(rowOf(`change:${id}`).state).toBe(ShapeProposalState.Pending);
    });

    it('allows a change that leaves the areas alone', () => {
      const id = changing({ title: 'Renamed' });
      expect(convertWhileJoining(id).ok).toBe(true);
      expect(getTask(c.store.db, id).title).toBe('Renamed');
    });
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
