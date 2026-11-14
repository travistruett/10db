import { EvidenceKind, StepRole, type EvidenceDto, type KindDto } from '@10db/contracts';

/** Steps that judge built work; a plan review judges a plan, and nothing is built to ship yet. */
const JUDGES_BUILT_WORK: readonly StepRole[] = [StepRole.Review, StepRole.Qa];

/**
 * Whether a rejection that uses up the retry limit ships the work and files its findings as a
 * follow-up task, instead of failing the task. Only a review or QA rejection of an ordinary task
 * does, and only when the latest gate run passed; a project with no gate has no run to fail.
 */
export function shipsAtRetryLimit(input: {
  /** The step that rejected the work. */
  readonly role: StepRole;
  /** The kinds the task has: one that fails at the limit means a rejection there still fails the task. */
  readonly kinds: readonly Pick<KindDto, 'failsAtLimit'>[];
  /** The workstream's evidence, oldest first. */
  readonly evidence: readonly Pick<EvidenceDto, 'kind' | 'exitCode'>[];
}): boolean {
  if (!JUDGES_BUILT_WORK.includes(input.role)) return false;
  if (input.kinds.some((kind) => kind.failsAtLimit)) return false;
  const latestGate = input.evidence.filter((e) => e.kind === EvidenceKind.Gate).at(-1);
  return latestGate === undefined || latestGate.exitCode === 0;
}
