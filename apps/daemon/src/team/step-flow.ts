import { StepRole, StepStatus, ToolAccess, Verdict, type WorkstreamStep } from '@10db/contracts';

type StepMove =
  | { readonly kind: 'advance'; readonly to: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'send_back'; readonly to: number }
  | { readonly kind: 'no_result' };

/** Where a rejection goes: a plan review back to the plan, review and QA back to the implement step. */
export function sendBackTarget(steps: readonly WorkstreamStep[], index: number): number {
  const want = steps[index]?.role === StepRole.PlanReview ? StepRole.Plan : StepRole.Implement;
  for (let i = index - 1; i >= 0; i -= 1) if (steps[i]?.role === want) return i;
  return index;
}

/**
 * Where a retry sends the work when a reviewer's rejection failed the workstream: the step the
 * rejection goes back to, since reviewing the same code again would reject it again. Null for any
 * other failure, and when no earlier step can do the rework.
 */
export function retryTargetAfterRejection(
  steps: readonly WorkstreamStep[],
  index: number,
): number | null {
  const step = steps[index];
  if (
    !step ||
    step.role === StepRole.Implement ||
    step.status !== StepStatus.Failed ||
    step.result?.verdict !== Verdict.Reject
  )
    return null;
  const to = sendBackTarget(steps, index);
  return to === index ? null : to;
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

/**
 * A step that runs again drops its result. One that gave a verdict is filed in `earlier` first, so
 * the builder can read every round a reviewer gave, not only the latest.
 */
const withResultFiled = (s: WorkstreamStep): WorkstreamStep =>
  s.result?.verdict ? { ...s, earlier: [...s.earlier, s.result] } : s;

const entered = (s: WorkstreamStep, entry: StepEntry): WorkstreamStep => ({
  ...withResultFiled(s),
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

/**
 * The rejecting step keeps its notes for the rework; the target restarts with one more attempt. A
 * read-only target keeps its previous result, so it can see what the reviewer judged; the runner
 * accepts only a result a later session recorded.
 */
export function sendBackSteps(
  steps: readonly WorkstreamStep[],
  from: number,
  to: number,
  target: WorkstreamStep,
  entry: StepEntry,
): WorkstreamStep[] {
  return steps.map((s, i) => {
    // A step that sends the work back to itself restarts rather than waiting.
    if (i === to) {
      const restarted = { ...entered(target, entry), attempts: s.attempts + 1 };
      // A read-only target keeps its result, which is still its latest, so nothing is filed.
      return target.tools === ToolAccess.ReadOnly
        ? { ...restarted, result: target.result, earlier: target.earlier }
        : restarted;
    }
    if (i === from) return { ...s, status: StepStatus.Pending };
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
      ? {
          ...withResultFiled(s),
          status: StepStatus.Running,
          attempts: 0,
          result: null,
          startedAt: now,
        }
      : s,
  );
}

/** Marks the current step failed when its workstream fails. */
export function failStep(steps: readonly WorkstreamStep[], index: number): WorkstreamStep[] {
  return steps.map((s, i) => (i === index ? { ...s, status: StepStatus.Failed } : s));
}
