import { z } from 'zod';
import { AppUrl, AreaDef, AreaName, PathPattern, ProjectPatch } from './entities';
import { globsOverlap } from './glob-overlap';
import { AreaRole, AreaRoute, PageLabel } from './page-areas';

// Workbench setup (`POST /projects/:projectId/workbench-setup`): what 10db proposes so a project is
// ready for its first pass: its areas rebuilt with pages, and settings, all saved by one Apply.

/** One line the setup screen shows. */
const Line = z
  .string()
  .min(1)
  .max(500)
  .refine((t) => !/\p{Cc}/u.test(t), 'one line, with no control characters');

/** An area as a project accepts it in a patch. */
const SetupArea = AreaDef.extend({ globs: z.array(PathPattern).min(1) });

/** A page the rebuilt list makes: one row the builder may untick. */
export const PageRow = z.object({
  name: AreaName,
  /** Absent for a page no single path shows. */
  route: AreaRoute.optional(),
  /** The name the setup guesses for the page; absent when it guesses none. */
  label: PageLabel.optional(),
  /** Its route folder, then the folders and files of its code outside it, as repository paths. */
  folders: z.array(z.string().min(1)).min(1),
  /** For an area open tasks name that becomes this page: the area as it is, which unticking restores. */
  was: AreaDef.optional(),
});
export type PageRow = z.infer<typeof PageRow>;

const Named = z.object({ name: z.string(), reason: z.string() });

/** An area open tasks name, split along its packages: one row the builder may untick. */
export const SplitRow = z.object({
  from: AreaName,
  /** The new areas, the core first (`<from>-shared`); `from` itself is retired. */
  into: z.array(SetupArea).min(2),
  /** `from` as it is, which an unticked row keeps. */
  was: AreaDef,
  /** The open tasks that name `from`; Apply has each of them name every area of `into`. */
  tasks: z.int().nonnegative(),
});
export type SplitRow = z.infer<typeof SplitRow>;

/** The project's areas rebuilt: the whole new list, and what it keeps, adds as pages and leaves out. */
export const WorkbenchSetupAreas = z.object({
  /** The new area list, every page ticked; Apply saves it (less any unticked page, `withoutPages`). */
  proposed: z.array(SetupArea),
  /** Existing areas kept exactly as they are, each with why (open tasks or a live pass name it). */
  kept: z.array(Named),
  /** The pages of `proposed` the project does not have yet, in its order. */
  pages: z.array(PageRow),
  /** Pages and areas left out, each with why. */
  skipped: z.array(Named),
  /** Areas open tasks name that split along their packages; `proposed` holds each whole. */
  splits: z.array(SplitRow).default([]),
});
export type WorkbenchSetupAreas = z.infer<typeof WorkbenchSetupAreas>;

/** A project setting the setup suggests, by the `ProjectPatch` field it sets. */
export const SettingField = {
  AppUrl: 'appUrl',
  DevLoginCommand: 'devLoginCommand',
  ChangedCheckCommand: 'changedCheckCommand',
  SandboxDocker: 'sandboxDocker',
} as const;
export type SettingField = (typeof SettingField)[keyof typeof SettingField];

const Found = {
  /** Where it was found, in one line ("from docker-compose.yml: proxy publishes 8800"). */
  source: Line,
  /** What the builder should know before ticking it. */
  note: Line.optional(),
};

export const SettingSuggestion = z.discriminatedUnion('field', [
  z.object({ field: z.literal(SettingField.AppUrl), value: AppUrl, ...Found }),
  z.object({
    field: z.literal(SettingField.DevLoginCommand),
    value: z.string().min(1).max(2000),
    ...Found,
  }),
  z.object({
    field: z.literal(SettingField.ChangedCheckCommand),
    value: z.string().min(1),
    ...Found,
  }),
  z.object({ field: z.literal(SettingField.SandboxDocker), value: z.literal(true), ...Found }),
]);
export type SettingSuggestion = z.infer<typeof SettingSuggestion>;

/** `POST /projects/:projectId/workbench-setup`. */
export const WorkbenchSetupDto = z.object({
  areas: WorkbenchSetupAreas,
  settings: z.array(SettingSuggestion),
});
export type WorkbenchSetupDto = z.infer<typeof WorkbenchSetupDto>;

/** `areas` with each split of `rows` whose `from` is not in `unticked` applied in `from`'s place. Pure. */
export function withSplits(
  areas: readonly AreaDef[],
  rows: readonly SplitRow[],
  unticked: readonly string[],
): AreaDef[] {
  return areas.flatMap((area): AreaDef[] => {
    const row = rows.find((r) => r.from === area.name && !unticked.includes(r.from));
    return row === undefined
      ? [{ ...area }]
      : row.into.map((part) => ({ ...part, globs: [...part.globs] }));
  });
}

/** The `ProjectPatch.areaSplits` for the rows of `rows` whose `from` is not in `unticked`. */
export const splitsOf = (
  rows: readonly SplitRow[],
  unticked: readonly string[],
): { from: string; into: string[] }[] =>
  rows
    .filter((r) => !unticked.includes(r.from))
    .map((r) => ({ from: r.from, into: r.into.map((a) => a.name) }));

/**
 * `proposed` with each page named in `unticked` dropped and its files folded back: a page whose row
 * says what area it `was` (one open tasks name) is that area again, exactly; any other loses the
 * globs a shared area of the list also covers (that area holds those files), and what is left stays
 * an area of the same name with no role and no route. A name that is no page is passed over. Pure;
 * `proposed` is not touched.
 */
export function withoutPages(
  proposed: readonly AreaDef[],
  unticked: readonly string[],
  rows: readonly PageRow[] = [],
): AreaDef[] {
  const shared = proposed.filter((a) => a.role === AreaRole.Shared);
  return proposed.flatMap((area): AreaDef[] => {
    if (area.role !== AreaRole.Page || !unticked.includes(area.name)) return [{ ...area }];
    const was = rows.find((row) => row.name === area.name)?.was;
    if (was !== undefined) return [{ ...was, globs: [...was.globs] }];
    const globs = area.globs.filter(
      (glob) => !shared.some((s) => s.globs.some((other) => globsOverlap(glob, other))),
    );
    if (globs.length === 0) return [];
    const folded: AreaDef = { name: area.name, globs };
    if (area.catchAll !== undefined) folded.catchAll = area.catchAll;
    return [folded];
  });
}

/**
 * What a project would refuse in `areas` as its new list, in the words its settings use, or null:
 * the area rules a `PATCH /projects/:id` checks, and a name one of `hazards` has.
 */
export function setupAreasProblem(
  areas: readonly AreaDef[],
  hazards: readonly string[],
): string | null {
  const clash = areas.find((a) => hazards.includes(a.name));
  if (clash !== undefined) return `A hazard is named "${clash.name}" already`;
  const parsed = ProjectPatch.safeParse({ areas });
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue === undefined) return 'These areas are not valid';
  const where = issue.path.filter((p) => typeof p === 'string' && p !== 'areas').join(' ');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}
