import { StepRole, StepStatus, Verdict } from './states';
import type { WorkstreamStep } from './steps';

/** Where a rejection goes: a plan review back to the plan, review and QA back to the implement step. */
export function sendBackTarget(steps: readonly WorkstreamStep[], index: number): number {
  const want = steps[index]?.role === StepRole.PlanReview ? StepRole.Plan : StepRole.Implement;
  for (let i = index - 1; i >= 0; i -= 1) if (steps[i]?.role === want) return i;
  return index;
}

/**
 * Where a retry sends the work when a reviewer's rejection failed the workstream: the step the
 * rejection goes back to, since reviewing the same code again would reject it again. Null for any
 * other failure, and when no earlier step can do the rework. The daemon's retry and the desktop's
 * account of what Retry will do both read it.
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
