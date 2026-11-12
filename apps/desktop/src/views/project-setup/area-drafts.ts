import {
  AreaDef,
  areaRolesProblem,
  atMostOneCatchAll,
  DEFAULT_HAZARDS,
  ONE_CATCH_ALL,
  PathPattern,
  WHOLE_REPOSITORY_GLOBS,
  type ProposedArea,
} from '@10db/contracts';
import { roleFields, type RoleChoice } from '../settings/area-role-fields';

/** One area as the builder is editing it: the globs are the text of a box, one to a line. */
export interface AreaDraft {
  /** Identifies the row while its name and globs change. Never reused within one list. */
  readonly key: number;
  readonly name: string;
  readonly globs: string;
  /** Why the area was proposed; empty for one the builder added. */
  readonly reason: string;
  /** The project's catch-all: a file no other area holds falls in this one. At most one draft. */
  readonly catchAll: boolean;
  readonly role: RoleChoice;
  /** A page's route; kept while the role changes, sent only for a page. */
  readonly route: string;
}

/** What setup offers when no proposal came: one area over the whole repository. */
export const WHOLE_REPOSITORY: ProposedArea = {
  name: 'repo',
  globs: [...WHOLE_REPOSITORY_GLOBS],
  reason: 'The whole repository.',
};

const HAZARD_NAMES: readonly string[] = DEFAULT_HAZARDS.map((h) => h.name);
const NAME_RULE = 'Use lowercase letters, digits and hyphens, starting with a letter.';

let lastKey = 0;
/** A key no row has had: rows keep their identity (and their open menus) while others come and go. */
const freshKey = (): number => ++lastKey;

export function draftsFromAreas(areas: readonly ProposedArea[]): AreaDraft[] {
  return areas.map((area) => ({
    key: freshKey(),
    name: area.name,
    globs: area.globs.join('\n'),
    reason: area.reason,
    catchAll: area.catchAll === true,
    role: area.role ?? '',
    route: area.route ?? '',
  }));
}

const globLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The areas a project is created with: exactly what the builder left in the list. */
export function areasOf(drafts: readonly AreaDraft[]): AreaDef[] {
  return drafts.map((d) => ({
    name: d.name.trim(),
    globs: globLines(d.globs),
    ...(d.catchAll ? { catchAll: true } : {}),
    ...roleFields(d.role, d.route),
  }));
}

const change = (
  drafts: readonly AreaDraft[],
  key: number,
  patch: Partial<AreaDraft>,
): AreaDraft[] => drafts.map((d) => (d.key === key ? { ...d, ...patch } : d));

export const setName = (drafts: readonly AreaDraft[], key: number, name: string): AreaDraft[] =>
  change(drafts, key, { name });

export const setGlobs = (drafts: readonly AreaDraft[], key: number, globs: string): AreaDraft[] =>
  change(drafts, key, { globs });

/** Changes the area's role, its route, or both. */
export const setRole = (
  drafts: readonly AreaDraft[],
  key: number,
  next: { readonly role?: RoleChoice; readonly route?: string },
): AreaDraft[] => change(drafts, key, next);

/** Makes the area the catch-all, which takes it from any other, or clears it; there is at most one. */
export const setCatchAll = (
  drafts: readonly AreaDraft[],
  key: number,
  catchAll: boolean,
): AreaDraft[] =>
  drafts.map((d) =>
    d.key === key ? { ...d, catchAll } : catchAll ? { ...d, catchAll: false } : d,
  );

export const removeDraft = (drafts: readonly AreaDraft[], key: number): AreaDraft[] =>
  drafts.filter((d) => d.key !== key);

/**
 * `from` goes into `into`: one area under `into`'s name and reason, holding both areas' globs. Two
 * pages make a page that no single route shows; areas of different roles make one with none.
 */
export function mergeDrafts(drafts: readonly AreaDraft[], from: number, into: number): AreaDraft[] {
  const source = drafts.find((d) => d.key === from);
  const target = drafts.find((d) => d.key === into);
  if (source === undefined || target === undefined || from === into) return [...drafts];
  const globs = [...new Set([...globLines(target.globs), ...globLines(source.globs)])].join('\n');
  const role = target.role === source.role ? target.role : '';
  return removeDraft(
    change(drafts, into, { globs, catchAll: target.catchAll || source.catchAll, role, route: '' }),
    from,
  );
}

export function addDraft(drafts: readonly AreaDraft[]): AreaDraft[] {
  return [
    ...drafts,
    { key: freshKey(), name: '', globs: '', reason: '', catchAll: false, role: '', route: '' },
  ];
}

export interface RowProblems {
  readonly name?: string;
  readonly globs?: string;
}

export interface DraftProblems {
  readonly rows: ReadonlyMap<number, RowProblems>;
  /** A problem with the list as a whole; null when there is none. */
  readonly whole: string | null;
}

function nameProblem(name: string, shared: boolean): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Name the area.';
  if (!AreaDef.shape.name.safeParse(trimmed).success) return NAME_RULE;
  if (HAZARD_NAMES.includes(trimmed))
    return `${trimmed} is a hazard of every new project; choose another name.`;
  return shared ? 'Another area has this name.' : undefined;
}

function globProblem(text: string): string | undefined {
  const lines = globLines(text);
  if (lines.length === 0) return 'Give at least one glob.';
  for (const line of lines) {
    const parsed = PathPattern.safeParse(line);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'This is not a glob.';
  }
  return undefined;
}

/** Why the list can't be saved as it stands, per row and as a whole. The daemon checks again. */
export function draftProblems(drafts: readonly AreaDraft[]): DraftProblems {
  const count = new Map<string, number>();
  for (const d of drafts) count.set(d.name.trim(), (count.get(d.name.trim()) ?? 0) + 1);
  const rows = new Map<number, RowProblems>();
  for (const d of drafts) {
    const name = nameProblem(d.name, (count.get(d.name.trim()) ?? 0) > 1);
    const globs = globProblem(d.globs);
    if (name !== undefined || globs !== undefined)
      rows.set(d.key, {
        ...(name === undefined ? {} : { name }),
        ...(globs === undefined ? {} : { globs }),
      });
  }
  return {
    rows,
    whole:
      drafts.length === 0
        ? 'Keep at least one area.'
        : !atMostOneCatchAll(drafts)
          ? ONE_CATCH_ALL
          : areaRolesProblem(areasOf(drafts)),
  };
}
