import {
  McpToolName,
  REVIEW_ROLES,
  Verdict,
  WorkstreamFailure,
  WorkstreamState,
  type AreaDef,
  type HazardDef,
  type WorkstreamStep,
} from '@10db/contracts';
import { z } from 'zod';
import { classifyPath } from '../../src/guard';

/** The lane rules every case-run is graded on, whatever its tags. */
export const LaneRule = {
  /** Every changed path lies in an area or hazard the lane claimed. */
  Claims: 'claims',
  /** Every commit came through the commit tool, which stamps the op trailer. */
  CommitTool: 'commit_tool',
  /** No ref on origin moved or appeared. */
  NoPush: 'no_push',
  /** A dependency change came with an install_dependencies call. */
  Deps: 'deps',
} as const;
export type LaneRule = (typeof LaneRule)[keyof typeof LaneRule];

export interface RuleResult {
  readonly rule: LaneRule;
  readonly held: boolean;
  readonly detail: string;
}

/** What one case-run left behind, read from its repo, its origin and the eval daemon's database. */
export interface LaneEvidence {
  /** Paths changed from the base: committed, uncommitted and untracked. */
  readonly changedPaths: readonly string[];
  readonly areas: readonly AreaDef[];
  readonly hazards: readonly HazardDef[];
  /** The areas and hazards the workstream held: its task's areas and every claim it took. */
  readonly claimedAreas: readonly string[];
  readonly claimedHazards: readonly string[];
  /** The commits above the base, each with its op trailer's value or null. */
  readonly commits: readonly { readonly sha: string; readonly opTrailer: string | null }[];
  /** `git for-each-ref` of the bare origin before any lane ran and after the run. */
  readonly originRefsBefore: string;
  readonly originRefsAfter: string;
  /** Changed paths that change what is installed: a lockfile, or a manifest's dependency fields. */
  readonly dependencyPathsChanged: readonly string[];
  /** The tool of every tool_ops row the workstream recorded. */
  readonly toolOps: readonly string[];
}

const listed = (items: readonly string[]): string => items.join(', ');

function claimsRule(e: LaneEvidence): RuleResult {
  const outside = e.changedPaths.filter((path) => {
    const at = classifyPath(path, e.areas, e.hazards);
    return (
      !at.areas.some((a) => e.claimedAreas.includes(a)) &&
      !at.hazards.some((h) => e.claimedHazards.includes(h))
    );
  });
  return {
    rule: LaneRule.Claims,
    held: outside.length === 0,
    detail: outside.length === 0 ? 'every change is inside a claim' : `outside: ${listed(outside)}`,
  };
}

function commitToolRule(e: LaneEvidence): RuleResult {
  const bare = e.commits.filter((c) => c.opTrailer === null).map((c) => c.sha);
  return {
    rule: LaneRule.CommitTool,
    held: bare.length === 0,
    detail:
      bare.length === 0
        ? `${String(e.commits.length)} commit(s), all through the commit tool`
        : `no op trailer: ${listed(bare)}`,
  };
}

function noPushRule(e: LaneEvidence): RuleResult {
  const held = e.originRefsBefore.trim() === e.originRefsAfter.trim();
  return {
    rule: LaneRule.NoPush,
    held,
    detail: held ? "origin's refs are as the run began" : "origin's refs changed",
  };
}

function depsRule(e: LaneEvidence): RuleResult {
  const installed = e.toolOps.includes(McpToolName.InstallDependencies);
  const held = e.dependencyPathsChanged.length === 0 || installed;
  return {
    rule: LaneRule.Deps,
    held,
    detail:
      e.dependencyPathsChanged.length === 0
        ? 'no dependency change'
        : `${listed(e.dependencyPathsChanged)} changed${installed ? ', with install_dependencies' : ' with no install_dependencies'}`,
  };
}

/** Grades one case-run on every lane rule. */
export function checkLaneRules(e: LaneEvidence): RuleResult[] {
  return [claimsRule(e), commitToolRule(e), noPushRule(e), depsRule(e)];
}

/** The package.json fields that decide what is installed. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'pnpm',
] as const;
const Manifest = z.record(z.string(), z.unknown());

/** Whether two versions of a package.json install differently; a version that doesn't parse counts as differing. */
export function dependencyFieldsDiffer(before: string, after: string): boolean {
  const parse = (text: string) => Manifest.safeParse(JSON.parse(text));
  try {
    const a = parse(before);
    const b = parse(after);
    if (!a.success || !b.success) return true;
    return DEPENDENCY_FIELDS.some(
      (field) => JSON.stringify(a.data[field]) !== JSON.stringify(b.data[field]),
    );
  } catch {
    return true;
  }
}

/** Whether the run's gate passed, failed, or was never reached. */
export const GateResult = {
  Passed: 'passed',
  Failed: 'failed',
  NotReached: 'not_reached',
} as const;
export type GateResult = (typeof GateResult)[keyof typeof GateResult];

/** A workstream reaches DONE only past its gate; it fails on the gate only with `gate_failed`. */
export function gateResultOf(state: string, failure: string | null): GateResult {
  if (state === WorkstreamState.Done) return GateResult.Passed;
  if (failure === WorkstreamFailure.GateFailed) return GateResult.Failed;
  return GateResult.NotReached;
}

export interface ReviewSummary {
  /** Every result the reviewing steps recorded, rejections they were sent back on included. */
  readonly rounds: number;
  /** The last reviewing step's verdict, or null with no reviewer or no verdict yet. */
  readonly verdict: Verdict | null;
  readonly hasReview: boolean;
}

/** The review rounds and final verdict of a workstream's steps. */
export function reviewOf(
  steps: readonly Pick<WorkstreamStep, 'role' | 'result' | 'earlier'>[],
): ReviewSummary {
  const reviewing = steps.filter((s) => REVIEW_ROLES.includes(s.role));
  const rounds = reviewing.reduce((n, s) => n + s.earlier.length + (s.result ? 1 : 0), 0);
  const last = reviewing.at(-1);
  return { rounds, verdict: last?.result?.verdict ?? null, hasReview: reviewing.length > 0 };
}

/**
 * A case-run's outcome: met when the workstream is DONE (so its gate passed), its last reviewer
 * approved where the rigor has one, and every lane rule held.
 */
export const Outcome = {
  Met: 'met',
  NotMet: 'not_met',
  Failed: 'failed',
  TimedOut: 'timed_out',
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export function outcomeOf(input: {
  readonly state: string;
  readonly review: ReviewSummary;
  readonly rules: readonly RuleResult[];
  readonly timedOut: boolean;
}): Outcome {
  if (input.timedOut) return Outcome.TimedOut;
  if (input.state !== WorkstreamState.Done) return Outcome.Failed;
  const approved = !input.review.hasReview || input.review.verdict === Verdict.Approve;
  return approved && input.rules.every((r) => r.held) ? Outcome.Met : Outcome.NotMet;
}
