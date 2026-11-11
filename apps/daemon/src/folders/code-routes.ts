import { posix } from 'node:path';
import { AreaRoute } from '@10db/contracts';
import { importBindings, isSourceFile, resolveImport, type PathAliases } from './import-graph';

// Workbench setup: an app with no file routes (a Vite or Tauri UI) names its pages in code, in route
// objects (`path: '/board', component: BoardPage`) or JSX (`<Route path="/board" element={<Board />}`).

/** A folder directly under one of these that a route's component lives in is a page. */
const PAGE_DIRS: ReadonlySet<string> = new Set(['views', 'pages', 'screens', 'routes']);
const ROUTER_NAME = /^(?:router|routes|App|main)\.[cm]?[jt]sx?$/u;

/** A page a route in code shows. */
export interface CodePage {
  readonly name: string;
  readonly folder: string;
  /** Absent when only a path with a parameter names it. */
  readonly route?: string;
}

export interface CodeRoutes {
  readonly pages: readonly CodePage[];
  /** Folders beside the pages that no route names. */
  readonly unrouted: readonly { name: string; folder: string; reason: string }[];
}

export interface CodeRoutesInput {
  /** Every tracked file of the repository. */
  readonly files: readonly string[];
  /** The text of each router file (`routerFiles`). */
  readonly routers: ReadonlyMap<string, string>;
  readonly aliases: PathAliases;
}

const under = (path: string, folder: string): boolean =>
  folder === '' || path.startsWith(`${folder}/`);

/** At most this many router files are read per app, the shallowest first. */
const MAX_ROUTER_FILES = 20;

/** The files under the unit's source folder (`src/` when it has one) that may define its routes. */
export function routerFiles(files: readonly string[], unit: string): string[] {
  const src = unit === '' ? 'src' : `${unit}/src`;
  const base = files.some((f) => under(f, src)) ? src : unit;
  const depth = (f: string) => f.split('/').length;
  return files
    .filter((f) => under(f, base) && ROUTER_NAME.test(posix.basename(f)))
    .sort((a, b) => depth(a) - depth(b))
    .slice(0, MAX_ROUTER_FILES);
}

/** An area name from a folder's name: lowercase words joined by hyphens. */
export function areaNameOf(folderName: string): string {
  const words = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return /^[a-z]/u.test(words) ? words : `page-${words === '' ? 'x' : words}`;
}

/**
 * The index just past the string literal that opens at `start`, looking no further than `limit`. A
 * `'` or `"` string ends at a line's end too, so an apostrophe in JSX text hides nothing after it.
 */
function stringEnd(text: string, start: number, limit = text.length): number {
  const quote = text[start];
  let i = start + 1;
  while (i < limit && text[i] !== quote) {
    if (text[i] === '\n' && quote !== '`') return i;
    i += text[i] === '\\' ? 2 : 1;
  }
  return Math.min(i + 1, limit);
}

const isQuote = (ch: string | undefined) => ch === '"' || ch === "'" || ch === '`';
const isOpen = (ch: string | undefined) => ch === '{' || ch === '(' || ch === '[';
const isClose = (ch: string | undefined) => ch === '}' || ch === ')' || ch === ']';

/** A router file's brackets, read in one pass: where each closes, and the object around each position asked. */
interface Brackets {
  /** Each opening bracket's closing one; the text's end when none closes it. */
  readonly closes: ReadonlyMap<number, number>;
  /** For each position asked, the `{` of the innermost object around it, or -1. */
  readonly around: ReadonlyMap<number, number>;
  /** For each `{`, the `{` of the object around it, or -1. */
  readonly parents: ReadonlyMap<number, number>;
}

/** One linear pass over `text`, strings and comments stepped over. `asked` is sorted. */
function bracketsOf(text: string, asked: readonly number[]): Brackets {
  const closes = new Map<number, number>();
  const around = new Map<number, number>();
  const parents = new Map<number, number>();
  const open: number[] = [];
  const objects: number[] = [];
  let next = 0;
  const reach = (i: number) => {
    while (next < asked.length && (asked[next] ?? 0) <= i) {
      around.set(asked[next] ?? 0, objects.at(-1) ?? -1);
      next += 1;
    }
  };
  for (let i = 0; i < text.length;) {
    reach(i);
    const ch = text[i];
    if (isQuote(ch)) {
      i = stringEnd(text, i);
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (isOpen(ch)) {
        open.push(i);
        if (ch === '{') {
          parents.set(i, objects.at(-1) ?? -1);
          objects.push(i);
        }
      } else if (isClose(ch)) {
        const at = open.pop();
        if (at !== undefined) {
          closes.set(at, i);
          if (text[at] === '{') objects.pop();
        }
      }
      i += 1;
    }
  }
  reach(text.length);
  for (const at of open) closes.set(at, text.length);
  return { closes, around, parents };
}

/** What the object opening at `open` holds outside its nested brackets, strings kept. */
function topLevelOf(text: string, brackets: Brackets, open: number): string {
  const close = brackets.closes.get(open) ?? text.length;
  let out = '';
  for (let i = open + 1; i < close;) {
    const ch = text[i] ?? '';
    if (isQuote(ch)) {
      const end = stringEnd(text, i, close);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 || end > close ? close : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 || end > close ? close : end + 2;
    } else if (isOpen(ch)) {
      i = (brackets.closes.get(i) ?? close) + 1;
      out += ' ';
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Each local name a file imports, with the specifier it comes from. */
function importedNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const binding of importBindings(text))
    for (const local of binding.locals) names.set(local, binding.specifier);
  // `const X = lazy(() => import('…'))`: each quantifier here is fenced by a literal, so it reads in linear time.
  for (const match of text.matchAll(
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*(['"])([^'"\n]+)\2\s*\)/gu,
  ))
    if (match[1] !== undefined && match[3] !== undefined) names.set(match[1], match[3]);
  return names;
}

/**
 * The capitalised JSX tags each function or `const` the file declares renders, by its name: a
 * declaration's body runs to the next declaration that starts a line. One pass over the file.
 */
function localComponents(text: string): Map<string, string[]> {
  const declarations = [
    ...text.matchAll(
      /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:function[ \t]+([\w$]+)|(?:const|let|class)[ \t]+([\w$]+))/gu,
    ),
  ];
  const rendered = new Map<string, string[]>();
  declarations.forEach((match, n) => {
    const name = match[1] ?? match[2];
    if (name === undefined || rendered.has(name)) return;
    const body = text.slice(
      match.index + match[0].length,
      declarations[n + 1]?.index ?? text.length,
    );
    rendered.set(
      name,
      [...body.matchAll(/<([A-Z][\w$]*)/gu)].flatMap((m) => (m[1] === undefined ? [] : [m[1]])),
    );
  });
  return rendered;
}

/** A route definition: its whole path and the component it shows. */
interface RouteDef {
  readonly at: number;
  readonly path: string;
  readonly component: string;
}

const PATH_KEY = /\bpath\s*:\s*(['"`])([^'"`\n]*)\1/u;
const COMPONENT_KEY =
  /(?:\b(?:component|Component)\s*:\s*([A-Z][\w$]*)|\belement\s*:\s*<\s*([A-Z][\w$]*))/u;
// `getParentRoute: () => parent`, its `()` left out as a nested bracket is at an object's top level.
const PARENT_KEY = /\bgetParentRoute\s*:\s*=>\s*([\w$]+)/u;
const COMPONENT_ATTR =
  /(?:\b(?:component|Component)\s*=\s*\{\s*([A-Z][\w$]*)\s*\}|\belement\s*=\s*\{\s*<\s*([A-Z][\w$]*))/u;
const PATH_ATTR = /\bpath\s*=\s*(?:(['"])([^'"\n]*)\1|\{\s*(['"`])([^'"`\n]*)\3\s*\})/u;
/** How far a `<Route` tag's attributes are read. */
const ROUTE_TAG_CHARS = 4096;
/** How many parents a nested route's path is joined through. */
const MAX_NESTING = 20;
/** A joined path longer than a route can be (`AreaRoute`) is dropped. */
const MAX_PATH_CHARS = 500;
/** How many paths one router file may define. */
const MAX_DEFINED = 2000;

/** `path` under `parent`: a path from the root stays as it is. */
function joinPath(parent: string | undefined, path: string): string {
  if (path.startsWith('/')) return path;
  const head = (parent ?? '').replace(/\/+$/u, '');
  const tail = path.replace(/^\.?\//u, '');
  return tail === '' ? (head === '' ? '/' : head) : `${head}/${tail}`;
}

/** What one route object says at its top level. */
interface RouteObject {
  readonly path: string | undefined;
  readonly component: string | undefined;
  readonly parentVar: string | undefined;
}

/**
 * Each route a router file defines, with its whole path (a relative path joined to its parent: the
 * object around it, the route `getParentRoute` names, or the `<Route>` tag around it), and every path
 * it defines whatever the route shows. One pass over the brackets; each `<Route` tag is read once.
 */
function routesOf(text: string): { defs: RouteDef[]; defined: string[] } {
  const keys = [...text.matchAll(new RegExp(PATH_KEY.source, 'gu'))];
  const brackets = bracketsOf(
    text,
    keys.map((m) => m.index),
  );
  const variables = new Map<string, number>();
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*createRoute\(\s*\{/gu))
    if (m[1] !== undefined) variables.set(m[1], m.index + m[0].length - 1);
  const objects = new Map<number, RouteObject>();
  const objectAt = (open: number): RouteObject => {
    let found = objects.get(open);
    if (found === undefined) {
      const top = topLevelOf(text, brackets, open);
      const component = COMPONENT_KEY.exec(top);
      found = {
        path: PATH_KEY.exec(top)?.[2],
        component: component?.[1] ?? component?.[2],
        parentVar: PARENT_KEY.exec(top)?.[1],
      };
      objects.set(open, found);
    }
    return found;
  };
  // The nearest object at or around a bracket that names a path, found once per bracket: a walk up
  // through objects with none is remembered for each of them, so deep nesting reads in linear time.
  const nearest = new Map<number, number>();
  const nearestRoute = (from: number): number => {
    const passed: number[] = [];
    let found = -1;
    for (let up = from; up !== -1; up = brackets.parents.get(up) ?? -1) {
      const known = nearest.get(up);
      if (known !== undefined) {
        found = known;
        break;
      }
      if (objectAt(up).path !== undefined) {
        found = up;
        break;
      }
      passed.push(up);
    }
    for (const bracket of passed) nearest.set(bracket, found);
    return found;
  };
  const fullPaths = new Map<number, string | undefined>();
  const fullPath = (open: number, depth: number): string | undefined => {
    if (fullPaths.has(open)) return fullPaths.get(open);
    const { path, parentVar } = objectAt(open);
    let whole: string | undefined;
    if (path !== undefined && depth < MAX_NESTING) {
      let parent: string | undefined;
      if (!path.startsWith('/')) {
        const named = parentVar === undefined ? undefined : variables.get(parentVar);
        if (named !== undefined) parent = fullPath(named, depth + 1);
        else {
          const up = nearestRoute(brackets.parents.get(open) ?? -1);
          if (up !== -1) parent = fullPath(up, depth + 1);
        }
      }
      const joined = joinPath(parent, path);
      whole = joined.length > MAX_PATH_CHARS ? undefined : joined;
    }
    fullPaths.set(open, whole);
    return whole;
  };

  const defs: RouteDef[] = [];
  const defined: string[] = [];
  for (const open of new Set(keys.map((m) => brackets.around.get(m.index) ?? -1))) {
    if (open === -1) continue;
    const path = fullPath(open, 0);
    if (path === undefined) continue;
    if (defined.length < MAX_DEFINED) defined.push(path);
    const { component } = objectAt(open);
    if (component !== undefined) defs.push({ at: open, path, component });
  }

  // JSX: each `<Route` tag read once, a tag left open holding the routes nested in it.
  const stack: (string | undefined)[] = [];
  let depth = 0;
  // The next `</Route` is looked for again only once the scan has passed it, so a file of open tags
  // with no closing one is read once, not once a tag.
  // A `</Route` counts only as a whole tag name: `</Routes>` and `</RouteGuard>` close no route.
  const closeFrom = (from: number): number => {
    let found = text.indexOf('</Route', from);
    while (found !== -1 && !/[\s>]/u.test(text[found + 7] ?? ''))
      found = text.indexOf('</Route', found + 7);
    return found;
  };
  let closing = closeFrom(0);
  for (let at = 0; at < text.length;) {
    const opening = text.indexOf('<Route', at);
    if (closing !== -1 && closing < at) closing = closeFrom(at);
    if (opening === -1 && closing === -1) break;
    if (closing !== -1 && (opening === -1 || closing < opening)) {
      if (depth <= MAX_NESTING) stack.pop();
      depth = Math.max(0, depth - 1);
      at = closing + 7;
      continue;
    }
    const after = text[opening + 6];
    if (after !== undefined && /[\w$]/u.test(after)) {
      at = opening + 6;
      continue;
    }
    const limit = Math.min(text.length, opening + ROUTE_TAG_CHARS);
    let end = opening + 6;
    while (end < limit && text[end] !== '>') {
      if (text[end] === '{') end = (brackets.closes.get(end) ?? limit) + 1;
      else if (isQuote(text[end])) end = stringEnd(text, end, limit);
      else end += 1;
    }
    const attrs = text.slice(opening, Math.min(end, limit));
    const literal = PATH_ATTR.exec(attrs);
    const raw = literal?.[2] ?? literal?.[4];
    // Past the nesting cap a tag's path is not joined, and the tags it holds are counted, not kept.
    const parent = stack.at(-1);
    const nested = depth >= MAX_NESTING;
    const joined = raw === undefined || nested ? undefined : joinPath(parent, raw);
    const path = joined !== undefined && joined.length <= MAX_PATH_CHARS ? joined : undefined;
    const found = COMPONENT_ATTR.exec(attrs);
    const component = found?.[1] ?? found?.[2];
    if (path !== undefined) {
      if (defined.length < MAX_DEFINED) defined.push(path);
      if (component !== undefined) defs.push({ at: opening, path, component });
    }
    // A tag too long to read whole counts as open, so the `</Route>` that ends it pops it alone.
    if (end >= limit || text[end - 1] !== '/') {
      if (!nested) stack.push(path ?? parent);
      depth += 1;
    }
    at = Math.max(end + 1, opening + 6);
  }
  return { defs: defs.sort((a, b) => a.at - b.at), defined };
}

/** The page folder a module sits in: a folder directly under a `views/`-like folder. */
function pageFolderOf(module: string): string | null {
  const parts = module.split('/');
  for (let i = parts.length - 3; i >= 0; i -= 1)
    if (PAGE_DIRS.has(parts[i] ?? '')) return parts.slice(0, i + 2).join('/');
  return null;
}

const hasParameter = (path: string) =>
  path
    .split('/')
    .some((s) => s.startsWith('$') || s.startsWith(':') || s.startsWith('[') || s.includes('*'));

/**
 * For a page named only by paths with a parameter, the longest static start of one of them that the
 * router also defines (`/settings` for `/settings/$section`); undefined when it defines none.
 */
function definedPrefix(paths: readonly string[], defined: ReadonlySet<string>): string | undefined {
  const prefixes = paths.flatMap((path) => {
    const route = asRoute(path);
    if (route === null) return [];
    const segments = route.split('/').slice(1);
    const fixed = segments.findIndex(
      (s) => s.startsWith('$') || s.startsWith(':') || s.startsWith('[') || s.includes('*'),
    );
    const head = fixed === -1 ? segments : segments.slice(0, fixed);
    return head.map((_, i) => `/${head.slice(0, i + 1).join('/')}`);
  });
  return prefixes.filter((p) => defined.has(p)).sort((a, b) => b.length - a.length)[0];
}

/** `path` as a page's route, or null when no route can be it. */
function asRoute(path: string): string | null {
  const route = path.startsWith('/') ? path : `/${path}`;
  return AreaRoute.safeParse(route).success ? route : null;
}

/**
 * The pages an app's router files name: each route's component resolved through the file's imports
 * (or through the components a component defined in the file renders) to a module in a folder
 * directly under `views/`, `pages/`, `screens/` or `routes/`. A page's route is the shortest static
 * path naming it; with only a path holding a parameter it has none. Pure.
 */
export function codeRoutes(input: CodeRoutesInput): CodeRoutes {
  const tracked = new Set(input.files);
  const found = new Map<string, string[]>();
  const defined = new Set<string>();
  for (const [file, text] of input.routers) {
    const routes = routesOf(text);
    for (const path of routes.defined) {
      const route = asRoute(path);
      if (route !== null) defined.add(route);
    }
    const imports = importedNames(text);
    const folderOf = (name: string): string | null => {
      const specifier = imports.get(name);
      if (specifier === undefined) return null;
      const module = resolveImport(file, specifier, input.aliases, tracked);
      return module === null ? null : pageFolderOf(module);
    };
    const local = localComponents(text);
    const components = new Map<string, string | null>();
    const pageOf = (component: string): string | null => {
      let folder = components.get(component);
      if (folder === undefined) {
        folder =
          folderOf(component) ??
          (local.get(component) ?? []).map(folderOf).find((f) => f !== null) ??
          null;
        components.set(component, folder);
      }
      return folder;
    };
    for (const def of routes.defs) {
      const folder = pageOf(def.component);
      if (folder !== null) found.set(folder, [...(found.get(folder) ?? []), def.path]);
    }
  }
  const pages = [...found].map(([folder, paths]): CodePage => {
    const name = areaNameOf(posix.basename(folder));
    const route =
      paths
        .filter((p) => !hasParameter(p))
        .map(asRoute)
        .filter((r) => r !== null)
        .sort((a, b) => a.length - b.length)[0] ?? definedPrefix(paths, defined);
    return route === undefined ? { name, folder } : { name, folder, route };
  });
  const pageDirs = new Set(pages.map((p) => posix.dirname(p.folder)));
  const unrouted = new Set<string>();
  for (const dir of pageDirs)
    for (const file of input.files) {
      if (!under(file, dir) || !isSourceFile(file)) continue;
      const [first, ...rest] = file.slice(dir.length + 1).split('/');
      const folder = `${dir}/${first ?? ''}`;
      if (rest.length > 0 && !found.has(folder)) unrouted.add(folder);
    }
  return {
    pages,
    unrouted: [...unrouted].sort().map((folder) => ({
      name: areaNameOf(posix.basename(folder)),
      folder,
      reason: 'no route shows it',
    })),
  };
}
