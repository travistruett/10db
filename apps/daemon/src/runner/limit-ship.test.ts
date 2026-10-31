import { EvidenceKind, RiskTag, StepRole, type EvidenceDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { shipsAtRetryLimit } from './limit-ship';

type Run = Pick<EvidenceDto, 'kind' | 'exitCode'>;

const gate = (exitCode: number): Run => ({ kind: EvidenceKind.Gate, exitCode });
const builder: Run = { kind: EvidenceKind.Builder, exitCode: null };
const review = StepRole.Review;

describe('shipsAtRetryLimit', () => {
  it('ships an ordinary task whose latest gate passed', () => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [], evidence: [gate(1), gate(0)] })).toBe(
      true,
    );
  });

  it('ships on a QA rejection too', () => {
    expect(shipsAtRetryLimit({ role: StepRole.Qa, riskTags: [], evidence: [gate(0)] })).toBe(true);
  });

  it.each([StepRole.PlanReview, StepRole.Plan, StepRole.Implement])(
    'fails on a rejection by the %s step, which has no built work to ship',
    (role) => {
      expect(shipsAtRetryLimit({ role, riskTags: [], evidence: [gate(0)] })).toBe(false);
    },
  );

  it('ships a task in a project with no gate, which has no gate run to fail', () => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [], evidence: [builder] })).toBe(true);
  });

  it('judges the latest gate only, and ignores the builder notes after it', () => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [], evidence: [gate(0), builder] })).toBe(
      true,
    );
    expect(
      shipsAtRetryLimit({ role: review, riskTags: [], evidence: [gate(0), gate(2), builder] }),
    ).toBe(false);
  });

  it('fails a task whose latest gate failed', () => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [], evidence: [gate(0), gate(1)] })).toBe(
      false,
    );
  });

  it.each([RiskTag.Security, RiskTag.Auth])('fails a task tagged %s', (tag) => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [tag], evidence: [gate(0)] })).toBe(false);
  });

  it.each([RiskTag.Migration, RiskTag.Dependency])('ships a task tagged %s', (tag) => {
    expect(shipsAtRetryLimit({ role: review, riskTags: [tag], evidence: [gate(0)] })).toBe(true);
  });
});
