import { EvidenceKind, RiskTag, StepRole, type EvidenceDto } from '@10db/contracts';

/** Risks whose work must not ship with a finding left open: a rejection at the limit still fails it. */
const NEVER_SHIPS_OPEN: readonly RiskTag[] = [RiskTag.Security, RiskTag.Auth];

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
  readonly riskTags: readonly RiskTag[];
  /** The workstream's evidence, oldest first. */
  readonly evidence: readonly Pick<EvidenceDto, 'kind' | 'exitCode'>[];
}): boolean {
  if (!JUDGES_BUILT_WORK.includes(input.role)) return false;
  if (input.riskTags.some((tag) => NEVER_SHIPS_OPEN.includes(tag))) return false;
  const latestGate = input.evidence.filter((e) => e.kind === EvidenceKind.Gate).at(-1);
  return latestGate === undefined || latestGate.exitCode === 0;
}
