import { z } from 'zod';
import { NOISY_MIN_RAISED, NOISY_SHARE } from './inbox-card-types';
import { AreaName, DEFAULT_HAZARDS, DEPS_HAZARD, PathPattern } from './entities';
import { WatchpointLoudness } from './watchpoint-hit';

/**
 * A kind of change the builder wants to judge themselves: the files it covers, why it matters and what to check.
 * `key` is unique within a list; a project's watchpoint with a key from the builder's list overrides that one.
 */
export const Watchpoint = z.object({
  key: AreaName,
  label: z.string().min(1).max(80),
  why: z.string().max(400),
  globs: z.array(PathPattern).min(1).max(64),
  guidance: z.string().max(2000),
  loudness: z.enum(WatchpointLoudness),
  /** The library key it came from, so a starter's later revision knows which watchpoints to touch. */
  starter: z.string().nullable().default(null),
});
export type Watchpoint = z.infer<typeof Watchpoint>;

/** A project's entry that turns one of the builder's watchpoints off in that project. */
export const WatchpointOff = z.strictObject({ key: AreaName, off: z.literal(true) });
export type WatchpointOff = z.infer<typeof WatchpointOff>;

export const ProjectWatchpointEntry = z.union([Watchpoint, WatchpointOff]);
export type ProjectWatchpointEntry = z.infer<typeof ProjectWatchpointEntry>;

const MAX_WATCHPOINTS = 100;
const keysAreUnique = (list: readonly { readonly key: string }[]): boolean =>
  new Set(list.map((f) => f.key)).size === list.length;
const KEYS_UNIQUE = { message: 'A watchpoint key is used twice' };

/** The builder's watchpoints, applying in every project (app setting `watchpoints.you`). */
export const YourWatchpoints = z
  .array(Watchpoint)
  .max(MAX_WATCHPOINTS)
  .refine(keysAreUnique, KEYS_UNIQUE);
export type YourWatchpoints = z.infer<typeof YourWatchpoints>;

/** A project's own watchpoints, overrides and `off` entries (app setting `watchpoints.<projectId>`). */
export const ProjectWatchpoints = z
  .array(ProjectWatchpointEntry)
  .max(MAX_WATCHPOINTS)
  .refine(keysAreUnique, KEYS_UNIQUE);
export type ProjectWatchpoints = z.infer<typeof ProjectWatchpoints>;

/** Where an effective watchpoint came from: the builder's list, the project's own, or the project's replacement of one. */
export const WatchpointOrigin = { You: 'you', Project: 'project', Override: 'override' } as const;
export type WatchpointOrigin = (typeof WatchpointOrigin)[keyof typeof WatchpointOrigin];

export const EffectiveWatchpoint = Watchpoint.extend({ from: z.enum(WatchpointOrigin) });
export type EffectiveWatchpoint = z.infer<typeof EffectiveWatchpoint>;

/** The watchpoints that apply in a project, each tagged with where it came from. */
export const EffectiveWatchpointsDto = z.array(EffectiveWatchpoint);
export type EffectiveWatchpointsDto = z.infer<typeof EffectiveWatchpointsDto>;

/**
 * `GET` and `PUT /projects/:id/watchpoints`: the list that applies, and the project's own entries behind it
 * (its overrides, its own watchpoints and its `off` entries), which is exactly what a PUT replaces.
 */
export const ProjectWatchpointsDto = z.object({
  effective: EffectiveWatchpointsDto,
  entries: ProjectWatchpoints,
});
export type ProjectWatchpointsDto = z.infer<typeof ProjectWatchpointsDto>;

/** Whether a project entry is the `off` shape, which names one of the builder's keys and nothing else. */
export function isWatchpointOff(entry: ProjectWatchpointEntry): entry is WatchpointOff {
  return 'off' in entry;
}

/**
 * The watchpoints that apply in a project: the builder's list with the project's entries replacing theirs by key,
 * then the project's new keys. An `off` entry drops that watchpoint; one naming no watchpoint of the builder's does nothing.
 */
export function effectiveWatchpoints(
  yours: readonly Watchpoint[],
  project: readonly ProjectWatchpointEntry[],
): EffectiveWatchpoint[] {
  const own = new Map(project.map((entry) => [entry.key, entry]));
  const kept = yours.flatMap((watchpoint): EffectiveWatchpoint[] => {
    const entry = own.get(watchpoint.key);
    if (entry === undefined) return [{ ...watchpoint, from: WatchpointOrigin.You }];
    if (isWatchpointOff(entry)) return [];
    return [{ ...entry, from: WatchpointOrigin.Override }];
  });
  const known = new Set(yours.map((f) => f.key));
  const added = project.flatMap((entry): EffectiveWatchpoint[] =>
    isWatchpointOff(entry) || known.has(entry.key)
      ? []
      : [{ ...entry, from: WatchpointOrigin.Project }],
  );
  return [...kept, ...added];
}

/** A starter's stock hazard is missing from the defaults: a build mistake, never a runtime state. */
export class StarterWatchpointError extends Error {
  override readonly name = 'StarterWatchpointError';
  constructor(hazard: string) {
    super(`The stock hazard ${hazard} has no globs for a starter watchpoint to reuse`);
  }
}

function hazardGlobs(name: string): string[] {
  const hazard = DEFAULT_HAZARDS.find((h) => h.name === name);
  if (hazard === undefined) throw new StarterWatchpointError(name);
  return [...hazard.globs];
}

/**
 * The library the builder starts from. A starter reaches a list only when it is added, and a later
 * revision is offered as a proposal, never written over the builder's copy.
 */
export const STARTER_WATCHPOINTS: readonly Watchpoint[] = [
  {
    key: 'migrations',
    label: 'Migrations',
    why: "A revert can't undo a migration that ran.",
    globs: hazardGlobs('migrations'),
    guidance:
      'Check that the migration can run on existing data, that it is safe to apply while the old code still runs, and that nothing depends on a rollback.',
    loudness: WatchpointLoudness.Ask,
    starter: 'migrations',
  },
  {
    key: 'contracts',
    label: 'Contracts and API',
    why: 'Other code and other people depend on these shapes, and a break reaches them late.',
    globs: ['**/contracts/**', '**/*.proto', '**/openapi*.{yaml,json}', '**/schema.graphql'],
    guidance:
      'Check that every change is additive, that nothing is removed or narrowed, and that callers are updated.',
    loudness: WatchpointLoudness.Ask,
    starter: 'contracts',
  },
  {
    key: 'prompts',
    label: 'Prompts',
    why: 'A prompt change shifts behavior in ways tests rarely catch.',
    globs: ['**/prompts/**', '**/*prompt*.*'],
    guidance:
      'Check the new wording against what it should make the model do, and look for instructions that now conflict.',
    loudness: WatchpointLoudness.Show,
    starter: 'prompts',
  },
  {
    key: 'evals',
    label: 'Evals',
    why: 'A lowered bar or a changed golden hides a regression.',
    globs: ['**/evals/**', '**/*.eval.*'],
    guidance: 'Check that no bar was lowered and no golden changed without a reason.',
    loudness: WatchpointLoudness.Show,
    starter: 'evals',
  },
  {
    key: 'agent-instructions',
    label: 'Agent instructions',
    why: 'These files steer every later session.',
    globs: ['**/AGENTS.md', '**/CLAUDE.md', '.claude/**', '.codex/**'],
    guidance:
      'Check that the rule is true, that it belongs there, and that it does not widen what agents may do.',
    loudness: WatchpointLoudness.Show,
    starter: 'agent-instructions',
  },
  {
    key: 'dependencies',
    label: 'Dependencies',
    why: 'A new dependency is code nobody here reviewed.',
    globs: hazardGlobs(DEPS_HAZARD),
    guidance:
      'Check that each new or changed dependency is needed, pinned, and from a source you trust.',
    loudness: WatchpointLoudness.Show,
    starter: 'dependencies',
  },
];

/**
 * The S1 versions of the starters whose loudness later changed. A builder's copy that still equals the old version
 * field for field takes the starter's new loudness; an edited copy is left as the builder made it.
 */
export const STARTER_WATCHPOINT_REVISIONS: readonly { readonly was: Watchpoint }[] =
  STARTER_WATCHPOINTS.filter((w) => w.loudness === WatchpointLoudness.Ask).map((w) => ({
    was: { ...w, globs: [...w.globs], loudness: WatchpointLoudness.Show },
  }));

const sameWatchpoint = (a: Watchpoint, b: Watchpoint): boolean =>
  a.key === b.key &&
  a.label === b.label &&
  a.why === b.why &&
  a.guidance === b.guidance &&
  a.loudness === b.loudness &&
  a.starter === b.starter &&
  a.globs.length === b.globs.length &&
  a.globs.every((g, i) => g === b.globs[i]);

/** The stored list with each unedited copy of a revised starter moved to the starter's current loudness. */
export function revisedWatchpoints(stored: readonly Watchpoint[]): Watchpoint[] {
  return stored.map((entry) => {
    const revision = STARTER_WATCHPOINT_REVISIONS.find((r) => sameWatchpoint(r.was, entry));
    if (revision === undefined) return entry;
    const now = STARTER_WATCHPOINTS.find((w) => w.key === entry.key);
    return now === undefined ? entry : { ...entry, loudness: now.loudness };
  });
}

/** One watchpoint's last 30 days: tasks it hit, Look cards that named it, and those waved through. */
export const WatchpointStatsDto = z.object({
  key: z.string(),
  tasks: z.int().nonnegative(),
  cards: z.int().nonnegative(),
  waved: z.int().nonnegative(),
  noisy: z.boolean(),
});
export type WatchpointStatsDto = z.infer<typeof WatchpointStatsDto>;

/** Whether a watchpoint's cards were mostly waved through: at least the noisy minimum, at least the noisy share. */
export function isNoisyWatchpoint(counts: { cards: number; waved: number }): boolean {
  return counts.cards >= NOISY_MIN_RAISED && counts.waved / counts.cards >= NOISY_SHARE;
}
