import {
  AreaRole,
  withoutPages,
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

/** The rows the builder can tick: the new pages and the suggested settings. */
export function suggestionCount(setup: WorkbenchSetupDto): number {
  return setup.areas.pages.length + setup.settings.length;
}

/** The pages the repository has that the project lacks, less those the builder left out before. */
export function newPagesOf(setup: WorkbenchSetupDto, leftOut: readonly string[]): PageRow[] {
  return setup.areas.pages.filter((page) => !leftOut.includes(page.name));
}

/**
 * What the picker's Set Up badge counts once the project has pages: the new pages not left out, and
 * the settings. The branch note is not counted: Apply can't clear it, so it would keep the badge up.
 */
export function setUpCount(setup: WorkbenchSetupDto, leftOut: readonly string[]): number {
  return newPagesOf(setup, leftOut).length + setup.settings.length;
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
  const offered = setup.areas.pages.map((page) => page.name);
  const ticked = offered.filter((name) => !untickedPages.includes(name));
  return [
    ...leftOut.filter((name) => !ticked.includes(name)),
    ...untickedPages.filter((name) => offered.includes(name) && !leftOut.includes(name)),
  ];
}

/**
 * The one `PATCH /projects/:id` Apply sends: the rebuilt areas, when `rebuildAreas`, with each
 * unticked page folded back (left out when that is the list the project has), the pages left out
 * from now on (`leftOutAfter`, sent only with the areas and only when it changes), and the ticked
 * settings as edited (`settingsPatch`); null when it changes nothing.
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
  const areas = withoutPages(setup.areas.proposed, untickedPages, setup.areas.pages);
  if (rebuildAreas && areasChanged(areas, current)) patch.areas = areas;
  if (rebuildAreas) {
    const next = leftOutAfter(setup, leftOut, untickedPages);
    if (next.length !== leftOut.length || next.some((name) => !leftOut.includes(name)))
      patch.leftOutPages = next;
  }
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
  const staying = current.map((a) => a.name).filter((name) => next.some((a) => a.name === name));
  if (staying.length === 0) return head;
  const named =
    staying.length <= 3
      ? staying.length === 1
        ? (staying[0] ?? '')
        : `${staying.slice(0, -1).join(', ')} and ${staying.at(-1) ?? ''}`
      : `${staying.slice(0, 3).join(', ')} and ${String(staying.length - 3)} more`;
  return `${head}; ${named} ${staying.length === 1 ? 'keeps its name' : 'keep their names'}`;
}
