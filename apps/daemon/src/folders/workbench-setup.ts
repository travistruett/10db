import { posix } from 'node:path';
import {
  AreaRole,
  InvalidError,
  type AreaDef,
  type ProjectDto,
  type WorkbenchSetupAreas,
} from '@10db/contracts';
import { OVER_BUDGET_REFUSAL, type Git } from '../git';
import {
  AreaCandidateKind,
  deriveAreaCandidates,
  fileRouteApps,
  isPageFile,
  mergeCoupledCandidates,
  treeGlobs,
  type AreaCandidate,
} from './area-candidates';
import { areasFromStructure } from './area-naming';
import { areaNameOf, codeRoutes, routerFiles, type CodePage } from './code-routes';
import { isSourceFile, readPathAliases } from './import-graph';
import { literalGlob } from './literal-glob';
import { readPageCode, type PageSeed, type TextReader } from './page-code';
import { indexPageFiles, isRedirectOnly } from './route-pages';
import { rebuildAreas, type PlannedPage } from './rebuild-areas';

/** A page of an app as the setup plans it: a screen folder, or an index page's own file. */
interface GroupPage {
  name: string;
  readonly folder?: string;
  readonly files?: readonly string[];
  readonly route: string | undefined;
  readonly routeGlobs: readonly string[];
}

/** How many of the latest commits are read for folders that change together. */
const HISTORY_COMMITS = 400;
/** What one setup may read of a repository's files, all reads together. */
const SETUP_READ_BYTES = 32 * 1024 * 1024;
/** What the setup says when a read would pass its budget. */
const OVER_BUDGET = 'the source is over 32 MB: page code is not read';
/** A router or config file larger than this is not read. */
const ROUTER_MAX_BYTES = 512 * 1024;

export interface WorkbenchSetupDeps {
  readonly git: Pick<Git, 'survey' | 'surveyTexts'>;
}

/** What the setup reads of the project. */
export type SetupProject = Pick<ProjectDto, 'repoPath' | 'areas' | 'hazards'>;

const under = (path: string, folder: string): boolean =>
  folder === '' || path.startsWith(`${folder}/`);

const parentOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

/** Each folder holding a `package.json`: the app units a router can live in. */
const packageUnits = (files: readonly string[]): string[] =>
  files.filter((f) => posix.basename(f) === 'package.json').map(parentOf);

/** The unit a code-routed page belongs to: the deepest package folder above it. */
const unitOf = (folder: string, units: readonly string[]): string =>
  units.filter((u) => under(folder, u)).sort((a, b) => b.length - a.length)[0] ?? '';

/** Why each existing area is kept: the open tasks that name it. */
function keepReasons(
  openTasks: readonly { readonly areas: readonly string[] }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const task of openTasks)
    for (const name of new Set(task.areas)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    [...counts].map(([name, n]) => [
      name,
      `kept: ${String(n)} open ${n === 1 ? 'task names' : 'tasks name'} it`,
    ]),
  );
}

/**
 * The unit candidate of an app with routes in code, split so its pages overlap only shared code:
 * its `src/` as a shared area, and the rest of the unit (its own files and other folders) beside it.
 */
function splitCodeUnit(
  candidate: AreaCandidate,
  unit: string,
  files: readonly string[],
): AreaCandidate[] {
  const src = `${unit}/src`;
  const inUnit = files.filter((f) => under(f, unit));
  const srcFiles = inUnit.filter((f) => under(f, src));
  if (srcFiles.length === 0) return [{ ...candidate, role: AreaRole.Shared }];
  const direct = inUnit.filter((f) => parentOf(f) === unit);
  const children = [
    ...new Set(
      inUnit
        .filter((f) => parentOf(f) !== unit)
        .map((f) => `${unit}/${f.slice(unit.length + 1).split('/')[0] ?? ''}`),
    ),
  ].filter((c) => c !== src);
  const restGlobs = [
    ...(direct.some((f) => !posix.basename(f).startsWith('.')) ? [`${literalGlob(unit)}/*`] : []),
    ...(direct.some((f) => posix.basename(f).startsWith('.')) ? [`${literalGlob(unit)}/.*`] : []),
    ...children.flatMap((c) => treeGlobs(c, files)),
  ];
  const shared: AreaCandidate = {
    kind: AreaCandidateKind.Folder,
    label: src,
    globs: treeGlobs(src, files),
    files: srcFiles.length,
    trees: [src],
    directs: [],
    role: AreaRole.Shared,
  };
  if (restGlobs.length === 0) return [shared];
  return [
    shared,
    {
      kind: AreaCandidateKind.Unit,
      label: unit,
      globs: restGlobs,
      files: inUnit.length - srcFiles.length,
      trees: children,
      directs: [unit],
    },
  ];
}

/** Pages named in code, for each unit with no file routes, and the folders beside them left out. */
async function codePages(
  read: TextReader,
  files: readonly string[],
  skipUnits: ReadonlySet<string>,
): Promise<{
  pages: (CodePage & { unit: string })[];
  skipped: { name: string; reason: string }[];
  /** Each unit's router and entry files, which every page of it renders inside. */
  routers: { unit: string; file: string }[];
}> {
  const units = packageUnits(files).filter((u) => !skipUnits.has(u));
  const all = packageUnits(files);
  // A router file is its own unit's: the deepest package folder above it.
  const routers = units.flatMap((unit) =>
    routerFiles(files, unit)
      .filter((file) => unitOf(file, all) === unit)
      .map((file) => ({ unit, file })),
  );
  const configs = units.flatMap((unit) =>
    ['tsconfig.json', 'jsconfig.json']
      .map((name) => (unit === '' ? name : `${unit}/${name}`))
      .filter((path) => files.includes(path)),
  );
  if (routers.length === 0) return { pages: [], skipped: [], routers: [] };
  const { texts } = await read([...routers.map((r) => r.file), ...configs], ROUTER_MAX_BYTES);
  const pages: (CodePage & { unit: string })[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const unit of units) {
    const mine = routers.filter((r) => r.unit === unit);
    if (mine.length === 0) continue;
    const config = configs.find((c) => parentOf(c) === unit);
    const configText = config === undefined ? undefined : texts.get(config);
    const found = codeRoutes({
      files,
      routers: new Map(
        mine.flatMap((r) => {
          const text = texts.get(r.file);
          return text === undefined ? [] : [[r.file, text] as const];
        }),
      ),
      aliases: readPathAliases(
        config === undefined || configText === undefined
          ? null
          : { path: config, text: configText },
      ),
    });
    pages.push(...found.pages.map((p) => ({ ...p, unit: unitOf(p.folder, units) })));
    skipped.push(...found.unrouted.map((u) => ({ name: u.name, reason: u.reason })));
  }
  return { pages, skipped, routers };
}

/**
 * The Workbench setup's areas for the project: its repository's structure (`area-candidates`, the
 * history merge, names from paths), each page of each app (file routes, or routes in code) with the
 * code only it imports (`page-code`), and the existing areas open tasks name kept (`rebuild-areas`).
 * Everything is read from HEAD in git's object store; nothing of the checkout is opened or run.
 */
export async function proposeSetupAreas(
  deps: WorkbenchSetupDeps,
  project: SetupProject,
  openTasks: readonly { readonly areas: readonly string[] }[],
  signal?: AbortSignal,
): Promise<WorkbenchSetupAreas> {
  const survey = await deps.git.survey(project.repoPath, HISTORY_COMMITS);
  if ('refused' in survey) throw new InvalidError(survey.message);
  signal?.throwIfAborted();
  const { files, commits } = survey;
  const candidates = deriveAreaCandidates(files);
  const apps = fileRouteApps(files);
  const isPage = (c: AreaCandidate) =>
    c.kind === AreaCandidateKind.Route &&
    c.role === AreaRole.Page &&
    c.trees.length === 1 &&
    c.trees[0] === c.label;
  const fileUnits = new Set(apps.map((a) => a.unit));
  // Every read of the setup together stays within one budget, and stops when the request goes.
  let budget = SETUP_READ_BYTES;
  const refusals = new Set<string>();
  const read: TextReader = async (paths, maxBytes) => {
    signal?.throwIfAborted();
    const found = await deps.git.surveyTexts(project.repoPath, paths, {
      maxBytes,
      maxTotalBytes: budget,
      ...(signal === undefined ? {} : { signal }),
    });
    budget -= found.bytes;
    if (found.refused === null) return found;
    const refused = found.refused === OVER_BUDGET_REFUSAL ? OVER_BUDGET : found.refused;
    refusals.add(refused);
    return { ...found, refused };
  };
  const code = await codePages(read, files, fileUnits);
  signal?.throwIfAborted();

  // A screen whose page files only redirect is no page: its folder stays an area with no role.
  const indexes = apps.flatMap((app) =>
    indexPageFiles(files, app).map((index) => ({ ...index, app })),
  );
  const screenPages = (c: AreaCandidate) => files.filter((f) => isPageFile(f) && under(f, c.label));
  const { texts: pageTexts } = await read(
    [...candidates.filter(isPage).flatMap(screenPages), ...indexes.map((i) => i.file)],
    ROUTER_MAX_BYTES,
  );
  signal?.throwIfAborted();
  const redirects = (paths: readonly string[]) =>
    paths.length > 0 &&
    paths.every((f) => {
      const text = pageTexts.get(f);
      return text !== undefined && isRedirectOnly(text);
    });
  const skipped = [...code.skipped];
  const routed = candidates.map((c): AreaCandidate => {
    if (!isPage(c) || !redirects(screenPages(c))) return c;
    skipped.push({
      name: areaNameOf(posix.basename(c.label)),
      reason: 'redirects to another page',
    });
    return {
      kind: c.kind,
      label: c.label,
      globs: c.globs,
      files: c.files,
      trees: c.trees,
      directs: c.directs,
    };
  });

  // The units of apps with routes in code are split, so their pages overlap only shared code.
  const codeUnits = new Set(code.pages.map((p) => p.unit));
  const structural = routed.flatMap((c) =>
    !isPage(c) &&
    c.kind === AreaCandidateKind.Unit &&
    codeUnits.has(c.label) &&
    c.trees.length === 1 &&
    c.trees[0] === c.label
      ? splitCodeUnit(c, c.label, files)
      : [c],
  );
  const pageCandidates = structural.filter(isPage);
  // Code the pages share stays apart from what changes beside it; only areas with no role merge.
  const merged = [
    ...mergeCoupledCandidates(
      structural.filter((c) => !isPage(c) && c.role === undefined),
      commits,
    ),
    ...structural.filter((c) => !isPage(c) && c.role !== undefined),
  ];
  const named = areasFromStructure([...pageCandidates, ...merged]);
  const toArea = (area: (typeof named)[number]): AreaDef => {
    const def: AreaDef = { name: area.name, globs: area.globs };
    if (area.catchAll !== undefined) def.catchAll = area.catchAll;
    if (area.role !== undefined) def.role = area.role;
    if (area.route !== undefined) def.route = area.route;
    return def;
  };
  const others = named.slice(pageCandidates.length).map((area, i) => {
    const candidate = merged[i];
    const label = candidate?.role === AreaRole.Shared ? candidate.label : '';
    const unit = parentOf(label);
    return label.endsWith('/src') && codeUnits.has(unit)
      ? { ...toArea(area), name: `${areaNameOf(posix.basename(unit))}-shared` }
      : toArea(area);
  });

  // An app's root layout is shared; where the structure left it in the catch-all, it gets its own area.
  for (const app of apps) {
    const direct = files.filter((f) => parentOf(f) === app.routes);
    const layoutGlob = `${literalGlob(app.routes)}/*`;
    if (
      direct.length === 0 ||
      others.some((a) => a.role === AreaRole.Shared && a.globs.includes(layoutGlob))
    )
      continue;
    const dotted = direct.some((f) => posix.basename(f).startsWith('.'));
    others.push({
      name: app.unit === '' ? 'layout' : `${areaNameOf(posix.basename(app.unit))}-layout`,
      globs: dotted ? [layoutGlob, `${literalGlob(app.routes)}/.*`] : [layoutGlob],
      role: AreaRole.Shared,
    });
  }

  // Each app's pages and the code only each imports.
  const planned: PlannedPage[] = [];
  // A layout's code is every page's; a screen of its own there (`page.tsx`, the `/` route) is not.
  const sourceIn = (folders: readonly string[]) =>
    files.filter(
      (f) =>
        isSourceFile(f) && folders.includes(parentOf(f)) && !posix.basename(f).startsWith('page.'),
    );
  const groups = [
    ...apps.map((app) => ({
      unit: app.unit,
      sharedRoots: sourceIn(app.layoutFolders),
      pages: pageCandidates
        .map((c, i) => ({ c, name: named[i]?.name ?? areaNameOf(posix.basename(c.label)) }))
        .filter(({ c }) => under(c.label, app.routes))
        .map(({ c, name }): GroupPage => ({
          name,
          folder: c.label,
          route: c.route,
          routeGlobs: c.globs,
        }))
        .concat(
          // An index page (a group's own `page.tsx`) is a page of its own, at the path it shows.
          indexes
            .filter((index) => index.app === app)
            .flatMap((index): GroupPage[] => {
              if (redirects([index.file])) {
                skipped.push({ name: index.file, reason: 'redirects to another page' });
                return [];
              }
              const last = index.route.split('/').at(-1) ?? '';
              return [
                {
                  name: last === '' ? 'home' : areaNameOf(last),
                  files: [index.file],
                  route: index.route,
                  routeGlobs: [literalGlob(index.file)],
                },
              ];
            }),
        ),
    })),
    ...[...codeUnits].map((unit) => ({
      unit,
      // The router and its entry, and the shell they reach outside the pages, are every page's.
      sharedRoots: code.routers.filter((r) => r.unit === unit).map((r) => r.file),
      pages: code.pages
        .filter((p) => p.unit === unit)
        .map((p): GroupPage => ({
          name: p.name,
          folder: p.folder,
          route: p.route,
          routeGlobs: treeGlobs(p.folder, files),
        })),
    })),
  ];
  for (const group of groups) {
    if (group.pages.length === 0) continue;
    signal?.throwIfAborted();
    const names = new Set<string>();
    for (const page of group.pages) {
      let name = page.name;
      for (let n = 2; names.has(name); n += 1) name = `${page.name}-${String(n)}`;
      names.add(name);
      page.name = name;
    }
    const seeds = group.pages.map((p): PageSeed => {
      if (p.files !== undefined) return { name: p.name, files: p.files };
      return p.folder === undefined ? { name: p.name } : { name: p.name, folder: p.folder };
    });
    const found = await readPageCode(read, {
      unit: group.unit,
      files,
      pages: seeds,
      sharedRoots: group.sharedRoots,
    });
    if (found.note !== null && !refusals.has(found.note))
      skipped.push({ name: group.unit === '' ? 'app' : group.unit, reason: found.note });
    for (const page of group.pages) {
      const base = {
        name: page.name,
        routeGlobs: page.routeGlobs,
        takenGlobs: found.taken.get(page.name) ?? [],
      };
      planned.push(page.route === undefined ? base : { ...base, route: page.route });
    }
  }

  for (const reason of refusals) skipped.push({ name: 'page code', reason });
  return rebuildAreas({
    files,
    existing: project.areas,
    hazards: project.hazards.map((h) => h.name),
    keep: new Map(
      [...keepReasons(openTasks)].filter(([name]) => project.areas.some((a) => a.name === name)),
    ),
    others,
    pages: planned,
    skipped,
  });
}
