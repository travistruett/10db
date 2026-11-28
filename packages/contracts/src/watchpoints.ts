import { z } from 'zod';
import { NOISY_MIN_RAISED, NOISY_SHARE } from './inbox-card-types';
import { AreaName, DEFAULT_HAZARDS, DEPS_HAZARD, PathPattern } from './entities';
import { TopicKey } from './knowledge';
import { WatchpointLoudness } from './watchpoint-hit';

/** A regex over a changed line, matched case-insensitively; it must compile. */
export const WatchpointLinePattern = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (source) => {
      try {
        new RegExp(source, 'i');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'is not a valid pattern' },
  );
export type WatchpointLinePattern = z.infer<typeof WatchpointLinePattern>;

/** The most Knowledge topics one watchpoint links. */
export const MAX_WATCHPOINT_KNOWLEDGE = 8;

/** The longest question a watchpoint asks. */
export const MAX_WATCHPOINT_QUESTION_LENGTH = 400;

/**
 * A kind of change the builder wants to judge themselves: the files it covers, why it matters and what to check.
 * `key` is unique within a list; a project's watchpoint with a key from the builder's list overrides that one.
 */
export const Watchpoint = z.object({
  key: AreaName,
  label: z.string().min(1).max(80),
  why: z.string().max(400),
  globs: z.array(PathPattern).min(1).max(64),
  /** With patterns, a file the globs cover counts only when one of its added or removed lines matches. */
  lines: z.array(WatchpointLinePattern).max(16).default([]),
  /**
   * A yes/no the judge asks of the covered files no line pattern settled. It never makes a hit: a watchpoint with a
   * question hits only through its globs and lines, and one with no lines hits nothing by rule.
   */
  question: z.string().trim().min(1).max(MAX_WATCHPOINT_QUESTION_LENGTH).nullable().default(null),
  guidance: z.string().max(2000),
  /**
   * Knowledge topic keys. The current principles under each key, or under a key that starts with `key.`, join the
   * guidance in the build and review briefs. A list stored before this field reads as none.
   */
  knowledge: z.array(TopicKey).max(MAX_WATCHPOINT_KNOWLEDGE).default([]),
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

/** Which list a proposed watchpoint change is for: the project's own, or the builder's for every project. */
export const WatchpointProposalScope = { Project: 'project', You: 'you' } as const;
export type WatchpointProposalScope =
  (typeof WatchpointProposalScope)[keyof typeof WatchpointProposalScope];

/** Hold is not built, so it is never proposed: until it is, a watchpoint set to hold would do less than ask. */
const notHold = (entry: ProjectWatchpointEntry): boolean =>
  isWatchpointOff(entry) || entry.loudness !== WatchpointLoudness.Hold;
const NOT_HOLD = { message: 'Hold is not available yet; propose show or ask' };

/**
 * A change an agent proposes to a watchpoint list: the entry is added, or replaces the one with its key. A project
 * entry may be `off`, which turns one of the builder's watchpoints off there. Nothing changes until the builder
 * accepts it. A union, not a discriminated one, so the MCP schema reads as `anyOf`, as every tool's does.
 */
export const WatchpointProposal = z.union([
  z.strictObject({
    scope: z.literal(WatchpointProposalScope.Project),
    entry: ProjectWatchpointEntry.refine(notHold, NOT_HOLD),
  }),
  z.strictObject({
    scope: z.literal(WatchpointProposalScope.You),
    entry: Watchpoint.refine(notHold, NOT_HOLD),
  }),
]);
export type WatchpointProposal = z.infer<typeof WatchpointProposal>;

/** A list with `entry` in place of the one with its key, or added at the end when none has it. */
export function withWatchpointEntry<T extends { readonly key: string }>(
  list: readonly T[],
  entry: T,
): T[] {
  return list.some((e) => e.key === entry.key)
    ? list.map((e) => (e.key === entry.key ? entry : e))
    : [...list, entry];
}

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
    lines: [],
    question: null,
    guidance:
      'Check that the migration can run on existing data, that it is safe to apply while the old code still runs, and that nothing depends on a rollback.',
    knowledge: [],
    loudness: WatchpointLoudness.Ask,
    starter: 'migrations',
  },
  {
    key: 'contracts',
    label: 'Contracts and API',
    why: 'Other code and other people depend on these shapes, and a break reaches them late.',
    globs: ['**/contracts/**', '**/*.proto', '**/openapi*.{yaml,json}', '**/schema.graphql'],
    lines: [],
    question: null,
    guidance:
      'Check that every change is additive, that nothing is removed or narrowed, and that callers are updated.',
    knowledge: [],
    loudness: WatchpointLoudness.Ask,
    starter: 'contracts',
  },
  {
    key: 'prompts',
    label: 'Prompts',
    why: 'A prompt change shifts behavior in ways tests rarely catch.',
    globs: ['**/prompts/**', '**/*prompt*.*'],
    lines: [],
    question: null,
    guidance:
      'Check the new wording against what it should make the model do, and look for instructions that now conflict.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'prompts',
  },
  {
    key: 'evals',
    label: 'Evals',
    why: 'A lowered bar or a changed golden hides a regression.',
    globs: ['**/evals/**', '**/*.eval.*'],
    lines: [],
    question: null,
    guidance: 'Check that no bar was lowered and no golden changed without a reason.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'evals',
  },
  {
    key: 'agent-instructions',
    label: 'Agent instructions',
    why: 'These files steer every later session.',
    globs: ['**/AGENTS.md', '**/CLAUDE.md', '.claude/**', '.codex/**'],
    lines: [],
    question: null,
    guidance:
      'Check that the rule is true, that it belongs there, and that it does not widen what agents may do.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'agent-instructions',
  },
  {
    key: 'dependencies',
    label: 'Dependencies',
    why: 'A new dependency is code nobody here reviewed.',
    globs: hazardGlobs(DEPS_HAZARD),
    lines: [],
    question: null,
    guidance:
      'Check that each new or changed dependency is needed, pinned, and from a source you trust.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'dependencies',
  },
  {
    key: 'indexes',
    label: 'Indexes',
    why: 'An index on a big table can lock it or rebuild it while the app runs.',
    globs: hazardGlobs('migrations'),
    lines: [
      '\\bcreate\\s+(unique\\s+)?index\\b',
      '\\bdrop\\s+index\\b',
      '\\b(unique)?index\\s*\\(',
    ],
    question: null,
    guidance:
      'Check whether the index locks or rebuilds a big table, and that it can be built while the old code still runs.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'indexes',
  },
  {
    key: 'model-choice',
    label: 'Model choice',
    why: 'A model id decides what a feature costs and which accounts it works on.',
    globs: ['**'],
    lines: [
      '\\bclaude-[a-z0-9][\\w.-]*',
      '\\banthropic\\.claude',
      '\\bgpt-\\d[\\w.-]*',
      '\\bo[134]-(mini|pro)\\b',
      '\\bgemini-\\d[\\w.-]*',
      'typesafe/jev',
    ],
    question: null,
    guidance:
      'Check that the model is the one intended, that it works on every provider the feature supports, and what it costs.',
    knowledge: [],
    loudness: WatchpointLoudness.Show,
    starter: 'model-choice',
  },
  {
    key: 'design-principles',
    label: 'Design principles',
    why: 'How the interface looks and behaves is a call you make, and tests rarely say whether it was made well.',
    globs: ['**/*.{tsx,jsx,vue,svelte}', '**/*.{css,scss}', '**/components/**'],
    lines: [],
    question:
      'Does this change how the interface looks or behaves for the user: layout, wording, colours, controls or flows?',
    guidance:
      'Check the change against how you want the interface to look and behave, and that it matches the screens around it.',
    knowledge: ['ui'],
    loudness: WatchpointLoudness.Show,
    starter: 'design-principles',
  },
  {
    key: 'auth-and-permissions',
    label: 'Auth and permissions',
    why: 'A change to who can do what can open a door no test was written for.',
    globs: ['**'],
    lines: [],
    question:
      'Does this change who can do what: sign-in, sessions, tokens, roles, or permission checks?',
    guidance:
      'Check who can now do what they could not before, and that every path to the action still checks it.',
    knowledge: ['auth'],
    loudness: WatchpointLoudness.Show,
    starter: 'auth-and-permissions',
  },
];

/** The starters a new install begins with; the rest wait in the library, in Add Watchpoint's menu. */
const INITIAL_KEYS: readonly string[] = [
  'migrations',
  'contracts',
  'prompts',
  'evals',
  'agent-instructions',
  'dependencies',
];
export const INITIAL_WATCHPOINTS: readonly Watchpoint[] = STARTER_WATCHPOINTS.filter((w) =>
  INITIAL_KEYS.includes(w.key),
);

// A starter's `knowledge` is not a revision: a copy the builder already holds keeps the topics it has, the way
// `STOCK_HAZARD_REVISIONS` leaves an existing project's hazards alone. Only a starter added later carries it.

/**
 * The starters' revision now. A list saved before revisions existed counts as revision 1; every save stamps the
 * current one, so a revision is applied to a list once and a builder's later choice is never undone by it.
 */
export const STARTER_REVISION = 2;

/**
 * The starters as first shipped, at show, for those whose loudness later changed. A builder's copy that still equals
 * the old version field for field takes the starter's new loudness; an edited copy is left as the builder made it.
 * The old versions are literals: a later edit to a starter must not stop the upgrade.
 */
export const STARTER_WATCHPOINT_REVISIONS: readonly {
  readonly since: number;
  readonly was: Watchpoint;
}[] = [
  {
    since: 2,
    was: {
      key: 'migrations',
      label: 'Migrations',
      why: "A revert can't undo a migration that ran.",
      globs: [
        '**/migrations/**',
        '**/drizzle/**',
        '**/alembic/versions/**',
        '**/db/migrate/**',
        '**/prisma/migrations/**',
      ],
      lines: [],
      question: null,
      guidance:
        'Check that the migration can run on existing data, that it is safe to apply while the old code still runs, and that nothing depends on a rollback.',
      knowledge: [],
      loudness: WatchpointLoudness.Show,
      starter: 'migrations',
    },
  },
  {
    since: 2,
    was: {
      key: 'contracts',
      label: 'Contracts and API',
      why: 'Other code and other people depend on these shapes, and a break reaches them late.',
      globs: ['**/contracts/**', '**/*.proto', '**/openapi*.{yaml,json}', '**/schema.graphql'],
      lines: [],
      question: null,
      guidance:
        'Check that every change is additive, that nothing is removed or narrowed, and that callers are updated.',
      knowledge: [],
      loudness: WatchpointLoudness.Show,
      starter: 'contracts',
    },
  },
];

const sameWatchpoint = (a: Watchpoint, b: Watchpoint): boolean =>
  a.key === b.key &&
  a.label === b.label &&
  a.why === b.why &&
  a.guidance === b.guidance &&
  a.loudness === b.loudness &&
  a.starter === b.starter &&
  a.globs.length === b.globs.length &&
  a.globs.every((g, i) => g === b.globs[i]) &&
  a.lines.length === b.lines.length &&
  a.lines.every((l, i) => l === b.lines[i]) &&
  a.question === b.question &&
  a.knowledge.length === b.knowledge.length &&
  a.knowledge.every((k, i) => k === b.knowledge[i]);

/**
 * The stored list with each unedited copy of a starter moved to the starter's current loudness, for the revisions
 * newer than the one the list was saved at (1 when it carries none).
 */
export function revisedWatchpoints(stored: readonly Watchpoint[], savedAt = 1): Watchpoint[] {
  return stored.map((entry) => {
    const revision = STARTER_WATCHPOINT_REVISIONS.find(
      (r) => r.since > savedAt && sameWatchpoint(r.was, entry),
    );
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
