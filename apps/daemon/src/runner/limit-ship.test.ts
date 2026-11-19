import { EvidenceKind, StepRole, type EvidenceDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { shipsAtRetryLimit } from './limit-ship';

type Run = Pick<EvidenceDto, 'kind' | 'exitCode'>;

const gate = (exitCode: number): Run => ({ kind: EvidenceKind.Gate, exitCode });
const builder: Run = { kind: EvidenceKind.Builder, exitCode: null };
const review = StepRole.Review;

describe('shipsAtRetryLimit', () => {
  it('ships built work at the limit only when its latest gate passed and none of its kinds fails at the limit', () => {
    const rows: [string, Parameters<typeof shipsAtRetryLimit>[0], boolean][] = [
      [
        'ships an ordinary task whose latest gate passed',
        { role: review, kinds: [], evidence: [gate(1), gate(0)] },
        true,
      ],
      ['ships on a QA rejection too', { role: StepRole.Qa, kinds: [], evidence: [gate(0)] }, true],
      ...[StepRole.PlanReview, StepRole.Plan, StepRole.Implement].map(
        (role): [string, Parameters<typeof shipsAtRetryLimit>[0], boolean] => [
          `fails on a rejection by the ${role} step, which has no built work to ship`,
          { role, kinds: [], evidence: [gate(0)] },
          false,
        ],
      ),
      [
        'ships a task in a project with no gate, which has no gate run to fail',
        { role: review, kinds: [], evidence: [builder] },
        true,
      ],
      [
        'judges the latest gate only, and ignores the builder notes after it (passed)',
        { role: review, kinds: [], evidence: [gate(0), builder] },
        true,
      ],
      [
        'judges the latest gate only, and ignores the builder notes after it (failed)',
        { role: review, kinds: [], evidence: [gate(0), gate(2), builder] },
        false,
      ],
      [
        'fails a task whose latest gate failed',
        { role: review, kinds: [], evidence: [gate(0), gate(1)] },
        false,
      ],
      [
        'fails a task with a kind that fails at the limit, among others',
        {
          role: review,
          kinds: [{ failsAtLimit: false }, { failsAtLimit: true }],
          evidence: [gate(0)],
        },
        false,
      ],
      [
        'ships a task whose kinds do not fail at the limit',
        { role: review, kinds: [{ failsAtLimit: false }], evidence: [gate(0)] },
        true,
      ],
    ];
    for (const [name, input, ships] of rows) {
      expect.soft(shipsAtRetryLimit(input), name).toBe(ships);
    }
  });
});
