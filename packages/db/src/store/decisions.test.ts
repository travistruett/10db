import type { DecisionId, ProjectId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getDecisionDto,
  insertDecision,
  listDecisions,
  supersedeDecision,
  withdrawDecision,
  type NewDecision,
} from './decisions';
import { insertSource } from './knowledge';
import {
  checkKnowledgeIndex,
  findRecords,
  rebuildKnowledgeIndex,
  searchDecisionIds,
  searchDecisions,
} from './knowledge-search';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const decision = (projectId: ProjectId | null, overrides: Partial<NewDecision> = {}): NewDecision =>
  store.write((ctx) => ({
    projectId,
    question: 'Which queue library?',
    choice: 'BullMQ',
    rationale: 'Redis is already deployed',
    decidedBy: 'me',
    scope: projectId === null ? ('you' as const) : ('project' as const),
    area: null,
    sourceId: insertSource(ctx, 'builder', {}),
    ...overrides,
  })).value;

const record = (projectId: ProjectId | null, overrides: Partial<NewDecision> = {}): DecisionId =>
  store.write((ctx) => insertDecision(ctx, decision(projectId, overrides))).value;

const supersede = (id: DecisionId, projectId: ProjectId, choice: string): DecisionId =>
  store.write((ctx) => supersedeDecision(ctx, id, decision(projectId, { choice }))).value;

const found = (projectId: ProjectId, query: string) =>
  searchDecisions(store.db, projectId, query, 10).map((d) => d.choice);

const history = (projectId: ProjectId, query: string) =>
  searchDecisionIds(store.db, { projectId, query, limit: 10, history: true });

describe('decisions with derived state', () => {
  it('reads a recorded decision back through search, current and newest first', () => {
    const project = seedProject(store);
    const first = record(project.id);
    const second = record(project.id, { question: 'Which queue for jobs?', choice: 'pg-boss' });
    expect(found(project.id, 'queue')).toEqual(expect.arrayContaining(['BullMQ', 'pg-boss']));
    expect(listDecisions(store.db, { projectId: project.id }).map((d) => d.id)).toEqual([
      second,
      first,
    ]);
    expect(getDecisionDto(store.db, first)).toMatchObject({
      state: 'current',
      supersededById: null,
      withdrawnAt: null,
      withdrawnBy: null,
    });
  });

  it('supersedes a current decision: search returns only the successor, history both, each labelled', () => {
    const project = seedProject(store);
    const old = record(project.id);
    const next = supersede(old, project.id, 'pg-boss');
    expect(found(project.id, 'queue')).toEqual(['pg-boss']);
    expect(getDecisionDto(store.db, old)).toMatchObject({
      state: 'superseded',
      supersededById: next,
    });
    expect(getDecisionDto(store.db, next)).toMatchObject({ state: 'current', supersedesId: old });
    expect(history(project.id, 'queue')).toEqual(expect.arrayContaining([old, next]));
    expect(history(project.id, 'queue')).toHaveLength(2);
    const labelled = listDecisions(store.db, {
      projectId: project.id,
      ids: history(project.id, 'queue'),
      history: true,
    });
    expect(labelled.map((d) => [d.choice, d.state]).sort()).toEqual([
      ['BullMQ', 'superseded'],
      ['pg-boss', 'current'],
    ]);
    expect(
      findRecords(store.db, project.id, 'queue', 10).flatMap((r) =>
        r.kind === 'decision' ? [r.choice] : [],
      ),
    ).toEqual(['pg-boss']);
  });

  it.each([
    { name: 'a superseded decision', setup: 'supersede' },
    { name: 'a withdrawn decision', setup: 'withdraw' },
  ] as const)('refuses to supersede $name', ({ setup }) => {
    const project = seedProject(store);
    const old = record(project.id);
    store.write((ctx) => {
      if (setup === 'supersede')
        supersedeDecision(ctx, old, decision(project.id, { choice: 'pg-boss' }));
      else withdrawDecision(ctx, old, { by: 'me', reason: 'wrong' });
    });
    const before = found(project.id, 'queue');
    expect(() =>
      store.write((ctx) => supersedeDecision(ctx, old, decision(project.id, { choice: 'x' }))),
    ).toThrow(/only a current decision/);
    expect(found(project.id, 'queue')).toEqual(before);
  });

  it('withdraws a decision as a tombstone that search skips but history keeps', () => {
    const project = seedProject(store);
    const id = record(project.id);
    store.write((ctx) => {
      withdrawDecision(ctx, id, { by: 'me', reason: 'recorded by mistake' });
    });
    expect(getDecisionDto(store.db, id)).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: 'recorded by mistake',
    });
    expect(found(project.id, 'queue')).toEqual([]);
    expect(listDecisions(store.db, { projectId: project.id })).toEqual([]);
    expect(history(project.id, 'queue')).toEqual([id]);
    expect(
      listDecisions(store.db, { projectId: project.id, history: true }).map((d) => d.id),
    ).toEqual([id]);
  });

  it('refuses to withdraw a decision with a live successor, naming the successor', () => {
    const project = seedProject(store);
    const old = record(project.id);
    const next = supersede(old, project.id, 'pg-boss');
    expect(() =>
      store.write((ctx) => {
        withdrawDecision(ctx, old, { by: 'me', reason: 'no longer true' });
      }),
    ).toThrow(new RegExp(next));
    expect(found(project.id, 'queue')).toEqual(['pg-boss']);
  });

  it('makes only the link before the head current when the head of a three-link chain is withdrawn', () => {
    const project = seedProject(store);
    const a = record(project.id);
    const b = supersede(a, project.id, 'pg-boss');
    const c = supersede(b, project.id, 'SQS');
    store.write((ctx) => {
      withdrawDecision(ctx, c, { by: 'me', reason: 'reverted' });
    });
    expect(found(project.id, 'queue')).toEqual(['pg-boss']);
    expect([a, b, c].map((id) => getDecisionDto(store.db, id).state)).toEqual([
      'superseded',
      'current',
      'withdrawn',
    ]);
  });

  it.each([
    { name: 'scope you', filter: { scope: 'you' as const }, expected: ['Conventional Commits'] },
    { name: 'scope project', filter: { scope: 'project' as const }, expected: ['Squash merges'] },
    { name: 'area api', filter: { scope: 'area' as const, area: 'api' }, expected: ['Hono'] },
    { name: 'area ui', filter: { scope: 'area' as const, area: 'ui' }, expected: [] },
  ])('filters the list by $name', ({ filter, expected }) => {
    const project = seedProject(store);
    record(null, { choice: 'Conventional Commits' });
    record(project.id, { choice: 'Squash merges' });
    record(project.id, { scope: 'area', area: 'api', choice: 'Hono' });
    expect(
      listDecisions(store.db, { projectId: project.id, ...filter }).map((d) => d.choice),
    ).toEqual(expected);
  });

  it('lists the decisions named by ids in that order', () => {
    const project = seedProject(store);
    const a = record(project.id, { choice: 'A' });
    const b = record(project.id, { choice: 'B' });
    expect(
      listDecisions(store.db, { projectId: project.id, ids: [a, b] }).map((d) => d.choice),
    ).toEqual(['A', 'B']);
    expect(listDecisions(store.db, { projectId: project.id, ids: [] })).toEqual([]);
  });

  it('never throws on hostile search text, and still finds what it names', () => {
    const project = seedProject(store);
    record(project.id, { question: "What's the deal with quotes?", choice: 'Escape them' });
    expect(() =>
      searchDecisions(store.db, project.id, `what's -the "deal" (NEAR OR`, 5),
    ).not.toThrow();
    expect(searchDecisions(store.db, project.id, `what's -the "deal" (quotes`, 5)).toHaveLength(1);
    expect(() => findRecords(store.db, project.id, `what's -the "deal" (NEAR OR`, 5)).not.toThrow();
    expect(searchDecisions(store.db, project.id, '***', 5)).toEqual([]);
  });

  it('finds a record from a partly typed word, and narrows as words are added', () => {
    const project = seedProject(store);
    record(project.id, { question: 'Do tests sleep?', choice: 'Never sleep', rationale: 'Flaky' });
    record(project.id, { question: 'Which queue library?', choice: 'BullMQ', rationale: 'Redis' });
    expect(found(project.id, 'slee')).toEqual(['Never sleep']);
    expect(found(project.id, 'tes slee')).toEqual(['Never sleep']);
    expect(found(project.id, 'slee queue')).toEqual([]);
    expect(found(project.id, 'eep')).toEqual([]);
    expect(findRecords(store.db, project.id, 'slee', 5).map((r) => r.id)).toHaveLength(1);
  });

  it('detects an index out of step with its table and rebuilds it', () => {
    const project = seedProject(store);
    expect(checkKnowledgeIndex(store.db)).toEqual([]);
    store.db.$client.exec('DROP TRIGGER decisions_fts_insert');
    record(project.id);
    expect(found(project.id, 'queue')).toEqual([]);
    expect(checkKnowledgeIndex(store.db)).toEqual(['decisions_fts']);
    rebuildKnowledgeIndex(store.db, 'decisions_fts');
    expect(checkKnowledgeIndex(store.db)).toEqual([]);
    expect(found(project.id, 'queue')).toEqual(['BullMQ']);
  });
});
