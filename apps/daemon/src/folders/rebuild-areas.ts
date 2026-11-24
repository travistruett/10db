import {
  AreaRole,
  globsOverlap,
  setupAreasProblem,
  withoutPages,
  type AreaDef,
  type PageRow,
  type SplitRow,
  type WorkbenchSetupAreas,
} from '@10db/contracts';
import { globReaches } from './area-candidates';

// Workbench setup: the project's areas rebuilt from the repository, every page with its code, the
// code pages share marked shared, and only the areas open tasks name kept as they are.

/** A page the setup proposes: its route folder's globs, and the code only it imports. */
export interface PlannedPage {
  readonly name: string;
  readonly route?: string;
  /** What the app's nav calls the page, when it names one. */
  readonly label?: string;
  readonly routeGlobs: readonly string[];
  readonly takenGlobs: readonly string[];
}

export interface RebuildInput {
  /** Every tracked file of the repository. */
  readonly files: readonly string[];
  readonly existing: readonly AreaDef[];
  /** The project's hazard names, which no area may take. */
  readonly hazards: readonly string[];
  /** The existing areas to keep, each with why (open tasks name it). */
  readonly keep: ReadonlyMap<string, string>;
  /** The new list's areas that are not pages, from the repository's structure, in order. */
  readonly others: readonly AreaDef[];
  readonly pages: readonly PlannedPage[];
  /** What the page finders left out, with why. */
  readonly skipped: readonly { name: string; reason: string }[];
  /** Kept areas that split along their packages (`broadAreaSplit`), by name, with how many open tasks name each. */
  readonly splits?: ReadonlyMap<
    string,
    { readonly core: AreaDef; readonly parts: readonly AreaDef[]; readonly tasks: number }
  >;
}

const overlaps = (one: readonly string[], other: readonly string[]): boolean =>
  one.some((a) => other.some((b) => globsOverlap(a, b)));

const sameSet = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((g) => other.includes(g));

/** A route folder's globs with its dotfile companions set aside: `<folder>/**` and what follows it. */
function isRouteFolderOf(globs: readonly string[], page: PlannedPage): boolean {
  const tree = page.routeGlobs.find((g) => g.endsWith('/**') && !g.includes('/**/'));
  return (
    tree !== undefined && globs.includes(tree) && globs.every((g) => page.routeGlobs.includes(g))
  );
}

/** `name`, or `name-2`, `name-3`… the first that `used` lacks; the one returned is added to it. */
function unique(name: string, used: Set<string>): string {
  let picked = name;
  for (let n = 2; used.has(picked); n += 1) picked = `${name}-${String(n)}`;
  used.add(picked);
  return picked;
}

/** A glob shown as the folder or file it names: `a/[[]id]/**` is `a/[id]/`. */
function shownPath(glob: string): string | null {
  if (glob.includes('/**/')) return null;
  const path = glob.endsWith('/**') ? glob.slice(0, -2) : glob;
  return path.replace(/\[(.)\]/gu, '$1');
}

const sameArea = (one: AreaDef, other: AreaDef): boolean =>
  one.name === other.name &&
  sameSet(one.globs, other.globs) &&
  (one.role ?? null) === (other.role ?? null) &&
  (one.route ?? null) === (other.route ?? null) &&
  (one.label ?? null) === (other.label ?? null) &&
  (one.catchAll ?? false) === (other.catchAll ?? false);

const sameList = (one: readonly AreaDef[], other: readonly AreaDef[]): boolean =>
  one.length === other.length && one.every((a) => other.some((b) => sameArea(a, b)));

/** `area` with a label when it has none and `from` guesses one; a label already there stays. */
function withLabel(area: AreaDef, from: { readonly label?: string | undefined }): AreaDef {
  const label = area.label ?? from.label;
  return label === undefined ? area : { ...area, label };
}

/** The files of `files` that `area`'s globs match. */
const filesOf = (area: AreaDef, files: readonly string[]): string[] =>
  files.filter((f) => area.globs.some((g) => globReaches(f, g)));

/**
 * The project's new area list. Kept areas come first, exactly as they are, except that one whose
 * globs are a page's route folder becomes that page (its globs only grow, so no open task loses a
 * file). Then the pages, then the other areas: one with no role whose files kept areas already hold
 * goes, one a page holds whole goes, one a page overlaps is marked shared, and a name a kept area or
 * hazard has is made unique. A list the project would refuse loses its last page, with the words,
 * until it is valid. A list that is the project's own is answered with no page. Pure.
 */
export function rebuildAreas(input: RebuildInput): WorkbenchSetupAreas {
  // A kept area's split stays a row the builder ticks: its parts' names are reserved, and it is
  // offered on every path, so a project with nothing else to rebuild still sees it.
  const splits: SplitRow[] = [];
  for (const [name, split] of input.splits ?? []) {
    const was = input.existing.find((a) => a.name === name);
    if (was === undefined || !input.keep.has(name)) continue;
    splits.push({
      from: name,
      into: [split.core, ...split.parts].map((a) => ({ ...a, globs: [...a.globs] })),
      was: { ...was, globs: [...was.globs] },
      tasks: split.tasks,
    });
  }
  const used = new Set([...input.hazards, ...splits.flatMap((row) => row.into.map((a) => a.name))]);
  const skipped = [...input.skipped];
  /** The page the setup found for a kept page area, by name or route: its guessed label. */
  const guessFor = (area: AreaDef): { readonly label?: string } =>
    input.pages.find(
      (p) => p.name === area.name || (area.route !== undefined && p.route === area.route),
    ) ?? {};
  const keptReasons: { name: string; reason: string }[] = [];
  const kept: AreaDef[] = [];
  const pending = [...input.pages];
  for (const area of input.existing) {
    const reason = input.keep.get(area.name);
    if (reason === undefined) continue;
    used.add(area.name);
    const page =
      area.role === undefined ? pending.find((p) => isRouteFolderOf(area.globs, p)) : undefined;
    if (page === undefined) {
      kept.push(area.role === AreaRole.Page ? withLabel({ ...area }, guessFor(area)) : { ...area });
      keptReasons.push({ name: area.name, reason });
      continue;
    }
    pending.splice(pending.indexOf(page), 1);
    // A kept area that becomes a page is never split.
    const row = splits.findIndex((r) => r.from === area.name);
    if (row >= 0) splits.splice(row, 1);
    const grown: AreaDef = {
      ...area,
      globs: [...new Set([...area.globs, ...page.takenGlobs])],
      role: AreaRole.Page,
    };
    kept.push(withLabel(page.route === undefined ? grown : { ...grown, route: page.route }, page));
    keptReasons.push({
      name: area.name,
      reason: `${reason}; it becomes the page${page.route === undefined ? '' : ` at ${page.route}`}`,
    });
  }

  const keptPages = kept.filter((a) => a.role === AreaRole.Page);
  const pages: AreaDef[] = [];
  for (const page of pending) {
    const clash = keptPages.find((k) => overlaps(page.routeGlobs, k.globs));
    if (clash !== undefined) {
      skipped.push({
        name: page.name,
        reason: `It would share files with the kept page "${clash.name}"`,
      });
      continue;
    }
    const taken = page.takenGlobs.filter((g) => !keptPages.some((k) => overlaps([g], k.globs)));
    const name = unique(page.name, used);
    const area: AreaDef = {
      name,
      globs: [...new Set([...page.routeGlobs, ...taken])],
      role: AreaRole.Page,
    };
    // A label the builder set stays; a page with none gets the guess.
    const own = input.existing.find((e) => e.role === AreaRole.Page && e.name === name)?.label;
    pages.push(
      withLabel(page.route === undefined ? area : { ...area, route: page.route }, {
        label: own ?? page.label,
      }),
    );
  }

  const keptFiles = new Set(kept.flatMap((a) => filesOf(a, input.files)));
  const keptCatchAll = kept.some((a) => a.catchAll === true);
  const pageGlobs = [...keptPages, ...pages].map((p) => p.globs);
  const others: AreaDef[] = [];
  for (const other of input.others) {
    const { catchAll, ...rest } = other;
    const area: AreaDef = catchAll === true && !keptCatchAll ? { ...rest, catchAll } : rest;
    const files = filesOf(area, input.files);
    if (area.role === undefined && files.length > 0 && files.every((f) => keptFiles.has(f)))
      continue;
    if (pageGlobs.some((globs) => area.globs.every((g) => globs.includes(g)))) continue;
    const touched =
      area.role === undefined && pageGlobs.some((globs) => overlaps(area.globs, globs));
    others.push({
      ...area,
      name: unique(area.name, used),
      ...(touched ? { role: AreaRole.Shared } : {}),
    });
  }

  let proposed = [...kept, ...pages, ...others];
  let problem = setupAreasProblem(proposed, input.hazards);
  while (problem !== null) {
    const last = pages.pop();
    if (last === undefined) break;
    skipped.push({ name: last.name, reason: problem });
    proposed = withoutPages(proposed, [last.name]).filter((area) => {
      if (area.name !== last.name) return true;
      const covered = new Set(
        proposed.filter((a) => a.name !== last.name).flatMap((a) => filesOf(a, input.files)),
      );
      return !filesOf(area, input.files).every((f) => covered.has(f));
    });
    problem = setupAreasProblem(proposed, input.hazards);
  }
  // A rebuild that finds no page has nothing to offer the Workbench: the project keeps its own list.
  const noPage = !proposed.some((a) => a.role === AreaRole.Page);
  if (problem !== null || noPage || sameList(proposed, input.existing))
    return {
      proposed: input.existing.map((a) => ({ ...a })),
      kept: keptReasons,
      pages: [],
      skipped: problem === null ? skipped : [...skipped, { name: 'areas', reason: problem }],
      splits,
    };

  // A page is new only when no page of the project has its name: a changed label, route or glob is
  // part of the rebuild, so unticking a row never demotes a page the project already has.
  const newPages = proposed.filter(
    (a) =>
      a.role === AreaRole.Page &&
      !input.existing.some((e) => e.role === AreaRole.Page && e.name === a.name),
  );
  return {
    proposed,
    kept: keptReasons,
    pages: newPages.map((a): PageRow => {
      const folders = a.globs.flatMap((g) => {
        const path = shownPath(g);
        return path === null ? [] : [path];
      });
      const row: PageRow = { name: a.name, folders: folders.length > 0 ? folders : [...a.globs] };
      if (a.route !== undefined) row.route = a.route;
      if (a.label !== undefined) row.label = a.label;
      // A kept area that became this page is put back exactly when the page is unticked.
      const was = input.keep.has(a.name)
        ? input.existing.find((e) => e.name === a.name)
        : undefined;
      if (was !== undefined) row.was = { ...was, globs: [...was.globs] };
      return row;
    }),
    skipped,
    splits,
  };
}
