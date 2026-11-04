import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  decisionProposal,
  goalProposal,
  landingProposal,
  looseTaskProposal,
  questionProposal,
} from '../../test/shape-fixtures';
import { groupProposals, summaryParts } from './proposed-groups';

// Shape spec §4: the Proposed list's sections and the summary line over it.

const keys = (rows: readonly { readonly key: string }[]): string[] => rows.map((r) => r.key);

const converted = {
  state: 'accepted' as const,
  converted: { goalId: null, taskIds: [], decisionId: null },
};

describe('groupProposals', () => {
  it('sorts rows into their sections, leaving superseded ones under Earlier and dropping dropped ones', () => {
    const groups = groupProposals([
      goalProposal('brainstorm'),
      looseTaskProposal('density'),
      looseTaskProposal('late', { goalId: mintId('Goal') }),
      decisionProposal('replaces-adopt'),
      questionProposal('ship-date'),
      landingProposal('real-areas', ['density']),
      looseTaskProposal('old', { state: 'superseded' }),
      looseTaskProposal('dropped', { state: 'rejected' }),
    ]);
    expect({
      goals: keys(groups.goals),
      loose: keys(groups.looseTasks),
      records: keys(groups.records),
      questions: keys(groups.questions),
      landings: keys(groups.landings),
      earlier: keys(groups.earlier),
    }).toEqual({
      goals: ['brainstorm'],
      loose: ['density', 'late'],
      records: ['replaces-adopt'],
      questions: ['ship-date'],
      landings: ['real-areas'],
      earlier: ['old'],
    });
  });

  it('keeps converted rows in their sections', () => {
    const groups = groupProposals([
      looseTaskProposal('density', {
        state: 'accepted',
        converted: { goalId: null, taskIds: [], decisionId: null },
      }),
    ]);
    expect(keys(groups.looseTasks)).toEqual(['density']);
  });
});

describe('summaryParts', () => {
  const parts = (...rows: Parameters<typeof groupProposals>[0]) =>
    summaryParts(groupProposals(rows)).map((p) => p.text);

  it.each([
    ['one goal', [goalProposal('g')], ['1 goal']],
    ['two goals', [goalProposal('g'), goalProposal('h')], ['2 goals']],
    [
      'a goal, loose tasks and records',
      [
        goalProposal('g'),
        looseTaskProposal('a'),
        looseTaskProposal('b'),
        looseTaskProposal('c'),
        decisionProposal('d'),
        decisionProposal('e'),
      ],
      ['1 goal', '3 loose', '2 to record'],
    ],
    ['a question for others', [questionProposal('q')], ['1 question']],
    ['landings as pull requests', [landingProposal('l', ['a'])], ['1 pull request']],
    [
      'converted rows counted apart',
      [
        goalProposal('g', ['t'], {
          state: 'accepted',
          converted: { goalId: null, taskIds: [], decisionId: null },
        }),
        looseTaskProposal('a'),
      ],
      ['1 loose', '1 converted'],
    ],
    ['a changed converted task', [looseTaskProposal('x', { state: 'superseded' })], []],
  ])('says %s', (_, rows, expected) => {
    expect(parts(...rows)).toEqual(expected);
  });

  it('points each count at its section', () => {
    const [part] = summaryParts(groupProposals([goalProposal('g')]));
    expect(part?.section).toBe('goals');
  });

  it.each([
    ['loose tasks', [looseTaskProposal('a', converted), looseTaskProposal('b', converted)]],
    ['a goal', [goalProposal('g', ['t'], converted)]],
    ['a decision', [decisionProposal('d', converted)]],
  ])('points the converted count at the converted rows, for %s', (_, rows) => {
    const part = summaryParts(groupProposals(rows)).find((p) => p.text.endsWith('converted'));
    expect(part?.section).toBe('converted');
  });
});
