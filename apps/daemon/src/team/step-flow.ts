import { StepRole, StepStatus, Verdict, type WorkstreamStep } from '@10db/contracts';

type StepMove =
  | { readonly kind: 'advance'; readonly to: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'send_back'; readonly to: number }
  | { readonly kind: 'no_result' };

/** Where a rejection goes: a plan review back to the plan, review and QA back to the implement step. */
function sendBackTarget(steps: readonly WorkstreamStep[], index: number): number {
  const want = steps[index]?.role === StepRole.PlanReview ? StepRole.Plan : StepRole.Implement;
  for (let i = index - 1; i >= 0; i -= 1) if (steps[i]?.role === want) return i;
  return index;
}

/** What follows a finished step (spec §5.4). An implement step is finished once its gate passed. */
export function moveAfter(steps: readonly WorkstreamStep[], index: number): StepMove {
  const step = steps[index];
  if (!step) return { kind: 'done' };
  if (step.role !== StepRole.Implement) {
    if (!step.result) return { kind: 'no_result' };
    if (step.result.verdict === Verdict.Reject)
      return { kind: 'send_back', to: sendBackTarget(steps, index) };
  }
  return index + 1 < steps.length ? { kind: 'advance', to: index + 1 } : { kind: 'done' };
}

/** When a step is entered, and how many sessions the workstream had run by then. */
export interface StepEntry {
  readonly now: string;
  readonly sessions: number;
}

const entered = (s: WorkstreamStep, entry: StepEntry): WorkstreamStep => ({
  ...s,
  status: StepStatus.Running,
  result: null,
  startedAt: entry.now,
  sessionFloor: entry.sessions,
});

/** `to` of -1 finishes the last step without starting another. */
export function advanceSteps(
  steps: readonly WorkstreamStep[],
  from: number,
  to: number,
  entry: StepEntry,
): WorkstreamStep[] {
  return steps.map((s, i) => {
    if (i === from) return { ...s, status: StepStatus.Done };
    if (i === to) return entered(s, entry);
    return s;
  });
}

/** The rejecting step keeps its notes for the rework; the target restarts with one more attempt. */
export function sendBackSteps(
  steps: readonly WorkstreamStep[],
  from: number,
  to: number,
  target: WorkstreamStep,
  entry: StepEntry,
): WorkstreamStep[] {
  return steps.map((s, i) => {
    if (i === from) return { ...s, status: StepStatus.Pending };
    if (i === to) return { ...entered(target, entry), attempts: s.attempts + 1 };
    return s;
  });
}

/** A retried workstream restarts its current step clean (no stale verdict, no counted attempts) in the same step. */
export function restartStep(
  steps: readonly WorkstreamStep[],
  index: number,
  now: string,
): WorkstreamStep[] {
  return steps.map((s, i) =>
    i === index
      ? { ...s, status: StepStatus.Running, attempts: 0, result: null, startedAt: now }
      : s,
  );
}

/** Marks the current step failed when its workstream fails. */
export function failStep(steps: readonly WorkstreamStep[], index: number): WorkstreamStep[] {
  return steps.map((s, i) => (i === index ? { ...s, status: StepStatus.Failed } : s));
}
