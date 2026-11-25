import { z } from 'zod';
import { AreaName, DEFAULT_HAZARDS, DEPS_HAZARD, PathPattern } from './entities';
import { FocusLoudness } from './focus-hit';

/**
 * A kind of change the builder wants to judge themselves: the files it covers, why it matters and what to check.
 * `key` is unique within a list; a project's focus with a key from the builder's list overrides that one.
 */
export const Focus = z.object({
  key: AreaName,
  label: z.string().min(1).max(80),
  why: z.string().max(400),
  globs: z.array(PathPattern).min(1).max(64),
  guidance: z.string().max(2000),
  loudness: z.enum(FocusLoudness),
  /** The library key it came from, so a starter's later revision knows which focuses to touch. */
  starter: z.string().nullable().default(null),
});
export type Focus = z.infer<typeof Focus>;

/** A project's entry that turns one of the builder's focuses off in that project. */
export const FocusOff = z.strictObject({ key: AreaName, off: z.literal(true) });
export type FocusOff = z.infer<typeof FocusOff>;

export const ProjectFocusEntry = z.union([Focus, FocusOff]);
export type ProjectFocusEntry = z.infer<typeof ProjectFocusEntry>;

const MAX_FOCUSES = 100;
const keysAreUnique = (list: readonly { readonly key: string }[]): boolean =>
  new Set(list.map((f) => f.key)).size === list.length;
const KEYS_UNIQUE = { message: 'A focus key is used twice' };

/** The builder's focuses, applying in every project (app setting `focuses.you`). */
export const YourFocuses = z.array(Focus).max(MAX_FOCUSES).refine(keysAreUnique, KEYS_UNIQUE);
export type YourFocuses = z.infer<typeof YourFocuses>;

/** A project's own focuses, overrides and `off` entries (app setting `focuses.<projectId>`). */
export const ProjectFocuses = z
  .array(ProjectFocusEntry)
  .max(MAX_FOCUSES)
  .refine(keysAreUnique, KEYS_UNIQUE);
export type ProjectFocuses = z.infer<typeof ProjectFocuses>;

/** Where an effective focus came from: the builder's list, the project's own, or the project's replacement of one. */
export const FocusOrigin = { You: 'you', Project: 'project', Override: 'override' } as const;
export type FocusOrigin = (typeof FocusOrigin)[keyof typeof FocusOrigin];

export const EffectiveFocus = Focus.extend({ from: z.enum(FocusOrigin) });
export type EffectiveFocus = z.infer<typeof EffectiveFocus>;

/** `GET /projects/:id/focuses`: the list that applies in the project. */
export const EffectiveFocusesDto = z.array(EffectiveFocus);
export type EffectiveFocusesDto = z.infer<typeof EffectiveFocusesDto>;

/** Whether a project entry is the `off` shape, which names one of the builder's keys and nothing else. */
export function isFocusOff(entry: ProjectFocusEntry): entry is FocusOff {
  return 'off' in entry;
}

/**
 * The focuses that apply in a project: the builder's list with the project's entries replacing theirs by key,
 * then the project's new keys. An `off` entry drops that focus; one naming no focus of the builder's does nothing.
 */
export function effectiveFocuses(
  yours: readonly Focus[],
  project: readonly ProjectFocusEntry[],
): EffectiveFocus[] {
  const own = new Map(project.map((entry) => [entry.key, entry]));
  const kept = yours.flatMap((focus): EffectiveFocus[] => {
    const entry = own.get(focus.key);
    if (entry === undefined) return [{ ...focus, from: FocusOrigin.You }];
    if (isFocusOff(entry)) return [];
    return [{ ...entry, from: FocusOrigin.Override }];
  });
  const known = new Set(yours.map((f) => f.key));
  const added = project.flatMap((entry): EffectiveFocus[] =>
    isFocusOff(entry) || known.has(entry.key) ? [] : [{ ...entry, from: FocusOrigin.Project }],
  );
  return [...kept, ...added];
}

/** A starter's stock hazard is missing from the defaults: a build mistake, never a runtime state. */
export class StarterFocusError extends Error {
  override readonly name = 'StarterFocusError';
  constructor(hazard: string) {
    super(`The stock hazard ${hazard} has no globs for a starter focus to reuse`);
  }
}

function hazardGlobs(name: string): string[] {
  const hazard = DEFAULT_HAZARDS.find((h) => h.name === name);
  if (hazard === undefined) throw new StarterFocusError(name);
  return [...hazard.globs];
}

/**
 * The library the builder starts from. A starter reaches a list only when it is added, and a later
 * revision is offered as a proposal, never written over the builder's copy.
 */
export const STARTER_FOCUSES: readonly Focus[] = [
  {
    key: 'migrations',
    label: 'Migrations',
    why: "A revert can't undo a migration that ran.",
    globs: hazardGlobs('migrations'),
    guidance:
      'Check that the migration can run on existing data, that it is safe to apply while the old code still runs, and that nothing depends on a rollback.',
    loudness: FocusLoudness.Show,
    starter: 'migrations',
  },
  {
    key: 'contracts',
    label: 'Contracts and API',
    why: 'Other code and other people depend on these shapes, and a break reaches them late.',
    globs: ['**/contracts/**', '**/*.proto', '**/openapi*.{yaml,json}', '**/schema.graphql'],
    guidance:
      'Check that every change is additive, that nothing is removed or narrowed, and that callers are updated.',
    loudness: FocusLoudness.Show,
    starter: 'contracts',
  },
  {
    key: 'prompts',
    label: 'Prompts',
    why: 'A prompt change shifts behavior in ways tests rarely catch.',
    globs: ['**/prompts/**', '**/*prompt*.*'],
    guidance:
      'Check the new wording against what it should make the model do, and look for instructions that now conflict.',
    loudness: FocusLoudness.Show,
    starter: 'prompts',
  },
  {
    key: 'evals',
    label: 'Evals',
    why: 'A lowered bar or a changed golden hides a regression.',
    globs: ['**/evals/**', '**/*.eval.*'],
    guidance: 'Check that no bar was lowered and no golden changed without a reason.',
    loudness: FocusLoudness.Show,
    starter: 'evals',
  },
  {
    key: 'agent-instructions',
    label: 'Agent instructions',
    why: 'These files steer every later session.',
    globs: ['**/AGENTS.md', '**/CLAUDE.md', '.claude/**', '.codex/**'],
    guidance:
      'Check that the rule is true, that it belongs there, and that it does not widen what agents may do.',
    loudness: FocusLoudness.Show,
    starter: 'agent-instructions',
  },
  {
    key: 'dependencies',
    label: 'Dependencies',
    why: 'A new dependency is code nobody here reviewed.',
    globs: hazardGlobs(DEPS_HAZARD),
    guidance:
      'Check that each new or changed dependency is needed, pinned, and from a source you trust.',
    loudness: FocusLoudness.Show,
    starter: 'dependencies',
  },
];
