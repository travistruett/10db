import { StepRole, StepStatus, type WorkstreamStep } from '@10db/contracts';

const ROLE_ORDER: readonly StepRole[] = Object.values(StepRole);

/** A step that has run or been started is history, and a re-plan never drops or rewrites it. */
function hasRun(step: WorkstreamStep): boolean {
  return (
    step.status !== StepStatus.Pending ||
    step.result !== null ||
    step.earlier.length > 0 ||
    step.startedAt !== null
  );
}

/**
 * The steps of a started task once its rigor or playbook changed, `planned` being what the task would run now.
 * The step at `stepIndex` and every step before it stay as they are. After it, every step that has run stays
 * (the reviewer whose rejection sent the work back, which a pending fix points at), and the steps still to
 * come are replaced by the planned steps whose role follows the current step's and that no kept step already
 * plays, each newly routed.
 */
export function replanSteps(
  steps: readonly WorkstreamStep[],
  stepIndex: number,
  planned: readonly WorkstreamStep[],
): WorkstreamStep[] {
  const current = steps[stepIndex];
  if (current === undefined) return [...steps];
  const kept = steps.slice(stepIndex + 1).filter(hasRun);
  const taken = new Set<StepRole>([...steps.slice(0, stepIndex + 1), ...kept].map((s) => s.role));
  const after = ROLE_ORDER.indexOf(current.role);
  const added = planned.filter((s) => ROLE_ORDER.indexOf(s.role) > after && !taken.has(s.role));
  const rest = [...kept, ...added].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
  return [...steps.slice(0, stepIndex + 1), ...rest];
}
