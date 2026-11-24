import { posix } from 'node:path';
import type { AreaDef } from '@10db/contracts';
import { globReaches, treeGlobs } from './area-candidates';
import { literalGlob } from './literal-glob';

/**
 * A file directly in a folder that makes it a package of its own. Not `__init__.py`: every Python
 * subpackage (`migrations/`, `tests/`, `services/`) has one.
 */
const PACKAGE_MARKERS: ReadonlySet<string> = new Set([
  'apps.py',
  'pyproject.toml',
  'setup.py',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'pom.xml',
  'mix.exs',
  'Gemfile',
  'composer.json',
]);

/** Packages every other package leans on: they stay in the area's core, with its config and tests. */
const CORE_PACKAGES: ReadonlySet<string> = new Set([
  'core',
  'common',
  'shared',
  'base',
  'lib',
  'libs',
  'utils',
  'util',
]);

/** Folders of sample code: a package in one is test data, never a unit of the project. */
const SAMPLE_FOLDERS: ReadonlySet<string> = new Set([
  'fixtures',
  '__fixtures__',
  'examples',
  'templates',
  'testdata',
]);

/** Fewer sibling packages than this is a folder, not a set of units worth an area each. */
const MIN_PACKAGES = 3;

/** A glob character, which a tree's root may not hold: only a literal folder is split. */
const GLOB_SYNTAX = /[*?[\]{}()!]/u;

const under = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

const parentOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

/** The child folders of `folder` that hold a file of `files`, by name. */
function childFolders(folder: string, files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (!under(file, folder)) continue;
    const rest = file.slice(folder.length + 1);
    const slash = rest.indexOf('/');
    if (slash > 0) names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

/** `folder`'s own files, as the globs that hold them: `<folder>/*`, and `<folder>/.*` for dotfiles. */
function ownFileGlobs(folder: string, files: readonly string[]): string[] {
  const direct = files.filter((f) => parentOf(f) === folder).map((f) => posix.basename(f));
  return [
    ...(direct.some((name) => !name.startsWith('.')) ? [`${literalGlob(folder)}/*`] : []),
    ...(direct.some((name) => name.startsWith('.')) ? [`${literalGlob(folder)}/.*`] : []),
  ];
}

/** The folder an area holds whole (`<root>/**` and its dot companions alone), or null. */
function treeRoot(area: AreaDef, files: readonly string[]): string | null {
  const tree = area.globs.find((g) => g.endsWith('/**') && !GLOB_SYNTAX.test(g.slice(0, -3)));
  if (tree === undefined) return null;
  const root = tree.slice(0, -3);
  const whole = new Set(treeGlobs(root, files));
  return area.globs.every((g) => whole.has(g)) ? root : null;
}

/** A name for a package's area: its folder name as an area name, prefixed by the area when taken. */
function partName(area: string, pkg: string, used: Set<string>): string {
  const words = pkg
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const plain = /^[a-z]/u.test(words) ? words : `${area}-${words}`;
  let name = used.has(plain) ? `${area}-${words}` : plain;
  for (let n = 2; used.has(name); n += 1) name = `${area}-${words}-${String(n)}`;
  used.add(name);
  return name;
}

/**
 * `area` split along its natural units, or null when it has none. An area is broad when it has no
 * role, is not the catch-all, holds one folder whole, and a folder in it (the root, or a child of
 * the root) holds at least three sibling packages (a child folder with a package marker such as
 * `apps.py` or `package.json`, outside any fixtures or examples folder) that hold at least half of
 * its files; of those folders, the one with the most packages. Each package becomes an area
 * of its own, named by its folder, or prefixed with the area's name where `taken` (every area and
 * hazard name) has it. The core, `<area>-shared`, holds every other file: the root's own files, its
 * other folders, the packages folder's own files, and the packages every other leans on (`core`,
 * `common`, `shared`…). Every file of the area lands in exactly one of them. Pure.
 */
export function broadAreaSplit(
  area: AreaDef,
  files: readonly string[],
  taken: ReadonlySet<string>,
): { readonly core: AreaDef; readonly parts: readonly AreaDef[] } | null {
  if (area.role !== undefined || area.catchAll === true) return null;
  const root = treeRoot(area, files);
  if (root === null) return null;
  const mine = files.filter((f) => under(f, root));
  if (mine.length === 0) return null;

  const isPackage = (folder: string) =>
    !folder.split('/').some((part) => SAMPLE_FOLDERS.has(part)) &&
    files.some((f) => parentOf(f) === folder && PACKAGE_MARKERS.has(posix.basename(f)));
  const choices = [root, ...childFolders(root, mine).map((c) => `${root}/${c}`)].flatMap(
    (folder) => {
      const packages = childFolders(folder, mine).filter(
        (name) => !name.startsWith('.') && !name.startsWith('_') && isPackage(`${folder}/${name}`),
      );
      const held = mine.filter((f) => packages.some((p) => under(f, `${folder}/${p}`))).length;
      return packages.length >= MIN_PACKAGES && held * 2 >= mine.length
        ? [{ folder, packages, held }]
        : [];
    },
  );
  // The folder with the most packages is the one the area is a set of; held files break a tie.
  const best = choices.sort((a, b) => b.packages.length - a.packages.length || b.held - a.held)[0];
  if (best === undefined) return null;
  const split = best.packages.filter((p) => !CORE_PACKAGES.has(p));
  if (split.length < 2) return null;

  const used = new Set([...taken, area.name]);
  const parts: AreaDef[] = split.map((pkg) => ({
    name: partName(area.name, pkg, used),
    globs: treeGlobs(`${best.folder}/${pkg}`, files),
  }));
  // Everything else in the root: its own files, then each folder down to the packages, then the rest.
  const coreGlobs = new Set<string>();
  const keep = (folder: string) => {
    for (const glob of ownFileGlobs(folder, mine)) coreGlobs.add(glob);
    for (const child of childFolders(folder, mine)) {
      const path = `${folder}/${child}`;
      if (folder === best.folder && split.includes(child)) continue;
      if (path === best.folder) keep(path);
      else for (const glob of treeGlobs(path, files)) coreGlobs.add(glob);
    }
  };
  keep(root);
  // A root of packages alone still keeps its name, for the files that land beside them later.
  if (coreGlobs.size === 0) coreGlobs.add(`${literalGlob(root)}/*`);
  // The core is named for what it is, so no one takes the old name for the whole folder it no longer holds.
  let coreName = `${area.name}-shared`;
  for (let n = 2; used.has(coreName); n += 1) coreName = `${area.name}-shared-${String(n)}`;
  used.add(coreName);
  const core: AreaDef = { ...area, name: coreName, globs: [...coreGlobs] };

  const all = [core, ...parts];
  const exactlyOne = mine.every(
    (f) => all.filter((a) => a.globs.some((g) => globReaches(f, g))).length === 1,
  );
  return exactlyOne ? { core, parts } : null;
}
