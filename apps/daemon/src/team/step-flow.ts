import {
  retryTargetAfterRejection,
  sendBackTarget,
  StepRole,
  StepStatus,
  ToolAccess,
  Verdict,
  type WorkstreamStep,
} from '@10db/contracts';

// The desktop says what Retry will do from the same rules, so they live in contracts.
export { retryTargetAfterRejection, sendBackTarget };

type StepMove =
  | { readonly kind: 'advance'; readonly to: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'send_back'; readonly to: number }
  | { readonly kind: 'no_result' };

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

/**
 * A retried workstream restarts its current step clean (no stale verdict, no counted attempts, no counted
 * endings without a verdict) in the same step. `sessions` is how many sessions the workstream has run.
 * It keeps `sessionFloor`, so the step still finds its own handoffs from before the retry.
 */
export function restartStep(
  steps: readonly WorkstreamStep[],
  index: number,
  now: string,
  sessions: number,
): WorkstreamStep[] {
  return steps.map((s, i) =>
    i === index
      ? {
          ...withResultFiled(s),
          status: StepStatus.Running,
          attempts: 0,
          result: null,
          startedAt: now,
          retryFloor: sessions,
        }
      : s,
  );
}

/**
 * One more send-back on the step whose rejection sent the work back, for the board's count, with the
 * review rounds the rigor allows now.
 */
export function countSendBack(
  steps: readonly WorkstreamStep[],
  from: number,
  reviewRounds: number,
): WorkstreamStep[] {
  return steps.map((s, i) => (i === from ? { ...s, sentBack: s.sentBack + 1, reviewRounds } : s));
}

/** A retry starts the attempts over, so no earlier send-back counts any more; the rounds stay. */
export function clearSendBacks(steps: readonly WorkstreamStep[]): WorkstreamStep[] {
  return steps.map((s) => (s.sentBack === 0 ? s : { ...s, sentBack: 0 }));
}

/** Marks the current step failed when its workstream fails. */
export function failStep(steps: readonly WorkstreamStep[], index: number): WorkstreamStep[] {
  return steps.map((s, i) => (i === index ? { ...s, status: StepStatus.Failed } : s));
}

/**
 * A step the builder's retry restarts: its fix is a fresh session that owes no step up for a send-back
 * that meant to resume the step's own session.
 */
export function withoutFixFresh(step: WorkstreamStep): WorkstreamStep {
  const { fixFresh, ...rest } = step;
  return fixFresh === undefined ? step : rest;
}
