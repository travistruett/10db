import {
  KnowledgeListQuery,
  KnowledgeListShelf,
  KnowledgeSort,
  mintId,
  PrincipleStatus,
  SortDirection,
  type DecisionWrite,
  type KnowledgeListDto,
  type KnowledgeSearchState,
  type PrincipleWrite,
  type ProjectDto,
} from '@10db/contracts';
import {
  createTestStore,
  insertPrinciple,
  insertSource,
  seedProject,
  withdrawDecision,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createPrinciple,
  knowledgeList,
  recordDecision,
  retirePrincipleRecord,
  supersedeDecisionRecord,
  supersedePrincipleRecord,
  withdrawPrincipleRecord,
} from './records';

let store: Store;
let close: () => void;
let project: ProjectDto;
let other: ProjectDto;
beforeEach(() => {
  // Each write a second after the last, so the newest-first order is the order of writing.
  let tick = 0;
  ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 9, 1) + (tick += 1) * 1000)));
  project = seedProject(store, { name: 'demo', areas: [{ name: 'api', globs: ['src/api/**'] }] });
  other = seedProject(store, { name: 'other' });
});
afterEach(() => {
  close();
});

const available: KnowledgeSearchState = { available: true, message: null };
const list = (over: Record<string, string | string[]> = {}, search = available): KnowledgeListDto =>
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
    expect(result).toMatchObject({ total: 3, page: 1, pageSize: 25, search: available });
    // another project sees the builder-wide ones and its own, none of this project's
    expect(
      store
        .write((ctx) => knowledgeList(ctx.tx, other.id, KnowledgeListQuery.parse({}), available))
        .value.items.map((i) => i.id)
        .toSorted(),
    ).toEqual([theirs.id, mine.id, p.id].toSorted());
  });

  it('searches both kinds by text, filters by kind, scope and area, and shows every state on request', () => {
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
    expect(ids(list({ q: 'sleep', shelf: 'all' })).toSorted()).toEqual(
      [old.id, next.id].toSorted(),
    );
    expect(
      list({ q: 'sleep', shelf: 'all' })
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

  it('matches partly typed words, and each added word narrows', () => {
    const d = decide();
    const p = principle();
    expect(ids(list({ q: 'que' }))).toEqual([d.id]);
    expect(ids(list({ q: 'slee' }))).toEqual([p.id]);
    expect(ids(list({ q: 'que lib' }))).toEqual([d.id]);
    expect(ids(list({ q: 'que zebra' }))).toEqual([]);
    expect(ids(list({ q: 'slee zebra' }))).toEqual([]);
  });

  it('matches any whole word when asked to, for free text', () => {
    const d = decide();
    expect(ids(list({ q: 'which queue should we use', match: 'any_word' }))).toEqual([d.id]);
    expect(ids(list({ q: 'which queue should we use' }))).toEqual([]);
  });

  it.each(['-', '***', '"'])('reads %s, which holds no word, as no search', (q) => {
    const d = decide();
    const p = principle();
    expect(ids(list({ q }))).toEqual(ids(list()));
    expect(ids(list({ q })).toSorted()).toEqual([d.id, p.id].toSorted());
    const unavailable = { available: false, message: 'Search is unavailable' };
    expect(list({ q }, unavailable).items).toHaveLength(2);
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

describe('one page of the list', () => {
  /** Every id of each page of `size`, page by page, as far as the total reaches. */
  const pages = (size: number, over: Record<string, string | string[]> = {}) => {
    const out: string[][] = [];
    for (
      let page = 1;
      out.length * size < list({ ...over, pageSize: String(size) }).total;
      page += 1
    )
      out.push(ids(list({ ...over, page: String(page), pageSize: String(size) })));
    return out;
  };

  it.each([
    { page: '1', shown: [4, 3], answered: 1 },
    { page: '2', shown: [2, 1], answered: 2 },
    { page: '3', shown: [0], answered: 3 },
    { page: '9', shown: [0], answered: 3 },
  ])('answers page $page of five, newest first, with the total', ({ page, shown, answered }) => {
    const made = [0, 1, 2, 3, 4].map((i) => decide({ question: `Question ${String(i)}?` }).id);
    const result = list({ page, pageSize: '2' });
    expect(ids(result)).toEqual(shown.map((i) => made[i]));
    expect(result).toMatchObject({ total: 5, page: answered, pageSize: 2 });
  });

  it('pages decisions and principles as one list, a page holding both kinds', () => {
    const d0 = decide({ question: 'First?' }).id;
    const p1 = principle({ topicKey: 'a', statement: 'Rule a' }).id;
    const d2 = decide({ question: 'Third?' }).id;
    const p3 = principle({ topicKey: 'b', statement: 'Rule b' }).id;
    const d4 = decide({ question: 'Fifth?' }).id;
    expect(pages(2)).toEqual([[d4, p3], [d2, p1], [d0]]);
  });

  it('pages a search over both kinds as the whole ranked list, each kind’s best match in turn', () => {
    for (let i = 0; i < 3; i += 1) decide({ question: `Which queue ${String(i)}?` });
    for (let i = 0; i < 2; i += 1)
      principle({ topicKey: `queue.${String(i)}`, statement: `Drain the queue ${String(i)}` });
    decide({ question: 'Which editor?', choice: 'vim', rationale: 'habit' });
    const whole = list({ q: 'queue', pageSize: '100' });
    expect(whole.total).toBe(5);
    expect(whole.items.map((i) => i.kind)).toEqual([
      'decision',
      'principle',
      'decision',
      'principle',
      'decision',
    ]);
    expect(pages(2, { q: 'queue' })).toEqual([
      ids(whole).slice(0, 2),
      ids(whole).slice(2, 4),
      ids(whole).slice(4),
    ]);
    expect(list({ q: 'queue', page: '2', pageSize: '2' }).total).toBe(5);
    expect(pages(1, { q: 'queue', kind: 'decision' }).flat()).toEqual(
      ids(whole).filter((id) => id.startsWith('dec_')),
    );
  });

  describe('by shelf', () => {
    /** One record in each state, of both kinds; the ids by state. */
    const everyState = () => {
      const current = principle({ topicKey: 'a', statement: 'Rule a' });
      const replaced = principle({ topicKey: 'b', statement: 'Rule b' });
      const successor = store.write((ctx) =>
        supersedePrincipleRecord(ctx, replaced.id, { statement: 'Rule b, again' }),
      ).value;
      const retired = principle({ topicKey: 'c', statement: 'Rule c' });
      store.write((ctx) => retirePrincipleRecord(ctx, retired.id, 'ended', undefined));
      const withdrawn = principle({ topicKey: 'd', statement: 'Rule d' });
      store.write((ctx) => withdrawPrincipleRecord(ctx, withdrawn.id, 'a typo', undefined));
      const proposed = store.write((ctx) =>
        insertPrinciple(ctx, {
          target: { scope: 'project', projectId: project.id },
          statement: 'Rule e',
          kind: 'policy',
          topicKey: 'e',
          status: PrincipleStatus.Proposed,
          sourceId: insertSource(ctx, 'agent', {}),
          sourceQuote: null,
          speaker: 'agent:x',
          confirmedBy: null,
        }),
      ).value;
      const decision = decide();
      const oldDecision = decide({ question: 'Which logger?' });
      const newDecision = store.write((ctx) =>
        supersedeDecisionRecord(ctx, oldDecision.id, { choice: 'pino' }),
      ).value;
      const withdrawnDecision = decide({ question: 'Which font?' });
      store.write((ctx) => {
        withdrawDecision(ctx, withdrawnDecision.id, { by: 'me', reason: 'a typo' });
      });
      return {
        current: [current.id, successor.id, decision.id, newDecision.id],
        past: [replaced.id, retired.id, withdrawn.id, oldDecision.id, withdrawnDecision.id],
        proposed: [proposed.id],
      };
    };

    it.each([
      { shelf: KnowledgeListShelf.Current, holds: ['current'] as const },
      { shelf: KnowledgeListShelf.Past, holds: ['past'] as const },
      { shelf: KnowledgeListShelf.All, holds: ['current', 'past', 'proposed'] as const },
    ])('holds only the $shelf records, and counts them', ({ shelf, holds }) => {
      const made = everyState();
      const expected = holds.flatMap((h) => made[h]).toSorted();
      const result = list({ shelf });
      expect(ids(result).toSorted()).toEqual(expected);
      expect(result.total).toBe(expected.length);
    });
  });

  it.each<{ name: string; kind: string | string[]; shown: ('d' | 'p' | 'h' | 'b')[] }>([
    { name: 'two kinds of principle', kind: ['policy', 'belief'], shown: ['p', 'b'] },
    { name: 'decisions and one kind', kind: ['decision', 'belief'], shown: ['d', 'b'] },
    { name: 'every principle', kind: ['principle', 'belief'], shown: ['p', 'h', 'b'] },
    { name: 'one kind', kind: 'heuristic', shown: ['h'] },
  ])('narrows to $name', ({ kind, shown }) => {
    const made = {
      d: decide().id,
      p: principle({ topicKey: 'p', statement: 'A rule', kind: 'policy' }).id,
      h: principle({ topicKey: 'h', statement: 'A preference', kind: 'heuristic' }).id,
      b: principle({ topicKey: 'b', statement: 'Some background', kind: 'belief' }).id,
    };
    const result = list({ kind });
    expect(ids(result).toSorted()).toEqual(shown.map((k) => made[k]).toSorted());
    expect(result.total).toBe(shown.length);
  });

  describe('sorted', () => {
    /** Written oldest first: a belief, a builder-wide heuristic, an api policy, a decision, a policy. */
    const records = () => ({
      belief: principle({ topicKey: 'b', statement: 'Queues are slow', kind: 'belief' }).id,
      mine: principle({
        scope: 'you',
        topicKey: 'h',
        statement: 'Prefer a queue',
        kind: 'heuristic',
      }).id,
      api: principle({
        scope: 'area',
        area: 'api',
        topicKey: 'p.api',
        statement: 'Validate queue input',
        kind: 'policy',
      }).id,
      decision: decide().id,
      policy: principle({ topicKey: 'p', statement: 'Never drop a queue item', kind: 'policy' }).id,
    });
    type Name = keyof ReturnType<typeof records>;

    it.each<{ name: string; query: Record<string, string>; order: Name[] }>([
      {
        name: 'newest first by default',
        query: {},
        order: ['policy', 'decision', 'api', 'mine', 'belief'],
      },
      {
        name: 'by date, oldest first',
        query: { sort: KnowledgeSort.CreatedAt, dir: SortDirection.Asc },
        order: ['belief', 'mine', 'api', 'decision', 'policy'],
      },
      {
        name: 'by kind, policies first and the newest of a kind first',
        query: { sort: KnowledgeSort.Kind, dir: SortDirection.Asc },
        order: ['policy', 'api', 'mine', 'belief', 'decision'],
      },
      {
        name: 'by kind, reversed, ties still newest first',
        query: { sort: KnowledgeSort.Kind, dir: SortDirection.Desc },
        order: ['decision', 'belief', 'mine', 'policy', 'api'],
      },
      {
        name: 'by scope: builder-wide, project, then area',
        query: { sort: KnowledgeSort.Scope, dir: SortDirection.Asc },
        order: ['mine', 'policy', 'decision', 'belief', 'api'],
      },
      {
        name: 'by date with a search, the sort beating the rank',
        query: { q: 'queue', sort: KnowledgeSort.CreatedAt, dir: SortDirection.Asc },
        order: ['belief', 'mine', 'api', 'decision', 'policy'],
      },
    ])('$name', ({ query, order }) => {
      const made = records();
      expect(ids(list(query))).toEqual(order.map((n) => made[n]));
    });

    it('by state, by the state’s name', () => {
      const a = principle({ topicKey: 'a', statement: 'Rule a' });
      store.write((ctx) => retirePrincipleRecord(ctx, a.id, 'ended', undefined));
      const b = principle({ topicKey: 'b', statement: 'Rule b' });
      const c = principle({ topicKey: 'c', statement: 'Rule c' });
      store.write((ctx) => withdrawPrincipleRecord(ctx, c.id, 'a typo', undefined));
      const states = (dir: SortDirection) =>
        list({ shelf: 'all', sort: KnowledgeSort.State, dir }).items.map((i) => i.state);
      expect(ids(list({ shelf: 'all', sort: KnowledgeSort.State }))).toEqual([b.id, a.id, c.id]);
      expect(states(SortDirection.Asc)).toEqual(['current', 'retired', 'withdrawn']);
      expect(states(SortDirection.Desc)).toEqual(['withdrawn', 'retired', 'current']);
    });
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
    expect(ids(list({ q: 'sleep', shelf: 'past' }))).toEqual([old.id]);
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
