import type { GateFix } from './gate-fix';
import { firstWorryingLine, type GateStepFailure } from './gate-failures';

/**
 * What a failed ship gate failed on: the sorted, de-duplicated `<step>\0<file>\0<test name>` lines of its
 * failing tests (a failing step that names none adds `<step>` alone) when any step names a test, else the
 * first worrying line of its output. The error line is left out, so the same tests failing another way are
 * the same failure. Null when neither a step with tests nor a worrying tail line could be read; null equals
 * nothing.
 */
export function failureSignature(steps: readonly GateStepFailure[], tail: string): string | null {
  if (!steps.some((step) => step.tests.length > 0)) return firstWorryingLine(tail);
  const lines = new Set<string>();
  for (const step of steps) {
    if (step.tests.length === 0) lines.add(step.name);
    for (const test of step.tests) lines.add(`${step.name}\0${test.file}\0${test.name ?? ''}`);
  }
  return [...lines].sort().join('\n');
}

export const OutOfMovesReason = {
  Budget: 'budget',
  SameFailure: 'same_failure',
  OutsideTwice: 'outside_twice',
} as const;
export type OutOfMovesReason = (typeof OutOfMovesReason)[keyof typeof OutOfMovesReason];

export type GateFailureAction =
  | { readonly kind: 'rerun' }
  | { readonly kind: 'legacy_card' }
  | { readonly kind: 'fix' }
  | { readonly kind: 'out_of_moves'; readonly reason: OutOfMovesReason };

/** What 10db does about a batch's failed ship gate: rerun it, file a fix task, or ask the builder. */
export function gateFailureAction(input: {
  /** The failure lies outside the batch's change. */
  readonly outside: boolean;
  /** This ship attempt already ran the gate a second time. */
  readonly reran: boolean;
  /** Not a pass batch, not a local-copy batch. */
  readonly eligible: boolean;
  readonly signature: string | null;
  readonly fix: GateFix;
}): GateFailureAction {
  // The order is the rule: the first case that matches wins.
  if (input.outside && !input.reran) return { kind: 'rerun' };
  if (!input.eligible) return { kind: 'legacy_card' };
  if (input.outside && input.reran && !input.fix.forceInside) {
    return { kind: 'out_of_moves', reason: OutOfMovesReason.OutsideTwice };
  }
  if (input.fix.signature !== null && input.fix.signature === input.signature) {
    return { kind: 'out_of_moves', reason: OutOfMovesReason.SameFailure };
  }
  if (input.fix.count >= input.fix.allowed) {
    return { kind: 'out_of_moves', reason: OutOfMovesReason.Budget };
  }
  return { kind: 'fix' };
}
