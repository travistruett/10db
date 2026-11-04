import {
  SearchMatch,
  type KnowledgeTarget,
  type PrincipleId,
  type ProjectId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { findOpenProposalCard, insertInboxItem, updateInboxItem } from './inbox';
import { insertDecision } from './decisions';
import { getProposalDto, insertProposal, insertSource, listProposals } from './knowledge';
import {
  checkKnowledgeIndex,
  findRecords,
  searchPrincipleIds,
  searchPrinciples,
} from './knowledge-search';
import {
  confirmPrinciple,
  getPrinciple,
  insertPrinciple,
  listPrinciples,
  retirePrinciple,
  supersedePrinciple,
  withdrawPrinciple,
  type NewPrinciple,
} from './principles';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const principle = (target: KnowledgeTarget, overrides: Partial<NewPrinciple> = {}) =>
  store.write((ctx) =>
    insertPrinciple(ctx, {
      target,
      statement: 'Never sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      status: 'confirmed',
      sourceId: insertSource(ctx, 'builder', {}),
      sourceQuote: null,
      speaker: 'me',
      confirmedBy: 'me',
      ...overrides,
    }),
  ).value;

const project = (id: ProjectId) => ({ scope: 'project' as const, projectId: id });
const found = (projectId: ProjectId, query: string) =>
  searchPrinciples(store.db, projectId, query, 10).map((p) => p.statement);
/** The stored row, for the columns a PrincipleDto does not carry (who retired or withdrew it). */
const row = (id: PrincipleId) =>
  store.db.select().from(schema.principles).where(eq(schema.principles.id, id)).get();

describe('principles', () => {
  it('reads a confirmed principle back through search, with its key and quote searchable', () => {
    const p = seedProject(store);
    const saved = principle(project(p.id), { sourceQuote: 'wait on a condition instead' });
    expect(saved).toMatchObject({ state: 'current', status: 'confirmed', confirmedBy: 'me' });
    expect(found(p.id, 'sleep')).toEqual(['Never sleep in tests']);
    expect(found(p.id, 'condition')).toEqual(['Never sleep in tests']);
    expect(found(p.id, 'testing')).toEqual(['Never sleep in tests']);
  });

  it('finds a principle by its edited statement after confirmation, never while proposed', () => {
    const p = seedProject(store);
    const proposed = principle(project(p.id), {
      status: 'proposed',
      confirmedBy: null,
      speaker: 'agent:x',
    });
    expect(proposed.state).toBe('proposed');
    expect(found(p.id, 'sleep')).toEqual([]);
    expect(
      searchPrincipleIds(store.db, { projectId: p.id, query: 'sleep', limit: 5, history: true }),
    ).toEqual([proposed.id]);
    const confirmed = store.write((ctx) =>
      confirmPrinciple(ctx, proposed.id, {
        target: { scope: 'area', projectId: p.id, area: 'api' },
        statement: 'Never poll in tests',
        topicKey: 'testing.no-polling',
        confirmedBy: 'me',
      }),
    ).value;
    expect(confirmed).toMatchObject({
      state: 'current',
      scope: 'area',
      area: 'api',
      topicKey: 'testing.no-polling',
    });
    expect(found(p.id, 'sleep')).toEqual([]);
    expect(found(p.id, 'poll')).toEqual(['Never poll in tests']);
    expect(() =>
      store.write((ctx) =>
        confirmPrinciple(ctx, proposed.id, { target: project(p.id), confirmedBy: 'me' }),
      ),
    ).toThrow(/only a proposed principle/);
  });

  it.each([
    { name: 'the same key and target', second: 'same', supersedes: true },
    { name: 'the same key for you instead of the project', second: 'you', supersedes: false },
    { name: 'the same key in another project', second: 'other-project', supersedes: false },
    { name: 'the same key in another area', second: 'other-area', supersedes: false },
    { name: 'another key, same target', second: 'other-key', supersedes: false },
  ] as const)(
    'supersedes only within the same topic key and target: $name',
    ({ second, supersedes }) => {
      const a = seedProject(store);
      const b = seedProject(store);
      const areaTarget = { scope: 'area' as const, projectId: a.id, area: 'api' };
      const first = principle(second === 'other-area' ? areaTarget : project(a.id));
      const targets = {
        same: project(a.id),
        you: { scope: 'you' as const },
        'other-project': project(b.id),
        'other-area': { scope: 'area' as const, projectId: a.id, area: 'ui' },
        'other-key': project(a.id),
      } as const;
      const next = principle(targets[second], {
        statement: 'Never sleep, even in e2e',
        ...(second === 'other-key' ? { topicKey: 'testing.e2e' } : {}),
      });
      expect(getPrinciple(store.db, first.id).state).toBe(supersedes ? 'superseded' : 'current');
      expect(next.supersedesId).toBe(supersedes ? first.id : null);
      expect(found(a.id, 'sleep').includes('Never sleep in tests')).toBe(!supersedes);
    },
  );

  it.each([
    { name: 'the same key and target', proposedAt: 'project', confirmAt: 'project', edit: false },
    { name: 'a target chosen at confirm', proposedAt: 'area', confirmAt: 'project', edit: false },
    { name: 'a key edited at confirm', proposedAt: 'project', confirmAt: 'project', edit: true },
  ] as const)(
    'confirming a proposal supersedes the current principle with $name',
    ({ proposedAt, confirmAt, edit }) => {
      const p = seedProject(store);
      const targets = {
        project: project(p.id),
        area: { scope: 'area' as const, projectId: p.id, area: 'api' },
      };
      const old = principle(project(p.id));
      const proposal = principle(targets[proposedAt], {
        status: 'proposed',
        confirmedBy: null,
        statement: 'Never sleep, even in e2e',
        ...(edit ? { topicKey: 'testing.drafted' } : {}),
      });
      const next = store.write((ctx) =>
        confirmPrinciple(ctx, proposal.id, {
          target: targets[confirmAt],
          confirmedBy: 'me',
          ...(edit ? { topicKey: old.topicKey } : {}),
        }),
      ).value;
      expect(next).toMatchObject({ state: 'current', supersedesId: old.id });
      expect(getPrinciple(store.db, old.id)).toMatchObject({
        state: 'superseded',
        supersededById: next.id,
      });
      expect(found(p.id, 'sleep')).toEqual(['Never sleep, even in e2e']);
    },
  );

  it.each([
    { name: 'the same key at another target', edit: false },
    { name: 'a key edited at confirm onto no current principle', edit: true },
  ])('confirming a proposal leaves both current with $name', ({ edit }) => {
    const p = seedProject(store);
    const area = { scope: 'area' as const, projectId: p.id, area: 'api' };
    const old = principle(project(p.id));
    const proposal = principle(project(p.id), {
      status: 'proposed',
      confirmedBy: null,
      statement: 'Never sleep, even in e2e',
    });
    const next = store.write((ctx) =>
      confirmPrinciple(ctx, proposal.id, {
        target: edit ? project(p.id) : area,
        confirmedBy: 'me',
        ...(edit ? { topicKey: 'testing.e2e' } : {}),
      }),
    ).value;
    expect(next).toMatchObject({ state: 'current', supersedesId: null });
    expect(getPrinciple(store.db, old.id).state).toBe('current');
    expect(found(p.id, 'sleep').toSorted()).toEqual([
      'Never sleep in tests',
      'Never sleep, even in e2e',
    ]);
  });

  it('retires a current principle out of search, and refuses to retire a superseded one', () => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const next = principle(project(p.id), { statement: 'Never sleep, ever' });
    expect(() => store.write((ctx) => retirePrinciple(ctx, old.id, 'me', 'gone'))).toThrow(
      /only a current principle/,
    );
    const retired = store.write((ctx) =>
      retirePrinciple(ctx, next.id, 'me', 'we use fake timers now'),
    ).value;
    expect(retired).toMatchObject({
      state: 'retired',
      retiredBy: 'me',
      retiredReason: 'we use fake timers now',
      withdrawnBy: null,
    });
    expect(getPrinciple(store.db, next.id)).toMatchObject({ retiredBy: 'me' });
    expect(row(next.id)).toMatchObject({
      retiredBy: 'me',
      retiredReason: 'we use fake timers now',
    });
    expect(row(next.id)?.retiredAt).toBeTruthy();
    expect(found(p.id, 'sleep')).toEqual([]);
    expect(
      listPrinciples(store.db, { projectId: p.id, history: true }).map((x) => x.state),
    ).toEqual(['retired', 'superseded']);
  });

  it('refuses an empty reason to retire or withdraw', () => {
    const p = seedProject(store);
    const one = principle(project(p.id));
    expect(() => store.write((ctx) => retirePrinciple(ctx, one.id, 'me', '  '))).toThrow(/why/i);
    expect(() => store.write((ctx) => withdrawPrinciple(ctx, one.id, 'me', ''))).toThrow(/why/i);
    expect(found(p.id, 'sleep')).toEqual(['Never sleep in tests']);
  });

  it('never returns a proposed, retired, superseded or withdrawn principle from a current search', () => {
    const p = seedProject(store);
    principle(project(p.id), { status: 'proposed', confirmedBy: null, topicKey: 'a' });
    const retired = principle(project(p.id), { topicKey: 'b' });
    store.write((ctx) => retirePrinciple(ctx, retired.id, 'me', 'old'));
    principle(project(p.id), { topicKey: 'c' });
    principle(project(p.id), { topicKey: 'c', statement: 'Sleep only in the e2e harness' });
    const withdrawn = principle(project(p.id), { topicKey: 'd' });
    store.write((ctx) => withdrawPrinciple(ctx, withdrawn.id, 'me', 'typo'));
    expect(found(p.id, 'sleep')).toEqual(['Sleep only in the e2e harness']);
    expect(listPrinciples(store.db, { projectId: p.id }).map((x) => x.topicKey)).toEqual(['c']);
    expect(
      searchPrincipleIds(store.db, { projectId: p.id, query: 'sleep', limit: 10, history: true }),
    ).toHaveLength(5);
  });

  it('keeps the withdrawn row with who, when and why', () => {
    const p = seedProject(store);
    const one = principle(project(p.id));
    const withdrawn = store.write((ctx) => withdrawPrinciple(ctx, one.id, 'me', 'typo')).value;
    expect(withdrawn).toMatchObject({
      state: 'withdrawn',
      withdrawnBy: 'me',
      withdrawnReason: 'typo',
      retiredBy: null,
    });
    expect(getPrinciple(store.db, one.id).withdrawnBy).toBe('me');
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect(row(one.id)).toMatchObject({ withdrawnBy: 'me', withdrawnReason: 'typo' });
    expect(row(one.id)?.withdrawnAt).toBeTruthy();
    expect(found(p.id, 'sleep')).toEqual([]);
  });

  it('makes only the link before the head current when the head of a three-link chain is withdrawn', () => {
    const p = seedProject(store);
    const a = principle(project(p.id), { statement: 'Never sleep in tests' });
    const b = principle(project(p.id), { statement: 'Never sleep in unit tests' });
    const c = principle(project(p.id), { statement: 'Never sleep in any test' });
    store.write((ctx) => withdrawPrinciple(ctx, c.id, 'me', 'reverted'));
    expect([a, b, c].map((x) => getPrinciple(store.db, x.id).state)).toEqual([
      'superseded',
      'current',
      'withdrawn',
    ]);
    expect(found(p.id, 'sleep')).toEqual(['Never sleep in unit tests']);
  });

  it.each([
    { which: 'b', successor: 'c' },
    { which: 'a', successor: 'b' },
  ] as const)(
    'refuses to withdraw the superseded link $which of a chain, naming $successor',
    ({ which, successor }) => {
      const p = seedProject(store);
      const links = {
        a: principle(project(p.id), { statement: 'Never sleep in tests' }),
        b: principle(project(p.id), { statement: 'Never sleep in unit tests' }),
        c: principle(project(p.id), { statement: 'Never sleep in any test' }),
      };
      expect(() =>
        store.write((ctx) => withdrawPrinciple(ctx, links[which].id, 'me', 'no longer true')),
      ).toThrow(new RegExp(links[successor].id));
      expect(found(p.id, 'sleep')).toEqual(['Never sleep in any test']);
    },
  );

  it('refuses to withdraw a link whose successor was retired, naming it, without asking to withdraw it', () => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const next = principle(project(p.id), { statement: 'Never sleep, ever' });
    store.write((ctx) => retirePrinciple(ctx, next.id, 'me', 'fake timers now'));
    const refusal = (() => {
      try {
        store.write((ctx) => withdrawPrinciple(ctx, old.id, 'me', 'no longer true'));
      } catch (error) {
        return String(error);
      }
      return '';
    })();
    expect(refusal).toContain(next.id);
    expect(refusal).not.toMatch(/withdraw (that|it)/i);
    expect(found(p.id, 'sleep')).toEqual([]);
  });

  it('filters the list by scope, area and kind', () => {
    const p = seedProject(store);
    principle({ scope: 'you' }, { topicKey: 'mine', kind: 'heuristic' });
    principle(project(p.id), { topicKey: 'ours' });
    principle(
      { scope: 'area', projectId: p.id, area: 'api' },
      { topicKey: 'api-only', kind: 'belief' },
    );
    const keys = (filter: Omit<Parameters<typeof listPrinciples>[1], 'projectId'>) =>
      listPrinciples(store.db, { projectId: p.id, ...filter })
        .map((x) => x.topicKey)
        .sort();
    expect(keys({})).toEqual(['api-only', 'mine', 'ours']);
    expect(keys({ scope: 'you' })).toEqual(['mine']);
    expect(keys({ scope: 'area', area: 'api' })).toEqual(['api-only']);
    expect(keys({ kind: 'policy' })).toEqual(['ours']);
  });

  it('finds current principles in find_records beside decisions, each with its kind, key, scope and date', () => {
    const p = seedProject(store);
    const other = seedProject(store, { name: 'other' });
    const old = principle(project(p.id), { topicKey: 'tests.no-sleeps' });
    const current = principle(project(p.id), {
      topicKey: 'tests.no-sleeps',
      statement: 'Never sleep in tests, wait on a condition',
      rationale: 'Sleeps make the suite flaky',
    });
    principle(project(other.id), { statement: 'Never sleep elsewhere', topicKey: 'elsewhere' });
    principle({ scope: 'you' }, { statement: 'Always sleep on it', topicKey: 'mine' });
    store.write((ctx) =>
      insertDecision(ctx, {
        projectId: p.id,
        question: 'Sleep in tests?',
        choice: 'Never',
        rationale: 'Flaky',
        decidedBy: 'me',
        scope: 'project',
        area: null,
        sourceId: insertSource(ctx, 'builder', {}),
      }),
    );
    const hits = findRecords(store.db, p.id, 'sleep', 10);
    expect(hits.map((h) => h.kind).sort()).toEqual(['decision', 'principle', 'principle']);
    expect(hits.filter((h) => h.kind === 'principle')).toEqual(
      expect.arrayContaining([
        {
          kind: 'principle',
          id: current.id,
          statement: 'Never sleep in tests, wait on a condition',
          rationale: 'Sleeps make the suite flaky',
          principleKind: 'policy',
          topicKey: 'tests.no-sleeps',
          scope: 'project',
          area: null,
          createdAt: current.createdAt,
        },
      ]),
    );
    expect(hits.some((h) => h.id === old.id)).toBe(false);
    expect(hits.some((h) => h.kind === 'principle' && h.scope === 'you')).toBe(true);
  });

  it('never throws on hostile search text for principles', () => {
    const p = seedProject(store);
    principle(project(p.id), { statement: "What's the deal with quotes?", topicKey: 'quotes' });
    expect(found(p.id, `what's -the "deal" (NEAR OR`)).toEqual(["What's the deal with quotes?"]);
    expect(found(p.id, '***')).toEqual([]);
    expect(checkKnowledgeIndex(store.db)).toEqual([]);
  });

  it('finds a principle from partly typed words, each added word narrowing', () => {
    const p = seedProject(store);
    const id = principle(project(p.id), {
      statement: 'Never sleep in tests',
      topicKey: 'testing.no-sleeps',
    }).id;
    const typed = (query: string) =>
      searchPrincipleIds(store.db, {
        projectId: p.id,
        query,
        limit: 5,
        match: SearchMatch.AllPrefixes,
      });
    expect(typed('slee')).toEqual([id]);
    expect(typed('slee test')).toEqual([id]);
    expect(typed('slee queue')).toEqual([]);
    expect(found(p.id, 'slee')).toEqual([]);
  });
});

describe('principle proposals', () => {
  it('lists a pending proposal with its principle and finds its open card', () => {
    const p = seedProject(store);
    const proposed = principle(project(p.id), { status: 'proposed', confirmedBy: null });
    const proposalId = store.write((ctx) =>
      insertProposal(ctx, {
        projectId: p.id,
        kind: 'principle',
        title: 'No sleeps',
        body: 'b',
        sourceId: insertSource(ctx, 'agent', {}),
        principleId: proposed.id,
      }),
    ).value;
    expect(listProposals(store.db, { projectId: p.id, status: 'pending' })).toEqual([
      getProposalDto(store.db, proposalId),
    ]);
    expect(getProposalDto(store.db, proposalId).principle?.id).toBe(proposed.id);
    // Still proposed: the principle is not in a current search until the proposal is accepted.
    expect(found(p.id, 'sleep')).toEqual([]);
    const card = store.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: p.id,
        kind: 'proposal',
        title: 'No sleeps',
        body: '',
        options: [{ label: 'reject', description: '' }],
        recommendation: null,
        category: 'product',
        urgency: 'low',
        detail: { proposalId },
        foldKey: null,
        targets: [],
      }),
    ).value;
    expect(findOpenProposalCard(store.db, proposalId)?.id).toBe(card.id);
    store.write((ctx) =>
      updateInboxItem(ctx, card.id, { state: 'RESOLVED', answer: { choice: 'reject' } }),
    );
    expect(findOpenProposalCard(store.db, proposalId)).toBeUndefined();
  });
});

describe('supersedePrinciple', () => {
  const supersede = (
    id: Parameters<typeof supersedePrinciple>[1],
    input: Partial<Parameters<typeof supersedePrinciple>[2]> = {},
  ) =>
    store.write((ctx) =>
      supersedePrinciple(ctx, id, {
        sourceId: insertSource(ctx, 'builder', {}),
        confirmedBy: 'me',
        ...input,
      }),
    ).value;

  it('makes a successor with a new statement current and the predecessor superseded', () => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const next = supersede(old.id, { statement: 'Never poll or sleep in tests' });
    expect(next).toMatchObject({
      state: 'current',
      supersedesId: old.id,
      statement: 'Never poll or sleep in tests',
      kind: 'policy',
      topicKey: 'testing.no-sleeps',
      scope: 'project',
    });
    expect(getPrinciple(store.db, old.id)).toMatchObject({
      state: 'superseded',
      supersededById: next.id,
    });
    expect(found(p.id, 'sleep')).toEqual(['Never poll or sleep in tests']);
    expect(
      searchPrincipleIds(store.db, { projectId: p.id, query: 'sleep', limit: 10, history: true }),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: 'kind',
      input: () => ({ kind: 'belief' as const }),
      expected: () => ({ kind: 'belief' }),
    },
    {
      name: 'topic key',
      input: () => ({ topicKey: 'testing.fake-timers' }),
      expected: () => ({ topicKey: 'testing.fake-timers' }),
    },
    {
      name: 'scope to you',
      input: () => ({ target: { scope: 'you' as const } }),
      expected: () => ({ scope: 'you', projectId: null, area: null }),
    },
    {
      name: 'scope to an area',
      input: (projectId: ProjectId) => ({
        target: { scope: 'area' as const, projectId, area: 'api' },
      }),
      expected: (projectId: ProjectId) => ({ scope: 'area', projectId, area: 'api' }),
    },
  ])('changes the $name on the successor', ({ input, expected }) => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const next = supersede(old.id, input(p.id));
    expect(next).toMatchObject({ state: 'current', supersedesId: old.id, ...expected(p.id) });
    expect(getPrinciple(store.db, old.id).state).toBe('superseded');
    expect(listPrinciples(store.db, { projectId: p.id }).map((x) => x.id)).toEqual([next.id]);
    expect(found(p.id, 'sleep')).toEqual(['Never sleep in tests']);
  });

  it('refuses a successor whose new key already has a current principle at its new scope, naming it', () => {
    const p = seedProject(store);
    const old = principle(project(p.id), { topicKey: 'testing.no-sleeps' });
    const other = principle(project(p.id), {
      topicKey: 'testing.fake-timers',
      statement: 'Use fake timers',
    });
    expect(() => supersede(old.id, { topicKey: 'testing.fake-timers' })).toThrow(
      new RegExp(other.id),
    );
    expect(getPrinciple(store.db, old.id).state).toBe('current');
    expect(getPrinciple(store.db, other.id).state).toBe('current');
    expect(found(p.id, 'sleep')).toEqual(['Never sleep in tests']);
  });

  it('refuses a successor moved to a scope where its key is already current, naming that principle', () => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const mine = principle({ scope: 'you' }, { statement: 'I never sleep in tests' });
    expect(() => supersede(old.id, { target: { scope: 'you' } })).toThrow(new RegExp(mine.id));
    expect(getPrinciple(store.db, old.id).state).toBe('current');
    expect(getPrinciple(store.db, mine.id).state).toBe('current');
    expect(found(p.id, 'sleep').toSorted()).toEqual([
      'I never sleep in tests',
      'Never sleep in tests',
    ]);
  });

  describe('withdrawing a successor that moved its key or scope', () => {
    const moves = [
      { name: 'key', move: () => ({ topicKey: 'testing.moved' }) },
      { name: 'scope', move: () => ({ target: { scope: 'you' as const } }) },
    ];

    it.each(moves)(
      'refuses when the old $name has a new current principle, naming it',
      ({ move }) => {
        const p = seedProject(store);
        const a = principle(project(p.id));
        const b = supersede(a.id, { ...move(), statement: 'Sleep nowhere' });
        const c = principle(project(p.id), { statement: 'Do not sleep here' });
        expect(c.supersedesId).toBeNull();
        expect(() => store.write((ctx) => withdrawPrinciple(ctx, b.id, 'me', 'reverted'))).toThrow(
          new RegExp(c.id),
        );
        expect([a, b, c].map((x) => getPrinciple(store.db, x.id).state)).toEqual([
          'superseded',
          'current',
          'current',
        ]);
        expect(found(p.id, 'sleep').toSorted()).toEqual(['Do not sleep here', 'Sleep nowhere']);
      },
    );

    it.each(moves)('allows it once the old $name is free again', ({ move }) => {
      const p = seedProject(store);
      const a = principle(project(p.id));
      const b = supersede(a.id, { ...move(), statement: 'Sleep nowhere' });
      const c = principle(project(p.id), { statement: 'Do not sleep here' });
      store.write((ctx) => retirePrinciple(ctx, c.id, 'me', 'replaced by the other rule'));
      store.write((ctx) => withdrawPrinciple(ctx, b.id, 'me', 'reverted'));
      expect(getPrinciple(store.db, a.id).state).toBe('current');
      expect(found(p.id, 'sleep')).toEqual(['Never sleep in tests']);
    });
  });

  it('allows a new key that is current only at another scope', () => {
    const p = seedProject(store);
    const old = principle(project(p.id));
    const mine = principle({ scope: 'you' }, { topicKey: 'testing.fake-timers' });
    const next = supersede(old.id, { topicKey: 'testing.fake-timers' });
    expect(next.state).toBe('current');
    expect(getPrinciple(store.db, mine.id).state).toBe('current');
  });

  it.each(['superseded', 'retired', 'withdrawn', 'proposed'] as const)(
    'refuses to supersede a %s principle',
    (state) => {
      const p = seedProject(store);
      const target = principle(project(p.id), {
        topicKey: 'k',
        ...(state === 'proposed' ? { status: 'proposed' as const, confirmedBy: null } : {}),
      });
      if (state === 'superseded') principle(project(p.id), { topicKey: 'k' });
      if (state === 'retired') store.write((ctx) => retirePrinciple(ctx, target.id, 'me', 'old'));
      if (state === 'withdrawn')
        store.write((ctx) => withdrawPrinciple(ctx, target.id, 'me', 'typo'));
      expect(() => supersede(target.id, { statement: 'x' })).toThrow(
        /only a current principle can be superseded/,
      );
      expect(found(p.id, 'x')).toEqual([]);
    },
  );
});
