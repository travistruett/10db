import {
  KnowledgeListQuery,
  mintId,
  type DecisionWrite,
  type KnowledgeListDto,
  type KnowledgeSearchState,
  type PrincipleWrite,
  type ProjectDto,
} from '@10db/contracts';
import { createTestStore, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPrinciple,
  knowledgeList,
  recordDecision,
  supersedeDecisionRecord,
  supersedePrincipleRecord,
} from './records';

let store: Store;
let close: () => void;
let project: ProjectDto;
let other: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store, { name: 'demo', areas: [{ name: 'api', globs: ['src/api/**'] }] });
  other = seedProject(store, { name: 'other' });
});
afterEach(() => {
  close();
});

const available: KnowledgeSearchState = { available: true, message: null };
const list = (over: Record<string, string> = {}, search = available): KnowledgeListDto =>
  store.write((ctx) => knowledgeList(ctx.tx, project.id, KnowledgeListQuery.parse(over), search))
    .value;
const ids = (l: KnowledgeListDto) => l.items.map((i) => i.id);

const decide = (over: Partial<DecisionWrite> = {}, projectId = project.id) =>
  store.write((ctx) =>
    recordDecision(ctx, projectId, {
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'Redis is there',
      ...over,
    }),
  ).value;

const principle = (over: Partial<PrincipleWrite> = {}, projectId = project.id) =>
  store.write((ctx) =>
    createPrinciple(ctx, projectId, {
      statement: 'Never sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      ...over,
    }),
  ).value;

describe('the combined list', () => {
  it('returns decisions and principles together, builder-wide ones in every project', () => {
    const d = decide();
    const mine = decide({ scope: 'you', question: 'Which editor?', choice: 'vim' });
    const p = principle({ scope: 'you', topicKey: 'style.tabs', statement: 'Use tabs' });
    const theirs = decide({}, other.id);
    const result = list();
    expect(ids(result).toSorted()).toEqual([d.id, mine.id, p.id].toSorted());
    expect(result.items.find((i) => i.id === p.id)).toMatchObject({
      kind: 'principle',
      principleKind: 'policy',
      scope: 'you',
      area: null,
      state: 'current',
      statement: 'Use tabs',
      topicKey: 'style.tabs',
    });
    expect(result.items.find((i) => i.id === p.id)?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(result.items.find((i) => i.id === d.id)).toMatchObject({
      kind: 'decision',
      question: 'Which queue library?',
      choice: 'BullMQ',
      rationale: 'Redis is there',
      state: 'current',
    });
    expect(result).toMatchObject({ truncated: false, search: available });
    // another project sees the builder-wide ones and its own, none of this project's
    expect(
      store
        .write((ctx) => knowledgeList(ctx.tx, other.id, KnowledgeListQuery.parse({}), available))
        .value.items.map((i) => i.id)
        .toSorted(),
    ).toEqual([theirs.id, mine.id, p.id].toSorted());
  });

  it('searches both kinds by text, filters by kind, scope and area, and shows history on request', () => {
    const d = decide();
    const old = principle();
    const next = principle({ statement: 'Never sleep or poll in tests' });
    const areaRule = principle({
      scope: 'area',
      area: 'api',
      topicKey: 'api.validate',
      statement: 'Validate with zod',
      kind: 'heuristic',
    });
    expect(ids(list({ q: 'queue' }))).toEqual([d.id]);
    expect(ids(list({ q: 'sleep' }))).toEqual([next.id]);
    expect(ids(list({ q: 'sleep', history: '1' })).toSorted()).toEqual(
      [old.id, next.id].toSorted(),
    );
    expect(
      list({ q: 'sleep', history: '1' })
        .items.map((i) => i.state)
        .toSorted(),
    ).toEqual(['current', 'superseded']);
    expect(ids(list({ kind: 'decision' }))).toEqual([d.id]);
    expect(ids(list({ kind: 'heuristic' }))).toEqual([areaRule.id]);
    expect(ids(list({ kind: 'principle' })).toSorted()).toEqual([next.id, areaRule.id].toSorted());
    expect(ids(list({ scope: 'area', area: 'api' }))).toEqual([areaRule.id]);
    expect(ids(list({ area: 'api' }))).toEqual([areaRule.id]);
    expect(ids(list({ scope: 'you' }))).toEqual([]);
  });

  it('truncates at the limit and says so', () => {
    for (let i = 0; i < 3; i += 1) decide({ question: `Question ${String(i)}?` });
    const result = list({ limit: '2' });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('answers 400 naming an area the project lacks, and 404 for an unknown project', () => {
    expect(() => list({ area: 'billing' })).toThrow(/area: demo has no area named billing/);
    expect(() =>
      store.write((ctx) =>
        knowledgeList(ctx.tx, mintId('Project'), KnowledgeListQuery.parse({}), available),
      ),
    ).toThrow(/not found/);
  });

  it('lists without a search when the index is broken, and says search is unavailable', () => {
    const d = decide();
    const unavailable = { available: false, message: 'Search is unavailable' };
    expect(ids(list({}, unavailable))).toEqual([d.id]);
    expect(list({}, unavailable).search).toEqual(unavailable);
    expect(list({ q: 'queue' }, unavailable)).toMatchObject({ items: [], search: unavailable });
  });
});

describe('recording', () => {
  it('stores a builder source with the tool, session, directory and quote', () => {
    const d = decide({
      source: { via: 'claude_code', sessionId: 'abc', cwd: '/repo', quote: 'use BullMQ' },
    });
    const src = store.db.$client
      .prepare('SELECT kind, ref FROM sources WHERE id = ?')
      .get(d.sourceId) as { kind: string; ref: string };
    expect(src.kind).toBe('builder');
    expect(JSON.parse(src.ref)).toEqual({
      via: 'claude_code',
      sessionId: 'abc',
      cwd: '/repo',
      quote: 'use BullMQ',
    });
  });

  it.each([
    {
      name: 'an area the project lacks',
      body: { scope: 'area' as const, area: 'billing' },
      error: /area: demo has no area named billing/,
    },
    { name: 'an area scope without an area', body: { scope: 'area' as const }, error: /area:/ },
    { name: 'an area with the project scope', body: { area: 'api' }, error: /area:/ },
  ])('refuses a decision with $name', ({ body, error }) => {
    expect(() => decide(body)).toThrow(error);
  });

  it('keeps a principle quote from its source when none is given', () => {
    const p = principle({ source: { via: 'claude_code', quote: 'no sleeps, ever' } });
    expect(p.sourceQuote).toBe('no sleeps, ever');
  });

  it('makes a topic key and a kind when the builder gives none', () => {
    const p = principle({ statement: 'Prefer small PRs', kind: undefined, topicKey: undefined });
    expect(p).toMatchObject({ principleKind: 'heuristic', topicKey: 'prefer-small-prs' });
  });
});

describe('superseding', () => {
  it('replaces a decision, keeping the fields not changed', () => {
    const old = decide();
    const next = store.write((ctx) =>
      supersedeDecisionRecord(ctx, old.id, { choice: 'pg-boss', rationale: 'one database' }),
    ).value;
    expect(next).toMatchObject({
      question: 'Which queue library?',
      choice: 'pg-boss',
      supersedesId: old.id,
      scope: 'project',
      projectId: project.id,
    });
    expect(ids(list({ q: 'queue' }))).toEqual([next.id]);
  });

  it('moves a decision to builder-wide, and a builder-wide one into a project', () => {
    const old = decide();
    const wide = store.write((ctx) => supersedeDecisionRecord(ctx, old.id, { scope: 'you' })).value;
    expect(wide).toMatchObject({ scope: 'you', projectId: null });
    expect(() =>
      store.write((ctx) => supersedeDecisionRecord(ctx, wide.id, { scope: 'project' })),
    ).toThrow(/projectId:/);
    const back = store.write((ctx) =>
      supersedeDecisionRecord(ctx, wide.id, { scope: 'project', projectId: project.id }),
    ).value;
    expect(back).toMatchObject({ scope: 'project', projectId: project.id });
  });

  it('answers 409 naming the current decision when a replaced one is superseded again', () => {
    const old = decide();
    const next = store.write((ctx) =>
      supersedeDecisionRecord(ctx, old.id, { choice: 'pg-boss' }),
    ).value;
    expect(() =>
      store.write((ctx) => supersedeDecisionRecord(ctx, old.id, { choice: 'x' })),
    ).toThrow(new RegExp(`current one is ${next.id}`));
  });

  it('changes a principle statement, kind, topic key and scope', () => {
    const old = principle();
    const next = store.write((ctx) =>
      supersedePrincipleRecord(ctx, old.id, {
        statement: 'Wait on conditions',
        kind: 'heuristic',
        topicKey: 'testing.wait',
        scope: 'area',
        area: 'api',
      }),
    ).value;
    expect(next).toMatchObject({
      statement: 'Wait on conditions',
      principleKind: 'heuristic',
      topicKey: 'testing.wait',
      scope: 'area',
      area: 'api',
      supersedesId: old.id,
      state: 'current',
    });
    expect(ids(list({ q: 'sleep', history: '1' }))).toEqual([old.id]);
    expect(ids(list({ q: 'wait' }))).toEqual([next.id]);
  });

  it('answers 409 naming the principle that holds the new key at the new scope', () => {
    const a = principle({ topicKey: 'a.rule', statement: 'Rule a' });
    const b = principle({ topicKey: 'b.rule', statement: 'Rule b' });
    expect(() =>
      store.write((ctx) => supersedePrincipleRecord(ctx, a.id, { topicKey: 'b.rule' })),
    ).toThrow(new RegExp(b.id));
  });

  it('refuses an area the project lacks', () => {
    const a = principle();
    expect(() =>
      store.write((ctx) => supersedePrincipleRecord(ctx, a.id, { scope: 'area', area: 'billing' })),
    ).toThrow(/area: demo has no area named billing/);
  });
});
