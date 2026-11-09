import { describe, expect, it } from 'vitest';
import {
  DecisionEdit,
  DecisionWrite,
  KNOWLEDGE_SEARCH_MAX_LENGTH,
  KnowledgeListQuery,
  KnowledgeReason,
  clampKnowledgeSearch,
  PrincipleEdit,
  PrincipleWrite,
  ProposalListQuery,
  ProposalVerdictAccept,
  ProposalVerdictReject,
} from './knowledge-api';

const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path.join('.'));

describe('the knowledge list query', () => {
  const DEFAULTS = { kind: [], shelf: 'current', dir: 'asc', page: 1, pageSize: 25 };

  it('defaults to the first page of 25 current records', () => {
    expect(KnowledgeListQuery.parse({})).toEqual(DEFAULTS);
  });

  it.each([
    ['the past shelf', { shelf: 'past' }, { shelf: 'past' }],
    ['every state', { shelf: 'all' }, { shelf: 'all' }],
    ['a kind of principle', { kind: 'policy' }, { kind: ['policy'] }],
    [
      'a repeated kind, once each',
      { kind: ['policy', 'belief', 'policy'] },
      { kind: ['policy', 'belief'] },
    ],
    ['a text and a scope', { q: ' queue ', scope: 'you' }, { q: 'queue', scope: 'you' }],
    ['a page and its size', { page: '3', pageSize: '100' }, { page: 3, pageSize: 100 }],
    ['a sort and its direction', { sort: 'kind', dir: 'desc' }, { sort: 'kind', dir: 'desc' }],
  ])('reads %s', (_name, input, out) => {
    expect(KnowledgeListQuery.parse(input)).toEqual({ ...DEFAULTS, ...out });
  });

  it.each([
    ['an unknown kind', { kind: 'rule' }, 'kind'],
    ['an unknown kind among several', { kind: ['policy', 'rule'] }, 'kind'],
    ['an unknown scope', { scope: 'team' }, 'scope'],
    ['an unknown shelf', { shelf: 'pending' }, 'shelf'],
    ['the history flag the shelf replaced', { history: '1' }, ''],
    ['the limit pages replaced', { limit: '10' }, ''],
    ['a misspelt parameter', { quer: 'x' }, ''],
    ['page 0', { page: '0' }, 'page'],
    ['a page of 101', { pageSize: '101' }, 'pageSize'],
    ['an unknown sort', { sort: 'rank' }, 'sort'],
    ['an unknown direction', { dir: 'up' }, 'dir'],
  ])('refuses %s, naming it', (_name, input, path) => {
    const r = KnowledgeListQuery.safeParse(input);
    expect(r.success).toBe(false);
    expect(paths(r)).toContain(path);
  });

  it('takes a search of exactly the shared limit and refuses one character more', () => {
    const q = 'a'.repeat(KNOWLEDGE_SEARCH_MAX_LENGTH);
    expect(KnowledgeListQuery.safeParse({ q }).success).toBe(true);
    const r = KnowledgeListQuery.safeParse({ q: `${q}a` });
    expect(r.success).toBe(false);
    expect(paths(r)).toContain('q');
  });
});

describe('clampKnowledgeSearch', () => {
  it('leaves a search within the limit alone', () => {
    expect(clampKnowledgeSearch('queue')).toBe('queue');
  });

  it('cuts plain text at the limit', () => {
    const q = 'a'.repeat(KNOWLEDGE_SEARCH_MAX_LENGTH + 5);
    expect(clampKnowledgeSearch(q)).toBe('a'.repeat(KNOWLEDGE_SEARCH_MAX_LENGTH));
  });

  it('counts UTF-16 code units like the route, so 200 emoji still parse', () => {
    const clamped = clampKnowledgeSearch('😀'.repeat(200));
    expect(clamped.length).toBeLessThanOrEqual(KNOWLEDGE_SEARCH_MAX_LENGTH);
    expect(KnowledgeListQuery.safeParse({ q: clamped }).success).toBe(true);
  });

  it('never leaves half a surrogate pair at the cut', () => {
    const clamped = clampKnowledgeSearch(`${'a'.repeat(KNOWLEDGE_SEARCH_MAX_LENGTH - 1)}😀`);
    expect(clamped).toBe('a'.repeat(KNOWLEDGE_SEARCH_MAX_LENGTH - 1));
  });
});

describe('the write bodies', () => {
  it('takes a decision without a scope', () => {
    expect(DecisionWrite.safeParse({ question: 'q', choice: 'c', rationale: 'r' }).success).toBe(
      true,
    );
  });

  it('keeps a source with its session, directory and quote', () => {
    const source = { via: 'claude_code', sessionId: 's1', cwd: '/x', quote: 'always do this' };
    expect(PrincipleWrite.parse({ statement: 'Do it', source, dryRun: true }).source).toEqual(
      source,
    );
  });

  it('refuses a source with an unknown key, or none of the tool', () => {
    expect(paths(PrincipleWrite.safeParse({ statement: 's', source: { via: '' } }))).toContain(
      'source.via',
    );
    expect(
      paths(PrincipleWrite.safeParse({ statement: 's', source: { via: 'x', session: 'y' } })),
    ).toContain('source');
  });

  it.each([
    ['a decision edit', DecisionEdit],
    ['a principle edit', PrincipleEdit],
  ] as const)('refuses %s that changes nothing', (_name, schema) => {
    const r = schema.safeParse({ source: { via: 'x' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/at least one field/);
  });

  it('takes a principle edit that moves scope, key and kind', () => {
    expect(
      PrincipleEdit.safeParse({ scope: 'you', topicKey: 'new.key', kind: 'belief' }).success,
    ).toBe(true);
  });

  it('refuses a stray field on a reason, and a blank reason', () => {
    expect(KnowledgeReason.safeParse({ reason: 'x', colour: 'y' }).success).toBe(false);
    expect(KnowledgeReason.safeParse({ reason: ' ' }).success).toBe(false);
  });

  it.each([
    ['a retire or a withdrawal', KnowledgeReason, { reason: 'x' }],
    ['an accepted proposal', ProposalVerdictAccept, {}],
    ['a rejected proposal', ProposalVerdictReject, {}],
  ] as const)('takes a source on %s', (_name, schema, body) => {
    const source = { via: 'claude_code', sessionId: 's1', cwd: '/x', quote: 'it is wrong' };
    expect(schema.parse({ ...body, source }).source).toEqual(source);
  });

  it('takes a dry run on a reason', () => {
    expect(KnowledgeReason.parse({ reason: 'x', dryRun: true }).dryRun).toBe(true);
  });

  it('lists pending proposals by default', () => {
    expect(ProposalListQuery.parse({})).toEqual({ status: 'pending' });
  });
});
