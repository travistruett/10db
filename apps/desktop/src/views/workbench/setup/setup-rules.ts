import {
  AreaRole,
  splitsOf,
  withoutPages,
  withSplits,
  type AreaDef,
  type PageRow,
  type ProjectPatch,
  type WorkbenchSetupDto,
} from '@10db/contracts';

/** Two areas the same in every field, globs in any order. */
const sameArea = (one: AreaDef, other: AreaDef): boolean =>
  one.name === other.name &&
  one.globs.length === other.globs.length &&
  one.globs.every((g) => other.globs.includes(g)) &&
  (one.role ?? null) === (other.role ?? null) &&
  (one.route ?? null) === (other.route ?? null) &&
  (one.label ?? null) === (other.label ?? null) &&
  (one.catchAll ?? false) === (other.catchAll ?? false);

/** Whether `next` is another list than `current`, the order of either aside. */
export function areasChanged(next: readonly AreaDef[], current: readonly AreaDef[]): boolean {
  return next.length !== current.length || next.some((a) => !current.some((b) => sameArea(a, b)));
}

/** The rows the builder can tick: the new pages, the splits and the suggested settings. */
export function suggestionCount(setup: WorkbenchSetupDto): number {
  return setup.areas.pages.length + setup.areas.splits.length + setup.settings.length;
}

/** The pages the repository has that the project lacks, less those the builder left out before. */
export function newPagesOf(setup: WorkbenchSetupDto, leftOut: readonly string[]): PageRow[] {
  return setup.areas.pages.filter((page) => !leftOut.includes(page.name));
}

/**
 * What the picker's Set Up badge counts once the project has pages: the new pages not left out, and
 * the settings.
 */
export function setUpCount(setup: WorkbenchSetupDto, leftOut: readonly string[]): number {
  const splits = setup.areas.splits.filter((row) => !leftOut.includes(row.from));
  return newPagesOf(setup, leftOut).length + splits.length + setup.settings.length;
}

/**
 * The pages left out after Apply: those left out before, less each new page ticked, plus each new
 * page unticked. A name the setup no longer finds stays as it was.
 */
export function leftOutAfter(
  setup: WorkbenchSetupDto,
  leftOut: readonly string[],
  untickedPages: readonly string[],
): string[] {
  const offered = [
    ...setup.areas.pages.map((page) => page.name),
    ...setup.areas.splits.map((row) => row.from),
  ];
  const ticked = offered.filter((name) => !untickedPages.includes(name));
  return [
    ...leftOut.filter((name) => !ticked.includes(name)),
    ...untickedPages.filter((name) => offered.includes(name) && !leftOut.includes(name)),
  ];
}

/** The list Apply saves: the rebuilt areas when `rebuildAreas` changes them, else the project's own, with each ticked split applied. */
export function areasAfter(
  setup: WorkbenchSetupDto,
  current: readonly AreaDef[],
  unticked: readonly string[],
  rebuildAreas: boolean,
): AreaDef[] {
  const rebuilt = withoutPages(setup.areas.proposed, unticked, setup.areas.pages);
  const base = rebuildAreas && areasChanged(rebuilt, current) ? rebuilt : current;
  return withSplits(base, setup.areas.splits, unticked);
}

/**
 * The one `PATCH /projects/:id` Apply sends: the areas (`areasAfter`) with the ticked splits, whose
 * open tasks the daemon retags in the same write; the pages and splits left out from now on
 * (`leftOutAfter`, sent on its own too, only when it changes); and the ticked settings as edited
 * (`settingsPatch`); null when it changes nothing. `untickedPages` holds unticked pages and splits.
 */
export function setupPatch(
  setup: WorkbenchSetupDto,
  current: readonly AreaDef[],
  untickedPages: readonly string[],
  settings: ProjectPatch,
  rebuildAreas = true,
  leftOut: readonly string[] = [],
): ProjectPatch | null {
  const patch: ProjectPatch = { ...settings };
  const areas = areasAfter(setup, current, untickedPages, rebuildAreas);
  if (areasChanged(areas, current)) {
    patch.areas = areas;
    const splits = splitsOf(setup.areas.splits, untickedPages).filter((split) =>
      current.some((a) => a.name === split.from),
    );
    if (splits.length > 0) patch.areaSplits = splits;
  }
  const next = leftOutAfter(setup, leftOut, untickedPages);
  if (next.length !== leftOut.length || next.some((name) => !leftOut.includes(name)))
    patch.leftOutPages = next;
  return Object.keys(patch).length === 0 ? null : patch;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** "22 areas → 21: 17 pages, 2 shared, 2 other; backend, root and 3 more keep their names". */
export function areasSummary(current: readonly AreaDef[], next: readonly AreaDef[]): string {
  const pages = next.filter((a) => a.role === AreaRole.Page).length;
  const shared = next.filter((a) => a.role === AreaRole.Shared).length;
  const head =
    `${plural(current.length, 'area', 'areas')} → ${String(next.length)}: ` +
    `${plural(pages, 'page', 'pages')}, ${String(shared)} shared, ${String(next.length - pages - shared)} other`;
  const labelled = next.filter(
    (a) =>
      a.role === AreaRole.Page &&
      a.label !== undefined &&
      current.some((c) => c.name === a.name) &&
      current.find((c) => c.name === a.name)?.label !== a.label,
  ).length;
  const staying = current.map((a) => a.name).filter((name) => next.some((a) => a.name === name));
  const labels = labelled === 0 ? '' : `; ${plural(labelled, 'page label', 'page labels')} set`;
  if (staying.length === 0) return `${head}${labels}`;
  const named =
    staying.length <= 3
      ? staying.length === 1
        ? (staying[0] ?? '')
        : `${staying.slice(0, -1).join(', ')} and ${staying.at(-1) ?? ''}`
      : `${staying.slice(0, 3).join(', ')} and ${String(staying.length - 3)} more`;
  return `${head}; ${named} ${staying.length === 1 ? 'keeps its name' : 'keep their names'}${labels}`;
}
