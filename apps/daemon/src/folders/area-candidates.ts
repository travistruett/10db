import { matchesGlob, posix } from 'node:path';

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

/** A place in the repository that could be an area, before anyone has named it. */
export interface AreaCandidate {
  readonly kind: AreaCandidateKind;
  /** The path that names the candidate (`.` for the top of the repository). */
  readonly label: string;
  /** Every file in the candidate matches one of these. */
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
interface Draft {
  readonly kind: AreaCandidateKind;
  readonly label: string;
  /** Folders taken with everything below them. */
  readonly trees: string[];
  /** Folders taken for the files directly in them only. */
  readonly directs: string[];
}

const draftOf = (kind: AreaCandidateKind, label: string, tree: string): Draft => ({
  kind,
  label,
  trees: [tree],
  directs: [],
});

/** The folder `steps` below `dir`, or undefined when one step is missing. */
function descend(dir: Dir, steps: readonly string[]): Dir | undefined {
  let at: Dir | undefined = dir;
  for (const step of steps) at = at?.dirs.get(step);
  return at;
}

/** The route folder of a framework app, when it has route groups. */
function routeRootOf(unit: Dir): Dir | null {
  for (const candidate of ROUTE_ROOTS) {
    const dir = descend(unit, candidate.split('/'));
    if (dir && [...dir.dirs.keys()].some(isRouteGroup)) return dir;
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

/** A framework app split by route group and screen, with its other top folders beside them. */
function splitRoutes(unit: Dir, routes: Dir): Draft[] {
  const drafts: Draft[] = [];
  const own: Draft = {
    kind: AreaCandidateKind.Unit,
    label: unit.path,
    trees: [],
    directs: [unit.path],
  };
  const routesOwn: string[] = [routes.path];
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
  own.directs.push(...routesOwn);
  for (const child of unit.dirs.values()) {
    if (child === routes || routes.path.startsWith(`${child.path}/`)) continue;
    if (child.total >= MIN_FILES)
      drafts.push(draftOf(AreaCandidateKind.Folder, child.path, child.path));
    else own.trees.push(child.path);
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
    const routes = routeRootOf(dir);
    if (routes === null) drafts.push(draftOf(AreaCandidateKind.Unit, dir.path, dir.path));
    else drafts.push(...splitRoutes(dir, routes));
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
  const routes = routeRootOf(root);
  if (routes !== null) {
    const parts = splitRoutes(root, routes);
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

const prefixed = (dir: string, glob: string) => (dir === '' ? glob : `${dir}/${glob}`);

/** The files directly in `dir` (not below it) and whether any of them is a dotfile. */
function directGlobs(dir: Dir | undefined): string[] {
  if (dir === undefined) return [];
  const names = dir.direct.map(baseName);
  return [
    ...(names.some((n) => !n.startsWith('.')) ? [prefixed(dir.path, '*')] : []),
    ...(names.some((n) => n.startsWith('.')) ? [prefixed(dir.path, '.*')] : []),
  ];
}

function dirAt(root: Dir, path: string): Dir | undefined {
  return descend(root, path === '' ? [] : path.split('/'));
}

/** The part of `file` through its first dot folder (or the file itself when it is a dotfile). */
function dotPrefix(file: string, tree: string): string | null {
  const parts = file.split('/');
  const from = tree === '' ? 0 : tree.split('/').length;
  const at = parts.findIndex((p, i) => i >= from && p.startsWith('.'));
  if (at === -1) return null;
  return at === parts.length - 1
    ? prefixed(parts.slice(0, at).join('/'), '.*')
    : `${parts.slice(0, at + 1).join('/')}/**`;
}

/**
 * The globs for a draft. `dir/**` skips a dot folder and a dotfile below it, so those get a glob each
 * that does match them.
 */
function globsOf(draft: Draft, root: Dir, owned: readonly string[]): string[] {
  const globs = new Set<string>();
  for (const tree of draft.trees) globs.add(prefixed(tree, '**'));
  for (const direct of draft.directs)
    for (const g of directGlobs(dirAt(root, direct))) globs.add(g);
  for (const file of owned) {
    if ([...globs].some((g) => matchesGlob(file, g))) continue;
    const tree = draft.trees.find((t) => file.startsWith(`${t}/`)) ?? '';
    const fix = dotPrefix(file, tree);
    if (fix !== null) globs.add(fix);
  }
  return [...globs];
}

const REST_LABEL = '.';

/**
 * The places in a repository that could be areas, from its tracked files alone: a package or app is
 * one candidate, a framework app is split by route group and screen, and what is left over is one more.
 * Together the candidates hold every file.
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

  // A file belongs to the first draft that names its folder, the deepest folder winning.
  const owner = new Map<string, Draft>();
  const rank = new Map<string, number>();
  const claim = (draft: Draft, folder: string, direct: boolean) => {
    const folderDir = dirAt(root, folder);
    if (folderDir === undefined) return;
    const depth = folder === '' ? 0 : folder.split('/').length;
    const stack = [folderDir];
    for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
      for (const file of dir.direct) {
        const was = rank.get(file) ?? -1;
        if (depth >= was) {
          owner.set(file, draft);
          rank.set(file, depth);
        }
      }
      if (!direct) stack.push(...dir.dirs.values());
    }
  };
  for (const draft of all) {
    for (const tree of draft.trees) claim(draft, tree, false);
    for (const direct of draft.directs) claim(draft, direct, true);
  }
  const owned = new Map<Draft, string[]>(all.map((d) => [d, []]));
  for (const file of files) (owned.get(owner.get(file) ?? leftovers) ?? []).push(file);

  // A draft that ends up owning no file is no area: it would have no glob, and an area needs one.
  return all.flatMap((draft): AreaCandidate[] => {
    const mine = owned.get(draft) ?? [];
    const globs = globsOf(draft, root, mine);
    if (mine.length === 0 || globs.length === 0) return [];
    return [{ kind: draft.kind, label: draft.label, globs, files: mine.length }];
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
  const mergeable = candidates.flatMap((c, i) =>
    c.kind === AreaCandidateKind.Route || c.kind === AreaCandidateKind.Folder ? [i] : [],
  );
  const touched = (commit: readonly string[]): Set<number> => {
    const hit = new Set<number>();
    for (const file of commit) {
      const at = mergeable.find((i) => candidates[i]?.globs.some((g) => matchesGlob(file, g)));
      if (at !== undefined) hit.add(at);
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
      },
    ];
  });
}
