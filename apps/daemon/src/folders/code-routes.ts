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

/** The files under the unit's source folder (`src/` when it has one) that may define its routes. */
export function routerFiles(files: readonly string[], unit: string): string[] {
  const src = unit === '' ? 'src' : `${unit}/src`;
  const base = files.some((f) => under(f, src)) ? src : unit;
  return files.filter((f) => under(f, base) && ROUTER_NAME.test(posix.basename(f)));
}

/** An area name from a folder's name: lowercase words joined by hyphens. */
export function areaNameOf(folderName: string): string {
  const words = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return /^[a-z]/u.test(words) ? words : `page-${words === '' ? 'x' : words}`;
}

/** The index just past the string literal that opens at `start`, looking no further than `limit`. */
function stringEnd(text: string, start: number, limit = text.length): number {
  const quote = text[start];
  let i = start + 1;
  while (i < limit && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
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
}

/** One linear pass over `text`, strings and comments stepped over. `asked` is sorted. */
function bracketsOf(text: string, asked: readonly number[]): Brackets {
  const closes = new Map<number, number>();
  const around = new Map<number, number>();
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
        if (ch === '{') objects.push(i);
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
  return { closes, around };
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

/** A route definition: its path and the component it shows. */
interface RouteDef {
  readonly at: number;
  readonly path: string;
  readonly component: string;
}

const COMPONENT_KEY =
  /(?:\b(?:component|Component)\s*:\s*([A-Z][\w$]*)|\belement\s*:\s*<\s*([A-Z][\w$]*))/u;
const COMPONENT_ATTR =
  /(?:\b(?:component|Component)\s*=\s*\{\s*([A-Z][\w$]*)\s*\}|\belement\s*=\s*\{\s*<\s*([A-Z][\w$]*))/u;
/** How far a `<Route` tag's attributes are read. */
const ROUTE_TAG_CHARS = 4096;

function routeDefs(text: string): RouteDef[] {
  const defs: RouteDef[] = [];
  const paths = [...text.matchAll(/\bpath\s*:\s*(['"`])([^'"`\n]*)\1/gu)];
  const brackets = bracketsOf(
    text,
    paths.map((m) => m.index),
  );
  const objects = new Map<number, string | null>();
  for (const match of paths) {
    const open = brackets.around.get(match.index) ?? -1;
    if (open === -1) continue;
    let component = objects.get(open);
    if (component === undefined) {
      const found = COMPONENT_KEY.exec(topLevelOf(text, brackets, open));
      component = found?.[1] ?? found?.[2] ?? null;
      objects.set(open, component);
    }
    if (component !== null && match[2] !== undefined)
      defs.push({ at: match.index, path: match[2], component });
  }
  for (const match of text.matchAll(/<Route\b/gu)) {
    const limit = Math.min(text.length, match.index + ROUTE_TAG_CHARS);
    let end = match.index + match[0].length;
    while (end < limit && text[end] !== '>') {
      if (text[end] === '{') end = (brackets.closes.get(end) ?? limit) + 1;
      else if (isQuote(text[end])) end = stringEnd(text, end, limit);
      else end += 1;
    }
    const attrs = text.slice(match.index, Math.min(end, limit));
    const path = /\bpath\s*=\s*(?:(['"])([^'"\n]*)\1|\{\s*(['"`])([^'"`\n]*)\3\s*\})/u.exec(attrs);
    const found = COMPONENT_ATTR.exec(attrs);
    const component = found?.[1] ?? found?.[2];
    const literal = path?.[2] ?? path?.[4];
    if (component !== undefined && literal !== undefined)
      defs.push({ at: match.index, path: literal, component });
  }
  return defs.sort((a, b) => a.at - b.at);
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
  for (const [file, text] of input.routers) {
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
    for (const def of routeDefs(text)) {
      const folder = pageOf(def.component);
      if (folder !== null) found.set(folder, [...(found.get(folder) ?? []), def.path]);
    }
  }
  const pages = [...found].map(([folder, paths]): CodePage => {
    const name = areaNameOf(posix.basename(folder));
    const route = paths
      .filter((p) => !hasParameter(p))
      .map(asRoute)
      .filter((r) => r !== null)
      .sort((a, b) => a.length - b.length)[0];
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
