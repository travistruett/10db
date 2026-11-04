import { mintId, type DecisionId, type KnowledgeScope, type PrincipleKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { appliesTo, mostSpecific } from './scope';
import {
  decisionTokens,
  packKnowledge,
  principleTokens,
  type PackDecision,
  type PackInput,
  type PackPrinciple,
} from './pack';

const rule = (
  topicKey: string,
  kind: PrincipleKind = 'policy',
  scope: KnowledgeScope = 'project',
  area: string | null = null,
  statement = `Rule ${topicKey}`,
): PackPrinciple => ({ id: mintId('Principle'), statement, kind, topicKey, scope, area });

const decided = (
  question: string,
  scope: KnowledgeScope = 'project',
  area: string | null = null,
): PackDecision => ({ id: mintId('Decision'), question, choice: 'c', rationale: 'r', scope, area });

const input = (over: Partial<PackInput> = {}): PackInput => ({
  areas: ['api'],
  principles: [],
  decisions: [],
  ranked: [],
  budgetTokens: 1500,
  ...over,
});

describe('scope', () => {
  it.each([
    { name: 'yours', scope: 'you', area: null, applies: true },
    { name: 'the project', scope: 'project', area: null, applies: true },
    { name: 'an area the task works in', scope: 'area', area: 'api', applies: true },
    { name: 'another area', scope: 'area', area: 'ui', applies: false },
  ] as const)('a record for $name applies: $applies', ({ scope, area, applies }) => {
    expect(appliesTo({ scope, area }, ['api'])).toBe(applies);
  });

  it.each([
    { name: 'project over you', rules: [rule('k', 'policy', 'you'), rule('k')], kept: ['project'] },
    {
      name: 'area over project',
      rules: [rule('k'), rule('k', 'policy', 'area', 'api')],
      kept: ['area'],
    },
    {
      name: 'project over an area the task is not in',
      rules: [rule('k'), rule('k', 'policy', 'area', 'ui')],
      kept: ['project'],
    },
    {
      name: 'two different keys',
      rules: [rule('a', 'policy', 'you'), rule('b')],
      kept: ['you', 'project'],
    },
    {
      name: 'an area belief over a project policy, since it ignores kind (the packer drops beliefs first)',
      rules: [rule('k'), rule('k', 'belief', 'area', 'api')],
      kept: ['area'],
    },
  ])('keeps only the most specific principle per topic key: $name', ({ rules, kept }) => {
    expect(mostSpecific(rules, ['api']).map((r) => r.scope)).toEqual(kept);
  });
});

describe('packKnowledge', () => {
  it('says nothing applies when there is nothing', () => {
    expect(packKnowledge(input())).toEqual({
      policies: [],
      heuristics: [],
      decisions: [],
      budgetTokens: 1500,
      usedTokens: 0,
      dropped: { policies: 0, heuristics: 0, decisions: 0 },
    });
  });

  it('packs policies, then heuristics, area before project before you, and never beliefs', () => {
    const pack = packKnowledge(
      input({
        principles: [
          rule('mine', 'policy', 'you'),
          rule('ours', 'policy'),
          rule('api', 'policy', 'area', 'api'),
          rule('prefer', 'heuristic'),
          rule('context', 'belief'),
          rule('ui', 'policy', 'area', 'ui'),
          rule('ours', 'belief', 'area', 'api'),
          rule('prefer', 'belief', 'area', 'api'),
        ],
      }),
    );
    expect(pack.policies.map((p) => p.topicKey)).toEqual(['api', 'ours', 'mine']);
    expect(pack.policies.find((p) => p.topicKey === 'ours')?.scope).toBe('project');
    expect(pack.heuristics.map((p) => p.topicKey)).toEqual(['prefer']);
    expect(pack.dropped).toEqual({ policies: 0, heuristics: 0, decisions: 0 });
  });

  it.each([
    {
      name: 'an area belief and a project policy with one key',
      principles: [rule('k', 'belief', 'area', 'api'), rule('k', 'policy')],
      policies: ['project'],
      heuristics: [],
    },
    {
      name: 'a project belief and a heuristic of yours with one key',
      principles: [rule('k', 'belief'), rule('k', 'heuristic', 'you')],
      policies: [],
      heuristics: ['you'],
    },
  ])('never lets a belief hide a rule: $name', ({ principles, policies, heuristics }) => {
    const pack = packKnowledge(input({ principles }));
    expect(pack.policies.map((p) => p.scope)).toEqual(policies);
    expect(pack.heuristics.map((p) => p.scope)).toEqual(heuristics);
  });

  it('orders decisions: area hits, other hits by rank, then area decisions without a hit', () => {
    const projectHit = decided('Which queue?');
    const areaHit = decided('Which router?', 'area', 'api');
    const areaOther = decided('Which validator?', 'area', 'api');
    const uiHit = decided('Which icons?', 'area', 'ui');
    const unrelated = decided('Which font?');
    const pack = packKnowledge(
      input({
        decisions: [unrelated, uiHit, areaOther, areaHit, projectHit],
        ranked: [projectHit.id, uiHit.id, areaHit.id],
      }),
    );
    expect(pack.decisions.map((d) => d.question)).toEqual([
      'Which router?',
      'Which queue?',
      'Which validator?',
    ]);
  });

  it('falls back to the newest decisions that apply when nothing matches the task', () => {
    const decisions = Array.from({ length: 7 }, (_, i) => decided(`Q${String(i)}`));
    const pack = packKnowledge(
      input({ decisions: [decided('UI only', 'area', 'ui'), ...decisions] }),
    );
    expect(pack.decisions.map((d) => d.question)).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4']);
  });

  it('keeps the newest decisions in the fallback when an area decision also applies', () => {
    const newer = Array.from({ length: 7 }, (_, i) => decided(`Q${String(i)}`));
    const mine = decided('Mine', 'you');
    const pack = packKnowledge(
      input({ decisions: [mine, ...newer, decided('Which router?', 'area', 'api')] }),
    );
    expect(pack.decisions.map((d) => d.question)).toEqual([
      'Which router?',
      'Mine',
      'Q0',
      'Q1',
      'Q2',
      'Q3',
    ]);
    expect(pack.dropped.decisions).toBe(0);
  });

  it('counts as nothing matching when the only hits do not apply to the task', () => {
    const uiHit = decided('Which icons?', 'area', 'ui');
    const areaOther = decided('Which validator?', 'area', 'api');
    const newest = decided('Which queue?');
    const pack = packKnowledge(
      input({ decisions: [newest, uiHit, areaOther], ranked: [uiHit.id] }),
    );
    expect(pack.decisions.map((d) => d.question)).toEqual(['Which validator?', 'Which queue?']);
  });

  it.each([
    {
      name: 'a policy longer than the budget is skipped and the next one still fits',
      principles: [rule('big', 'policy', 'project', null, 'x'.repeat(400)), rule('small')],
      budget: 50,
      kept: ['small'],
      dropped: { policies: 1, heuristics: 0, decisions: 0 },
    },
    {
      name: 'policies fill the budget first and heuristics are counted as dropped',
      principles: [
        rule('a', 'policy', 'project', null, 'x'.repeat(150)),
        rule('b', 'heuristic', 'project', null, 'y'.repeat(150)),
      ],
      budget: 60,
      kept: ['a'],
      dropped: { policies: 0, heuristics: 1, decisions: 0 },
    },
    {
      name: 'a zero budget drops everything and says so',
      principles: [rule('a'), rule('b', 'heuristic')],
      budget: 0,
      kept: [],
      dropped: { policies: 1, heuristics: 1, decisions: 0 },
    },
  ])('fills the budget greedily: $name', ({ principles, budget, kept, dropped }) => {
    const pack = packKnowledge(input({ principles, budgetTokens: budget }));
    expect([...pack.policies, ...pack.heuristics].map((p) => p.topicKey)).toEqual(kept);
    expect(pack.dropped).toEqual(dropped);
    expect(pack.usedTokens).toBeLessThanOrEqual(budget);
    expect(pack.usedTokens).toBe(
      [...pack.policies, ...pack.heuristics].reduce((n, p) => n + principleTokens(p), 0) +
        pack.decisions.reduce((n, d) => n + decisionTokens(d), 0),
    );
  });

  it('is deterministic whatever order the rows arrive in', () => {
    const principles = [rule('b'), rule('a'), rule('c', 'heuristic'), rule('a', 'policy', 'you')];
    const decisions = [decided('One'), decided('Two')];
    const ranked: DecisionId[] = decisions.map((d) => d.id);
    const first = packKnowledge(input({ principles, decisions, ranked }));
    expect(
      packKnowledge(input({ principles: principles.toReversed(), decisions, ranked })),
    ).toEqual(first);
    expect(first.policies.map((p) => p.topicKey)).toEqual(['a', 'b']);
  });
});
