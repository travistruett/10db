import { execFileSync } from 'node:child_process';
import {
  Ceremony,
  CeremonyReason,
  DEFAULT_ONE_WAY_PATHS,
  TaskSize,
  type AreaDef,
  type HazardDef,
} from '@10db/contracts';
import { areaMatches, classifyPath } from '../guard';

// Shape spec §7 Ceremony. Claude sets `ceremony` on every goal, loose task and addition; a rule forces
// `spec` when any of these holds, and the builder can pin a forced effort to `direct`.

/** A goal over this many lane hours is XL (§8: its tasks' hours sum). */
export const GOAL_XL_HOURS = 8;
/** A goal with more tasks than this is forced to spec. */
export const GOAL_MAX_DIRECT_TASKS = 5;

/** What the rule reads about one effort. */
export interface EffortFacts {
  readonly kind: 'goal' | 'task';
  /** What Claude wrote (or the builder pinned). */
  readonly claude: Ceremony;
  /** The builder pinned the effort's `ceremony` field. */
  readonly pinnedCeremony: boolean;
  /** A loose task's or addition's derived size; absent for a goal. */
  readonly size: TaskSize | undefined;
  /** A loose task's hours, or a goal's tasks' sum. */
  readonly hours: number;
  readonly taskCount: number;
  /** The areas of each task: a loose task has one set, a goal one per task. */
  readonly taskAreas: readonly (readonly string[])[];
}

export interface EffortCeremony {
  readonly ceremony: Ceremony;
  readonly reasons: CeremonyReason[];
  readonly skippedByYou: boolean;
}

/**
 * What forces the effort to spec, and what applies. `oneWayNames` are the areas and hazards that
 * hold a tracked file matching a one-way path (`oneWayNamesOf`).
 */
export function ceremonyFor(facts: EffortFacts, oneWayNames: ReadonlySet<string>): EffortCeremony {
  const reasons: CeremonyReason[] = [];
  if (facts.kind === 'task' && (facts.size === TaskSize.L || facts.size === TaskSize.XL))
    reasons.push(CeremonyReason.LooseL);
  if (facts.kind === 'goal' && facts.hours > GOAL_XL_HOURS) reasons.push(CeremonyReason.GoalXl);
  if (facts.kind === 'goal' && facts.taskCount > GOAL_MAX_DIRECT_TASKS)
    reasons.push(CeremonyReason.ManyTasks);
  if (facts.taskAreas.some((areas) => areas.some((a) => oneWayNames.has(a))))
    reasons.push(CeremonyReason.OneWayPath);
  const forced = reasons.length > 0;
  // A builder's pin to `direct` wins over the rule; a pin to `spec` is just spec.
  const skipped = forced && facts.pinnedCeremony && facts.claude === Ceremony.Direct;
  return {
    ceremony: skipped ? Ceremony.Direct : forced ? Ceremony.Spec : facts.claude,
    reasons,
    skippedByYou: skipped,
  };
}

/**
 * The areas and hazards of the project that hold a tracked file matching one of the one-way globs.
 * The match runs over the tracked files, so two globs never need intersecting: an area and a one-way
 * path share a file or they don't.
 */
export function oneWayNamesOf(input: {
  readonly tracked: readonly string[];
  readonly globs: readonly string[];
  readonly areas: readonly AreaDef[];
  readonly hazards: readonly HazardDef[];
}): Set<string> {
  const names = new Set<string>();
  if (input.globs.length === 0) return names;
  for (const file of input.tracked) {
    if (!input.globs.some((g) => areaMatches(file, g))) continue;
    const hit = classifyPath(file, input.areas, input.hazards);
    for (const name of [...hit.areas, ...hit.hazards]) names.add(name);
  }
  return names;
}

/**
 * The one-way globs in force: what the builder set (an empty list included), else the goals spec's 10db
 * paths that this project has a tracked file under, which is none for a project that isn't 10db.
 */
export function effectiveOneWayPaths(
  stored: readonly string[] | null,
  tracked: readonly string[],
): string[] {
  if (stored !== null) return [...stored];
  return DEFAULT_ONE_WAY_PATHS.filter((glob) => tracked.some((file) => areaMatches(file, glob)));
}

/** The files git tracks in a checkout; none when it can't be read (a checkout that isn't a repository). */
export type TrackedFiles = (repoPath: string) => readonly string[];

const GIT_LIST_MS = 10_000;
const GIT_LIST_BYTES = 64 * 1024 * 1024;

export const gitTrackedFiles: TrackedFiles = (repoPath) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  try {
    return execFileSync('git', ['-C', repoPath, 'ls-files', '-z'], {
      encoding: 'utf8',
      env,
      timeout: GIT_LIST_MS,
      maxBuffer: GIT_LIST_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter((file) => file !== '');
  } catch {
    return [];
  }
};
