import { z } from 'zod';
import { AppUrl, AreaDef, AreaName, PathPattern, ProjectPatch } from './entities';
import { BranchName } from './git-names';
import { AreaRole, AreaRoute } from './page-areas';

// Workbench setup (`POST /projects/:projectId/workbench-setup`): what 10db proposes so a project is
// ready for its first pass, each change a row the builder ticks, all of it saved by one Apply.

/** One line the setup screen shows. */
const Line = z
  .string()
  .min(1)
  .max(500)
  .refine((t) => !/\p{Cc}/u.test(t), 'one line, with no control characters');

/** An area's globs as a project accepts them. */
const Globs = z.array(PathPattern);

/** An area a change writes whole. */
const ProposedAreaDef = AreaDef.extend({ globs: Globs.min(1) });

/** A page area a split makes. */
const SplitPage = ProposedAreaDef.extend({ role: z.literal(AreaRole.Page) });

/** What a change does to the project's areas. */
export const AreaChangeKind = {
  /** An area whose globs are one page's route folder becomes that page: role, route and its code. */
  Update: 'update',
  /** An area holding several pages' route folders gives each its own page area; the rest keeps the name. */
  Split: 'split',
  /** An area of code the pages share is marked so. */
  MarkShared: 'markShared',
  /** A new area: a page no area holds, or the app's shared source folder. */
  Add: 'add',
} as const;
export type AreaChangeKind = (typeof AreaChangeKind)[keyof typeof AreaChangeKind];

const Said = { sentence: Line, reason: Line };

export const AreaChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(AreaChangeKind.Update),
    ...Said,
    /** The existing area, which keeps its name. */
    area: AreaName,
    /** Absent for a page no single path shows. */
    route: AreaRoute.optional(),
    /** The page's code outside its route folder, added to the area's globs. */
    addGlobs: Globs,
  }),
  z.object({
    kind: z.literal(AreaChangeKind.Split),
    ...Said,
    area: AreaName,
    pages: z.array(SplitPage).min(1),
    /** What the area keeps under its name; null when it held only the pages' folders and goes. */
    remainder: z
      .object({ globs: Globs.min(1), role: z.literal(AreaRole.Shared).optional() })
      .nullable(),
  }),
  z.object({ kind: z.literal(AreaChangeKind.MarkShared), ...Said, area: AreaName }),
  z.object({ kind: z.literal(AreaChangeKind.Add), ...Said, area: ProposedAreaDef }),
]);
export type AreaChange = z.infer<typeof AreaChange>;

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

/** The base branch's commits `origin` lacks, and the command that pushes them, for the builder to run. */
export const BranchNote = z.object({
  branch: BranchName,
  ahead: z.int().positive(),
  command: z.string().min(1),
});
export type BranchNote = z.infer<typeof BranchNote>;

/** `POST /projects/:projectId/workbench-setup`. */
export const WorkbenchSetupDto = z.object({
  pages: z.object({
    changes: z.array(AreaChange),
    /** Pages proposed and left out, each with why. */
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  }),
  settings: z.array(SettingSuggestion),
  branch: BranchNote.nullable(),
});
export type WorkbenchSetupDto = z.infer<typeof WorkbenchSetupDto>;

/** `area` with `role` set, or with no role and no route when `role` is absent. */
function withRole(area: AreaDef, role: AreaRole | undefined): AreaDef {
  const rest: AreaDef = { name: area.name, globs: area.globs };
  if (area.catchAll !== undefined) rest.catchAll = area.catchAll;
  return role === undefined ? rest : { ...rest, role };
}

/**
 * The areas with `changes` applied, in order: each change is independent, so any subset applies and
 * gives each area it writes what that change alone would. A change whose area is gone, or whose new
 * name an area has already, is passed over. Pure; `areas` is not touched.
 */
export function applyAreaChanges(
  areas: readonly AreaDef[],
  changes: readonly AreaChange[],
): AreaDef[] {
  let result = [...areas];
  for (const change of changes) {
    if (change.kind === AreaChangeKind.Add) {
      if (!result.some((a) => a.name === change.area.name)) result.push({ ...change.area });
      continue;
    }
    const at = result.findIndex((a) => a.name === change.area);
    const area = result[at];
    if (area === undefined) continue;
    switch (change.kind) {
      case AreaChangeKind.Update: {
        const globs = [...new Set([...area.globs, ...change.addGlobs])];
        const page = { ...withRole(area, AreaRole.Page), globs };
        result[at] = change.route === undefined ? page : { ...page, route: change.route };
        break;
      }
      case AreaChangeKind.MarkShared:
        result[at] = withRole(area, AreaRole.Shared);
        break;
      case AreaChangeKind.Split: {
        const pages = change.pages.filter((p) => !result.some((a) => a.name === p.name));
        const kept =
          change.remainder === null
            ? []
            : [
                {
                  ...withRole(
                    area,
                    change.remainder.role ??
                      (area.role === AreaRole.Shared ? AreaRole.Shared : undefined),
                  ),
                  globs: [...change.remainder.globs],
                },
              ];
        result = [
          ...result.slice(0, at),
          ...kept,
          ...pages.map((p) => ({ ...p })),
          ...result.slice(at + 1),
        ];
        break;
      }
    }
  }
  return result;
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
