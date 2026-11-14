import { EvidenceKind, StepRole, type EvidenceDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { shipsAtRetryLimit } from './limit-ship';

type Run = Pick<EvidenceDto, 'kind' | 'exitCode'>;

const gate = (exitCode: number): Run => ({ kind: EvidenceKind.Gate, exitCode });
const builder: Run = { kind: EvidenceKind.Builder, exitCode: null };
const review = StepRole.Review;

describe('shipsAtRetryLimit', () => {
  it('ships an ordinary task whose latest gate passed', () => {
    expect(shipsAtRetryLimit({ role: review, kinds: [], evidence: [gate(1), gate(0)] })).toBe(true);
  });

  it('ships on a QA rejection too', () => {
    expect(shipsAtRetryLimit({ role: StepRole.Qa, kinds: [], evidence: [gate(0)] })).toBe(true);
  });

  it.each([StepRole.PlanReview, StepRole.Plan, StepRole.Implement])(
    'fails on a rejection by the %s step, which has no built work to ship',
    (role) => {
      expect(shipsAtRetryLimit({ role, kinds: [], evidence: [gate(0)] })).toBe(false);
    },
  );

  it('ships a task in a project with no gate, which has no gate run to fail', () => {
    expect(shipsAtRetryLimit({ role: review, kinds: [], evidence: [builder] })).toBe(true);
  });

  it('judges the latest gate only, and ignores the builder notes after it', () => {
    expect(shipsAtRetryLimit({ role: review, kinds: [], evidence: [gate(0), builder] })).toBe(true);
    expect(
      shipsAtRetryLimit({ role: review, kinds: [], evidence: [gate(0), gate(2), builder] }),
    ).toBe(false);
  });

  it('fails a task whose latest gate failed', () => {
    expect(shipsAtRetryLimit({ role: review, kinds: [], evidence: [gate(0), gate(1)] })).toBe(
      false,
    );
  });

  it('fails a task with a kind that fails at the limit, among others', () => {
    expect(
      shipsAtRetryLimit({
        role: review,
        kinds: [{ failsAtLimit: false }, { failsAtLimit: true }],
        evidence: [gate(0)],
      }),
    ).toBe(false);
  });

  it('ships a task whose kinds do not fail at the limit', () => {
    expect(
      shipsAtRetryLimit({ role: review, kinds: [{ failsAtLimit: false }], evidence: [gate(0)] }),
    ).toBe(true);
  });
});
