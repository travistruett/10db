import { describe, expect, it } from 'vitest';
import {
  DecisionEdit,
  DecisionWrite,
  KnowledgeListQuery,
  KnowledgeReason,
  PrincipleEdit,
  PrincipleWrite,
  ProposalListQuery,
  ProposalVerdictAccept,
  ProposalVerdictReject,
} from './knowledge-api';

const paths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path.join('.'));

describe('the knowledge list query', () => {
  it('defaults to current records, 100 of them', () => {
    expect(KnowledgeListQuery.parse({})).toEqual({ history: false, limit: 100 });
  });

  it.each([
    ['history=1', { history: '1' }, { history: true, limit: 100 }],
    ['a kind of principle', { kind: 'policy' }, { kind: 'policy', history: false, limit: 100 }],
    [
      'a text and a scope',
      { q: ' queue ', scope: 'you' },
      { q: 'queue', scope: 'you', history: false, limit: 100 },
    ],
  ])('reads %s', (_name, input, out) => {
    expect(KnowledgeListQuery.parse(input)).toEqual(out);
  });

  it.each([
    ['an unknown kind', { kind: 'rule' }, 'kind'],
    ['an unknown scope', { scope: 'team' }, 'scope'],
    ['history=yes', { history: 'yes' }, 'history'],
    ['a misspelt parameter', { quer: 'x' }, ''],
    ['a limit of 0', { limit: '0' }, 'limit'],
  ])('refuses %s, naming it', (_name, input, path) => {
    const r = KnowledgeListQuery.safeParse(input);
    expect(r.success).toBe(false);
    expect(paths(r)).toContain(path);
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
