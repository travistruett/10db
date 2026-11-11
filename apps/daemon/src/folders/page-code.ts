import { posix } from 'node:path';
import type { Git } from '../git';
import { treeGlobs } from './area-candidates';
import {
  importSpecifiers,
  isSourceFile,
  readPathAliases,
  resolveImport,
  type PathAliases,
} from './import-graph';
import { literalGlob } from './literal-glob';

// Workbench setup: a page's code is what only that page imports. Each page's reach is every source
// file its route folder's files import, directly or not; a file one page alone reaches is that page's,
// and the page takes the largest folder of its own files and files nothing reaches.

/** Above this many source files in the app, no import graph is built and pages take only their route folders. */
export const PAGE_CODE_MAX_FILES = 5000;
/** A source file larger than this is not read; it counts as importing nothing. */
export const PAGE_CODE_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A page with this many single files outside its folders leaves them all shared. */
const MAX_SINGLE_FILES = 20;

/** A proposed page: its name and the folder that is its route. */
export interface PageSeed {
  readonly name: string;
  readonly folder: string;
}

export interface PageCodeInput {
  /** The app's folder, `''` for the top of the repository. */
  readonly unit: string;
  /** Every tracked file of the repository. */
  readonly files: readonly string[];
  /** The text of the unit's source files; a source file not here imports nothing. */
  readonly texts: ReadonlyMap<string, string>;
  readonly aliases: PathAliases;
  readonly pages: readonly PageSeed[];
  /** Files every page renders inside (root layouts): what they reach is no page's. */
  readonly sharedRoots: readonly string[];
}

export interface PageCode {
  /** Each page that takes code outside its route folder, with the globs that take it. */
  readonly taken: ReadonlyMap<string, readonly string[]>;
  /** Why no page took anything, when the graph was not built; else null. */
  readonly note: string | null;
}

const under = (path: string, folder: string): boolean =>
  folder === '' ? path !== '' : path.startsWith(`${folder}/`);

const parentOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

/** The unit's tracked source files, less those of a package inside it. */
export function unitSourceFiles(files: readonly string[], unit: string): string[] {
  const inner = files
    .filter((f) => posix.basename(f) === 'package.json' && under(f, unit))
    .map(parentOf)
    .filter((dir) => dir !== unit);
  return files.filter(
    (f) => (unit === '' || under(f, unit)) && isSourceFile(f) && !inner.some((d) => under(f, d)),
  );
}

/** A test or story beside the page's code: what only it imports is test support, not the page's. */
const isTestFile = (path: string): boolean =>
  /\.(?:test|spec|stories|test-d)\.[cm]?[jt]sx?$/u.test(path) ||
  path.split('/').includes('__tests__');

/** Who reaches each file below a folder: one page, no one, or more than one (or the shared roots). */
const MIXED = Symbol('mixed');
type FolderOwner = string | null | typeof MIXED;

const combine = (one: FolderOwner, other: FolderOwner): FolderOwner =>
  one === null ? other : other === null || other === one ? one : MIXED;

/** The files reachable from `starts` along `edges`, the starts included. */
function reachFrom(
  starts: readonly string[],
  edges: (file: string) => readonly string[],
): string[] {
  const seen = new Set(starts);
  const queue = [...starts];
  for (let next = queue.shift(); next !== undefined; next = queue.shift())
    for (const to of edges(next))
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
  return [...seen];
}

/**
 * The code each page takes beyond its route folder. A file is a page's when that page alone reaches
 * it and the shared roots do not. A page takes the largest folder holding one of its files whose
 * source files are all its own or reached by nothing, that is not the unit's root and neither holds
 * nor sits in a route folder; its other files become exact globs while it has fewer than 20. Pure.
 */
export function pageCode(input: PageCodeInput): PageCode {
  const sources = unitSourceFiles(input.files, input.unit);
  if (sources.length > PAGE_CODE_MAX_FILES)
    return {
      taken: new Map(),
      note: `The app has more than ${PAGE_CODE_MAX_FILES.toLocaleString('en-US')} source files, so pages take only their route folders`,
    };
  const tracked = new Set(input.files);
  const sourceSet = new Set(sources);
  const imports = new Map<string, string[]>();
  const edges = (file: string): readonly string[] => {
    let found = imports.get(file);
    if (found === undefined) {
      found = importSpecifiers(input.texts.get(file) ?? '').flatMap((specifier) => {
        const to = resolveImport(file, specifier, input.aliases, tracked);
        return to !== null && sourceSet.has(to) ? [to] : [];
      });
      imports.set(file, found);
    }
    return found;
  };

  const owners = new Map<string, FolderOwner>();
  const reachedBy = (who: FolderOwner, files: readonly string[]) => {
    for (const file of files) owners.set(file, combine(owners.get(file) ?? null, who));
  };
  for (const page of input.pages)
    reachedBy(
      page.name,
      reachFrom(
        sources.filter((f) => under(f, page.folder) && !isTestFile(f)),
        edges,
      ),
    );
  reachedBy(
    MIXED,
    reachFrom(
      input.sharedRoots.filter((f) => sourceSet.has(f)),
      edges,
    ),
  );

  // Each folder of the unit, by who reaches the source files below it.
  const folders = new Map<string, FolderOwner>();
  for (const file of sources) {
    const owner = owners.get(file) ?? null;
    for (
      let dir = parentOf(file);
      dir !== input.unit && under(dir, input.unit);
      dir = parentOf(dir)
    )
      folders.set(dir, combine(folders.has(dir) ? (folders.get(dir) ?? null) : null, owner));
  }
  const routeFolders = input.pages.map((p) => p.folder);
  const takeable = (dir: string, page: string): boolean => {
    const owner = folders.get(dir) ?? null;
    return (
      (owner === page || owner === null) &&
      !routeFolders.some((r) => r === dir || under(r, dir) || under(dir, r))
    );
  };

  const taken = new Map<string, readonly string[]>();
  for (const page of input.pages) {
    const own = sources.filter(
      (f) => owners.get(f) === page.name && !routeFolders.some((r) => under(f, r)),
    );
    let held: string[] = [];
    for (const file of own) {
      if (held.some((d) => under(file, d))) continue;
      let best: string | null = null;
      for (
        let dir = parentOf(file);
        dir !== input.unit && under(dir, input.unit) && takeable(dir, page.name);
        dir = parentOf(dir)
      )
        best = dir;
      if (best === null) continue;
      const top = best;
      held = [...held.filter((d) => !under(d, top)), top];
    }
    const single = own.filter((f) => !held.some((d) => under(f, d)));
    const globs = [
      ...held.flatMap((d) => treeGlobs(d, input.files)),
      ...(single.length < MAX_SINGLE_FILES ? single.map(literalGlob) : []),
    ];
    if (globs.length > 0) taken.set(page.name, globs);
  }
  return { taken, note: null };
}

/** The config file a unit's aliases are read from, when it has one. */
function configPath(files: readonly string[], unit: string): string | null {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const path = unit === '' ? name : `${unit}/${name}`;
    if (files.includes(path)) return path;
  }
  return null;
}

/**
 * `pageCode` over the repository at `repo`, its texts read at HEAD from git's object store; nothing
 * of the checkout is opened. Over the cap, nothing is read.
 */
export async function readPageCode(
  git: Pick<Git, 'surveyTexts'>,
  repo: string,
  input: Omit<PageCodeInput, 'texts' | 'aliases'>,
): Promise<PageCode> {
  const sources = unitSourceFiles(input.files, input.unit);
  const config = configPath(input.files, input.unit);
  const wanted = sources.length > PAGE_CODE_MAX_FILES ? [] : sources;
  const texts = await git.surveyTexts(
    repo,
    config === null ? wanted : [...wanted, config],
    PAGE_CODE_MAX_FILE_BYTES,
  );
  const configText = config === null ? undefined : texts.get(config);
  const aliases = readPathAliases(
    config === null || configText === undefined ? null : { path: config, text: configText },
  );
  return pageCode({ ...input, texts, aliases });
}
