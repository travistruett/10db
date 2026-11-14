import { JudgeDecision } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DECISIONS, DecisionGroup, groupedDecisions } from './decision-catalogue';

describe('DECISIONS', () => {
  it.each(Object.values(JudgeDecision))('%s has a group, a label and its words', (decision) => {
    const entry = DECISIONS[decision];
    expect(entry.group).not.toBe('');
    for (const text of [
      entry.label,
      entry.asks,
      entry.onAnswer,
      entry.whenUnsure,
      entry.fellBack,
    ]) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe('groupedDecisions', () => {
  it('groups every decision in order and leaves out the group with no rows', () => {
    expect(groupedDecisions(Object.values(JudgeDecision))).toEqual([
      { group: DecisionGroup.Delivery, decisions: [JudgeDecision.ReviewSize] },
      {
        group: DecisionGroup.Sizing,
        decisions: [JudgeDecision.TaskRigor, JudgeDecision.TaskKinds],
      },
      {
        group: DecisionGroup.Plan,
        decisions: [
          JudgeDecision.ShapeReady,
          JudgeDecision.ShapeRecord,
          JudgeDecision.ShapeElsewhere,
        ],
      },
      {
        group: DecisionGroup.Stakeholders,
        decisions: [
          JudgeDecision.QuestionRoute,
          JudgeDecision.ThreadAnswer,
          JudgeDecision.ReplyMatch,
          JudgeDecision.ApprovalRead,
        ],
      },
    ]);
  });

  it('has no Delivery group when the daemon no longer configures review_size', () => {
    const without = Object.values(JudgeDecision).filter((d) => d !== JudgeDecision.ReviewSize);
    expect(groupedDecisions(without).map((g) => g.group)).toEqual([
      DecisionGroup.Sizing,
      DecisionGroup.Plan,
      DecisionGroup.Stakeholders,
    ]);
  });
});
