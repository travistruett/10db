import { posix } from 'node:path';
import { literalGlob } from './literal-glob';

/** What kind of place a candidate area is, which decides what may merge with it. */
export const AreaCandidateKind = {
  /** A package or app: a folder with its own manifest. Two units are never merged. */
  Unit: 'unit',
  /** A screen or route group of a framework app. */
  Route: 'route',
  /** An ordinary folder, or the part of a unit that is not a screen. */
  Folder: 'folder',
  /** Whatever no other candidate holds: the top of the repository and its small folders. */
  Rest: 'rest',
} as const;
export type AreaCandidateKind = (typeof AreaCandidateKind)[keyof typeof AreaCandidateKind];

/** The folders something holds: some with everything below them, some for their own files only. */
interface Holder {
  /** Folders held with every file below them. */
  readonly trees: readonly string[];
  /** Folders held for the files directly in them, and not for the folders below them. */
  readonly directs: readonly string[];
}

/** A place in the repository that could be an area, before anyone has named it. */
export interface AreaCandidate extends Holder {
  readonly kind: AreaCandidateKind;
  /** The path that names the candidate (`.` for the top of the repository). */
  readonly label: string;
  /** Every file in the candidate matches one of these, and no file of another candidate does. */
  readonly globs: readonly string[];
  /** The tracked files it holds. */
  readonly files: number;
}

/** A folder holding one of these is a package or an app. */
const MANIFESTS: ReadonlySet<string> = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'Package.swift',
  'deno.json',
]);

/** Where a framework app keeps its routes, in the order they are looked for. */
const ROUTE_ROOTS = ['app', 'src/app', 'pages', 'src/pages'] as const;

/** A folder with fewer files than this is not worth an area of its own. */
const MIN_FILES = 3;
/** A route group needs this many screens before it is split into them. */
const MIN_SCREENS = 3;
/** A commit touching more candidates than this is a sweep, not a sign of coupling. */
const MAX_COMMIT_SPREAD = 4;
const MIN_SHARED_COMMITS = 4;
const MIN_COUPLING = 0.75;

interface Dir {
  readonly path: string;
  readonly dirs: Map<string, Dir>;
  /** Paths of the files directly in this folder. */
  readonly direct: string[];
  total: number;
}

const newDir = (path: string): Dir => ({ path, dirs: new Map(), direct: [], total: 0 });

function buildTree(files: readonly string[]): Dir {
  const root = newDir('');
  for (const file of files) {
    const parts = file.split('/');
    let dir = root;
    dir.total += 1;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = newDir(dir.path === '' ? part : `${dir.path}/${part}`);
        dir.dirs.set(part, next);
      }
      dir = next;
      dir.total += 1;
    }
    dir.direct.push(file);
  }
  return root;
}

const baseName = (path: string) => posix.basename(path);
const isManifestDir = (dir: Dir) => dir.direct.some((f) => MANIFESTS.has(baseName(f)));
const holdsUnit = (dir: Dir): boolean =>
  [...dir.dirs.values()].some((d) => isManifestDir(d) || holdsUnit(d));
const isRouteGroup = (name: string) => /^\(.+\)$/u.test(name);

/** Where in the repository a draft candidate lives: whole folders and folders' own files. */
interface Draft extends Holder {
  readonly kind: AreaCandidateKind;
  readonly label: string;
  readonly trees: string[];
  readonly directs: string[];
}

const draftOf = (kind: AreaCandidateKind, label: string, tree: string): Draft => ({
  kind,
  label,
  trees: [tree],
  directs: [],
});

/** The folders `steps` below `dir`, one for each step, or null when one step is missing. */
function descend(dir: Dir, steps: readonly string[]): Dir[] | null {
  const way: Dir[] = [];
  let at = dir;
  for (const step of steps) {
    const next = at.dirs.get(step);
    if (next === undefined) return null;
    way.push(next);
    at = next;
  }
  return way;
}

/** The route folder of a framework app, and the folders between the app and it (`src` of `src/app`). */
interface RouteRoot {
  readonly routes: Dir;
  readonly between: readonly Dir[];
}

/** Where a framework app keeps its routes, when it has route groups. */
function routeRootOf(unit: Dir): RouteRoot | null {
  for (const candidate of ROUTE_ROOTS) {
    const way = descend(unit, candidate.split('/'));
    const routes = way?.at(-1);
    if (way && routes && [...routes.dirs.keys()].some(isRouteGroup))
      return { routes, between: way.slice(0, -1) };
  }
  return null;
}

/**
 * The folder whose children are a route group's screens: the group itself, or the one folder below it
 * (`(product)/app/`) when the group holds only that.
 */
function screensOf(group: Dir): { container: Dir; passed: Dir[] } | null {
  const passed: Dir[] = [];
  let node = group;
  for (;;) {
    if (node.dirs.size >= MIN_SCREENS) return { container: node, passed };
    const only = node.dirs.size === 1 ? [...node.dirs.values()][0] : undefined;
    if (only === undefined) return null;
    passed.push(node);
    node = only;
  }
}

/**
 * A framework app split by route group and screen. The app and each folder on the way to its routes
 * keep their own files, and their other folders stand beside the screens.
 */
function splitRoutes(unit: Dir, { routes, between }: RouteRoot): Draft[] {
  const drafts: Draft[] = [];
  const way = [unit, ...between, routes];
  const own: Draft = {
    kind: AreaCandidateKind.Unit,
    label: unit.path,
    trees: [],
    directs: way.map((dir) => dir.path),
  };
  for (const [name, child] of routes.dirs) {
    if (!isRouteGroup(name)) {
      own.trees.push(child.path);
      continue;
    }
    const screens = screensOf(child);
    if (screens === null) {
      drafts.push(draftOf(AreaCandidateKind.Route, child.path, child.path));
      continue;
    }
    const left: Draft = {
      kind: AreaCandidateKind.Route,
      label: child.path,
      trees: [],
      directs: [child.path, ...screens.passed.map((d) => d.path), screens.container.path],
    };
    for (const screen of screens.container.dirs.values())
      drafts.push(draftOf(AreaCandidateKind.Route, screen.path, screen.path));
    drafts.push(left);
  }
  for (const [n, dir] of way.slice(0, -1).entries()) {
    const next = way[n + 1];
    for (const child of dir.dirs.values()) {
      if (child === next) continue;
      if (child.total >= MIN_FILES)
        drafts.push(draftOf(AreaCandidateKind.Folder, child.path, child.path));
      else own.trees.push(child.path);
    }
  }
  return [own, ...drafts];
}

/** Splits a folder one level when one child holds most of it and has several of its own. */
function splitLarge(dir: Dir): Draft[] {
  const big = [...dir.dirs.values()].find(
    (d) => d.total * 10 >= dir.total * 6 && d.dirs.size >= MIN_SCREENS,
  );
  if (big === undefined) return [draftOf(AreaCandidateKind.Folder, dir.path, dir.path)];
  const rest: Draft = {
    kind: AreaCandidateKind.Folder,
    label: dir.path,
    trees: [],
    directs: [dir.path],
  };
  const drafts: Draft[] = [];
  for (const child of dir.dirs.values()) {
    if (child === big) continue;
    rest.trees.push(child.path);
  }
  rest.directs.push(big.path);
  for (const child of big.dirs.values()) {
    if (child.total >= MIN_FILES)
      drafts.push(draftOf(AreaCandidateKind.Folder, child.path, child.path));
    else rest.trees.push(child.path);
  }
  return [rest, ...drafts];
}

function visit(dir: Dir, drafts: Draft[], leftovers: Draft): void {
  if (isManifestDir(dir)) {
    const routeRoot = routeRootOf(dir);
    if (routeRoot === null) drafts.push(draftOf(AreaCandidateKind.Unit, dir.path, dir.path));
    else drafts.push(...splitRoutes(dir, routeRoot));
    return;
  }
  if (holdsUnit(dir)) {
    if (dir.direct.length > 0) leftovers.directs.push(dir.path);
    for (const child of dir.dirs.values()) visit(child, drafts, leftovers);
    return;
  }
  if (dir.total >= MIN_FILES) drafts.push(draftOf(AreaCandidateKind.Folder, dir.path, dir.path));
  else leftovers.trees.push(dir.path);
}

/** The top of a repository that is one package: its folders become the candidates. */
function visitTopOfPackage(root: Dir, drafts: Draft[], leftovers: Draft): void {
  const routeRoot = routeRootOf(root);
  if (routeRoot !== null) {
    const parts = splitRoutes(root, routeRoot);
    // The root's own files stay with the top of the repository, not with a candidate named for it.
    for (const part of parts) {
      if (part.label === root.path) {
        leftovers.trees.push(...part.trees);
        leftovers.directs.push(...part.directs.filter((d) => d !== ''));
      } else drafts.push(part);
    }
    return;
  }
  for (const child of root.dirs.values()) {
    if (child.total >= MIN_FILES) drafts.push(...splitLarge(child));
    else leftovers.trees.push(child.path);
  }
}

/** Which holder each folder belongs to: whole, or for the files directly in it. */
interface Holdings<T> {
  readonly trees: ReadonlyMap<string, T>;
  readonly directs: ReadonlyMap<string, T>;
}

function holdingsOf<T extends Holder>(holders: readonly T[]): Holdings<T> {
  const trees = new Map<string, T>();
  const directs = new Map<string, T>();
  for (const holder of holders) {
    for (const tree of holder.trees) if (!trees.has(tree)) trees.set(tree, holder);
    for (const direct of holder.directs) if (!directs.has(direct)) directs.set(direct, holder);
  }
  return { trees, directs };
}

/** Where a path is held: by whom, at which folder, and whether that folder is held for its own files. */
interface Held<T> {
  readonly holder: T;
  readonly folder: string;
  readonly direct: boolean;
}

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/**
 * Who holds the file at `path`, which may be one a commit removed: whoever holds its own folder for
 * that folder's files, else whoever holds the deepest folder above it whole.
 */
function heldAt<T>(holdings: Holdings<T>, path: string): Held<T> | undefined {
  const folder = parentOf(path);
  const direct = holdings.directs.get(folder);
  if (direct !== undefined) return { holder: direct, folder, direct: true };
  for (let above = folder; ; above = parentOf(above)) {
    const holder = holdings.trees.get(above);
    if (holder !== undefined) return { holder, folder: above, direct: false };
    if (above === '') return undefined;
  }
}

const isDotName = (name: string) => name.startsWith('.');

/** A glob as the folder it starts at and the pattern below that folder. */
interface FolderGlob {
  readonly folder: string;
  readonly pattern: string;
}

// The glob that takes `file` in where it is held. Node's matcher lets no `*` or `**` match a name that
// starts with a dot, so below a folder held whole, `**` takes the files with no dot name, `**/.*` the
// dotfiles, and `**/.*/**` the files below one dot folder, at any depth. A file below a second dot name
// is taken from its last dot folder instead: the matcher never matches a dot name at the end of a
// pattern with two `**`, so `**/.*/**/.*` would take nothing.
function globOf(file: string, { folder, direct }: Held<unknown>): FolderGlob {
  const below = (folder === '' ? file : file.slice(folder.length + 1)).split('/');
  const dotfile = isDotName(below.at(-1) ?? '');
  if (direct) return { folder, pattern: dotfile ? '.*' : '*' };
  const dots = below.filter(isDotName).length;
  if (dots === 0) return { folder, pattern: '**' };
  if (dots === 1) return { folder, pattern: dotfile ? '**/.*' : '**/.*/**' };
  const lastDotFolder = below.slice(0, -1).findLastIndex(isDotName);
  const through = below.slice(0, lastDotFolder + 1).join('/');
  return {
    folder: folder === '' ? through : `${folder}/${through}`,
    pattern: dotfile ? '**/.*' : '**',
  };
}

/** `glob` inside the folder `dir`, whose name is taken literally whatever characters it holds. */
const prefixed = (dir: string, glob: string) => (dir === '' ? glob : `${literalGlob(dir)}/${glob}`);

const REST_LABEL = '.';

/** A draft's files: how many, and the patterns that take them in, by the folder they are held at. */
interface Holding {
  files: number;
  readonly patterns: Map<string, Set<string>>;
}

/**
 * The places in a repository that could be areas, from its tracked files alone: a package or app is
 * one candidate, a framework app is split by route group and screen, and what is left over is one more.
 * Together the candidates hold every file, and each file matches the globs of the one that holds it
 * and no other's.
 */
export function deriveAreaCandidates(files: readonly string[]): AreaCandidate[] {
  const root = buildTree(files);
  const drafts: Draft[] = [];
  const leftovers: Draft = {
    kind: AreaCandidateKind.Rest,
    label: REST_LABEL,
    trees: [],
    directs: [''],
  };
  if (holdsUnit(root) || !isManifestDir(root)) {
    for (const child of root.dirs.values()) visit(child, drafts, leftovers);
  } else {
    visitTopOfPackage(root, drafts, leftovers);
  }
  const all = [...drafts, leftovers];

  const holdings = holdingsOf(all);
  // A folder held whole gets `**` whatever it holds, so the files it gains later are in it too.
  const held = new Map<Draft, Holding>(
    all.map((d) => [d, { files: 0, patterns: new Map(d.trees.map((t) => [t, new Set(['**'])])) }]),
  );
  for (const file of files) {
    // Every folder has a holder; a file none took would still be the rest's, by its folder.
    const at = heldAt(holdings, file) ?? {
      holder: leftovers,
      folder: parentOf(file),
      direct: true,
    };
    const holding = held.get(at.holder);
    if (holding === undefined) continue;
    holding.files += 1;
    const { folder, pattern } = globOf(file, at);
    holding.patterns.set(folder, (holding.patterns.get(folder) ?? new Set<string>()).add(pattern));
  }

  // A draft that ends up holding no file is no area: it would have no glob, and an area needs one.
  return all.flatMap((draft): AreaCandidate[] => {
    const holding = held.get(draft);
    if (holding === undefined || holding.files === 0) return [];
    const globs = [...holding.patterns].flatMap(([folder, patterns]) =>
      [...patterns].map((pattern) => prefixed(folder, pattern)),
    );
    return [
      {
        kind: draft.kind,
        label: draft.label,
        globs,
        files: holding.files,
        trees: [...draft.trees],
        directs: [...draft.directs],
      },
    ];
  });
}

/**
 * Merges candidates that nearly always change in the same commits. Units and the leftover candidate
 * are never merged, and a commit that touches many candidates says nothing about any pair.
 */
export function mergeCoupledCandidates(
  candidates: readonly AreaCandidate[],
  commits: readonly (readonly string[])[],
): AreaCandidate[] {
  const holdings = holdingsOf(candidates);
  const mergeable = new Map(
    candidates.flatMap((c, i) =>
      c.kind === AreaCandidateKind.Route || c.kind === AreaCandidateKind.Folder ? [[c, i]] : [],
    ),
  );
  const touched = (commit: readonly string[]): Set<number> => {
    const hit = new Set<number>();
    for (const file of commit) {
      const holder = heldAt(holdings, file)?.holder;
      const at = holder === undefined ? undefined : mergeable.get(holder);
      if (at !== undefined) hit.add(at);
      // Past the spread the commit is passed over, whatever else it touches.
      if (hit.size > MAX_COMMIT_SPREAD) break;
    }
    return hit;
  };
  const changes = new Map<number, number>();
  const together = new Map<string, number>();
  for (const commit of commits) {
    const hit = [...touched(commit)].sort((a, b) => a - b);
    if (hit.length > MAX_COMMIT_SPREAD) continue;
    for (const i of hit) changes.set(i, (changes.get(i) ?? 0) + 1);
    for (const [n, a] of hit.entries())
      for (const b of hit.slice(n + 1))
        together.set(
          `${String(a)}:${String(b)}`,
          (together.get(`${String(a)}:${String(b)}`) ?? 0) + 1,
        );
  }

  const group = new Map<number, number>(candidates.map((_, i) => [i, i]));
  const find = (i: number): number => {
    const parent = group.get(i) ?? i;
    return parent === i ? i : find(parent);
  };
  for (const [key, shared] of together) {
    const [a = 0, b = 0] = key.split(':').map(Number);
    const fewer = Math.min(changes.get(a) ?? 0, changes.get(b) ?? 0);
    if (shared < MIN_SHARED_COMMITS || shared / fewer < MIN_COUPLING) continue;
    group.set(find(b), find(a));
  }

  const merged = new Map<number, AreaCandidate[]>();
  candidates.forEach((c, i) => {
    const key = find(i);
    merged.set(key, [...(merged.get(key) ?? []), c]);
  });
  return [...merged.values()].flatMap((members): AreaCandidate[] => {
    const [first, ...others] = members;
    if (first === undefined) return [];
    if (others.length === 0) return [first];
    return [
      {
        kind: first.kind,
        label: members.map((m) => m.label).join(' + '),
        globs: [...new Set(members.flatMap((m) => m.globs))],
        files: members.reduce((sum, m) => sum + m.files, 0),
        trees: members.flatMap((m) => m.trees),
        directs: members.flatMap((m) => m.directs),
      },
    ];
  });
}
