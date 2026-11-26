import { delimiter, join } from 'node:path';
import type { LaneBrief } from '../../src/briefing';
import { equalOrUnder } from '../../src/git';

/** Variables that must not reach the eval daemon: the builder's own TENDB_* settings and billing switches. */
const DROPPED_ENV = /^(?:TENDB_|ANTHROPIC_|CLAUDE_CODE_USE_|AWS_)/;

/** Days an eval daemon's lanes keep their transcripts, whatever the builder's own setting says. */
export const EVAL_TRANSCRIPT_DAYS = 30;

export class EvalIsolationError extends Error {
  override readonly name = 'EvalIsolationError';
}

/** Where the builder's own 10db keeps its data and its worktrees, which an eval run never touches. */
export interface BuilderPlaces {
  readonly dataDir: string;
  readonly worktreeBase: string;
}

/**
 * The eval daemon's environment: its data dir and worktree root inside the run's work dir, so its
 * tasks, cards, batches and worktrees never land in the builder's 10db, and every switch that would
 * reach outside (benchmarks, catalogue, judge, Slack) off. A work dir that overlaps the builder's
 * data dir or worktree base is refused.
 */
export function evalDaemonEnv(input: {
  readonly work: string;
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly fakeBook: string | null;
  readonly catalogueSnapshot: string;
  readonly builder: BuilderPlaces;
  /** How the eval daemon briefs its lanes; absent leaves it to the daemon's default. */
  readonly brief?: LaneBrief;
}): Record<string, string> {
  for (const place of [input.builder.dataDir, input.builder.worktreeBase]) {
    if (equalOrUnder(input.work, place) || equalOrUnder(place, input.work))
      throw new EvalIsolationError(
        `The eval work dir ${input.work} overlaps the builder's own 10db at ${place}`,
      );
  }
  const kept = Object.entries(input.inherited).filter(
    (e): e is [string, string] => e[1] !== undefined && !DROPPED_ENV.test(e[0]),
  );
  const miseTrusted = [input.inherited['MISE_TRUSTED_CONFIG_PATHS'], join(input.work, 'repos')]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(delimiter);
  return {
    ...Object.fromEntries(kept),
    // Every case's snapshot pins its own pnpm in `packageManager`, often not the builder's. Gates
    // run under the sandbox, where pnpm's switch to the pinned engine is refused (it locks a dir in
    // the system temp dir), so the gate must not need one. A mise shim finds the snapshot's pin once
    // mise trusts its config; a pnpm reached directly (a mise shim puts its own install dirs first on
    // the runner's PATH) runs as it is instead of switching.
    MISE_TRUSTED_CONFIG_PATHS: miseTrusted,
    pnpm_config_manage_package_manager_versions: 'false',
    TENDB_DATA_DIR: join(input.work, 'data'),
    TENDB_WORKTREE_ROOT: join(input.work, 'worktrees'),
    // The daemon picks a free port and writes it to daemon.json.
    TENDB_PORT: '0',
    TENDB_LOG_LEVEL: 'info',
    TENDB_BENCHMARKS: 'off',
    TENDB_CATALOGUE: 'off',
    TENDB_CATALOGUE_SNAPSHOT: input.catalogueSnapshot,
    // Task text and diffs would go to OpenRouter on the builder's key.
    TENDB_JUDGE: 'off',
    TENDB_SLACK: 'off',
    TENDB_TAILSCALE: 'off',
    // The daemon shuts down when this pipe closes, so it never outlives the runner.
    TENDB_PARENT_STDIN: '1',
    TENDB_LANE_TRANSCRIPT_DAYS: String(EVAL_TRANSCRIPT_DAYS),
    ...(input.fakeBook === null ? {} : { TENDB_FAKE_SCRIPTS: input.fakeBook }),
    ...(input.brief === undefined ? {} : { TENDB_LANE_BRIEF: input.brief }),
  };
}
