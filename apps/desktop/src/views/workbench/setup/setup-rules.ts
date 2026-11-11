import {
  AreaRole,
  withoutPages,
  type AreaDef,
  type ProjectPatch,
  type SettingField,
  type WorkbenchSetupDto,
} from '@10db/contracts';

/** Two areas the same in every field, globs in any order. */
const sameArea = (one: AreaDef, other: AreaDef): boolean =>
  one.name === other.name &&
  one.globs.length === other.globs.length &&
  one.globs.every((g) => other.globs.includes(g)) &&
  (one.role ?? null) === (other.role ?? null) &&
  (one.route ?? null) === (other.route ?? null) &&
  (one.catchAll ?? false) === (other.catchAll ?? false);

/** Whether `next` is another list than `current`, the order of either aside. */
export function areasChanged(next: readonly AreaDef[], current: readonly AreaDef[]): boolean {
  return next.length !== current.length || next.some((a) => !current.some((b) => sameArea(a, b)));
}

/** The rows the builder can tick: the new pages and the suggested settings. */
export function suggestionCount(setup: WorkbenchSetupDto): number {
  return setup.areas.pages.length + setup.settings.length;
}

/**
 * What the picker's Set Up (n) counts once the project has pages: the settings and the branch note.
 * New page rows still show in the setup, but a page the builder left out is not asked for again.
 */
export function setUpCount(setup: WorkbenchSetupDto): number {
  return setup.settings.length + (setup.branch === null ? 0 : 1);
}

/**
 * The one `PATCH /projects/:id` Apply sends: the rebuilt areas, when `rebuildAreas`, with each
 * unticked page folded back (left out when that is the list the project has), and each ticked
 * setting; null when it changes nothing.
 */
export function setupPatch(
  setup: WorkbenchSetupDto,
  current: readonly AreaDef[],
  untickedPages: readonly string[],
  tickedSettings: readonly SettingField[],
  rebuildAreas = true,
): ProjectPatch | null {
  const patch: ProjectPatch = {};
  const areas = withoutPages(setup.areas.proposed, untickedPages, setup.areas.pages);
  if (rebuildAreas && areasChanged(areas, current)) patch.areas = areas;
  for (const setting of setup.settings) {
    if (!tickedSettings.includes(setting.field)) continue;
    switch (setting.field) {
      case 'appUrl':
        patch.appUrl = setting.value;
        break;
      case 'devLoginCommand':
        patch.devLoginCommand = setting.value;
        break;
      case 'changedCheckCommand':
        patch.changedCheckCommand = setting.value;
        break;
      case 'sandboxDocker':
        patch.sandboxDocker = setting.value;
        break;
    }
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
