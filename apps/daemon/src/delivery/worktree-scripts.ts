import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';

/** The largest config file read; a bigger one counts as absent. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** An npm package name, which is also safe to join into a path. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** The scripts npm runs when a package is installed. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/** A regular file read as YAML (JSON is YAML too), or undefined when it is absent, a link, too big or unreadable. */
function readData(path: string): unknown {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return undefined;
    return parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The data in `file`, a path the project names, when it stays inside `root`: not above it, not
 * through a linked directory, and not itself a link. Undefined otherwise, or when `readData` can't.
 */
function readInside(root: string, file: string): unknown {
  try {
    const path = resolve(root, file);
    const within = (base: string, target: string): boolean => {
      const rel = relative(base, target);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!within(root, path)) return undefined;
    // A linked directory on the way would lead out of the copy even though the path reads as inside.
    if (!within(realpathSync(root), realpathSync(path))) return undefined;
    return readData(path);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `name` from `name`, `name@1.2.3` or `@scope/name@1.2.3`. */
function nameOf(entry: string): string {
  const at = entry.indexOf('@', 1);
  return at === -1 ? entry : entry.slice(0, at);
}

/** Which packages the project lets run their install scripts. */
export interface BuildPolicy {
  /** `dangerouslyAllowAllBuilds`: every package may build, except those in `denied`. */
  readonly all: boolean;
  /** The packages allowed by name. */
  readonly allowed: readonly string[];
  /** The packages never built: `allowBuilds` set to false, `ignoredBuiltDependencies`, `neverBuiltDependencies`. */
  readonly denied: readonly string[];
}

/** The string entries of `list`, by package name, when it is an array. */
function namesIn(list: unknown, into: Set<string>): void {
  if (Array.isArray(list))
    for (const name of list) if (typeof name === 'string') into.add(nameOf(name));
}

const valid = (names: Set<string>): string[] =>
  [...names].filter((name) => PACKAGE_NAME.test(name)).sort();

/**
 * Which packages the project lets run their install scripts: `allowBuilds` entries set to true
 * (pnpm-workspace.yaml), the older `onlyBuiltDependencies` lists, and `dangerouslyAllowAllBuilds`
 * (pnpm-workspace.yaml and package.json's `pnpm` field), less the ones it never builds. An
 * `onlyBuiltDependenciesFile` is read like the other config files, only when its path stays inside
 * `root` and reaches no link. Under `legacy` (pnpm 9 and earlier) only package.json's `pnpm` field
 * is read. Read as data from the copy's own files, which hold the base's content at the cut;
 * nothing in them runs.
 */
export function buildPolicy(root: string, legacy = false): BuildPolicy {
  const allowed = new Set<string>();
  const denied = new Set<string>();
  let all = false;
  // Whether the project limits builds with a list, even an empty one or one this can't read.
  let limited = false;
  // Whether a neverBuiltDependencies list has entries (valid or not): pnpm 9 reads it first.
  let neverListed = false;
  const manifest = readData(join(root, 'package.json'));
  const sources: Record<string, unknown>[] = [];
  // pnpm 9 and earlier read only `packages` and catalogs from pnpm-workspace.yaml; build settings
  // there came with pnpm 10, so under legacy they are read from package.json's `pnpm` field only.
  // (Unverified against pnpm 9's source: no pnpm 9 was available to check.)
  const workspace = legacy ? undefined : readData(join(root, 'pnpm-workspace.yaml'));
  if (isRecord(workspace)) {
    sources.push(workspace);
    const allow = workspace['allowBuilds'];
    if (isRecord(allow))
      for (const [name, value] of Object.entries(allow))
        if (value === true) allowed.add(nameOf(name));
        else if (value === false) denied.add(nameOf(name));
  }
  if (isRecord(manifest) && isRecord(manifest['pnpm'])) sources.push(manifest['pnpm']);
  for (const source of sources) {
    if (!legacy && source['dangerouslyAllowAllBuilds'] === true) all = true;
    namesIn(source['onlyBuiltDependencies'], allowed);
    const file = source['onlyBuiltDependenciesFile'];
    if (typeof file === 'string') namesIn(readInside(root, file), allowed);
    if (Array.isArray(source['onlyBuiltDependencies']) || typeof file === 'string') limited = true;
    // pnpm 10.1 added ignoredBuiltDependencies; pnpm 9 and earlier don't read it.
    if (!legacy) namesIn(source['ignoredBuiltDependencies'], denied);
    namesIn(source['neverBuiltDependencies'], denied);
    const never = source['neverBuiltDependencies'];
    if (Array.isArray(never) && never.length > 0) neverListed = true;
  }
  // pnpm 9 and earlier build every package unless an onlyBuiltDependencies list (or a file of
  // them) limits them: an empty or unreadable list builds nothing. A non-empty
  // neverBuiltDependencies list is checked first, though: pnpm then builds everything it doesn't
  // name and ignores onlyBuiltDependencies and onlyBuiltDependenciesFile.
  if (legacy && (!limited || neverListed)) all = true;
  return { all, allowed: valid(allowed), denied: valid(denied) };
}

/** The most `.modules.yaml` is read from: it lists every hoisted dependency, so it can be large. */
const MAX_MODULES_BYTES = 8 * 1024 * 1024;

/**
 * The major version of the pnpm that made `<root>/node_modules`, which pnpm records in
 * `.modules.yaml` as `packageManager: pnpm@9.15.0`; undefined when the file or the line is missing.
 */
export function installedPnpmMajor(root: string): number | undefined {
  const path = join(root, 'node_modules', '.modules.yaml');
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_MODULES_BYTES) return undefined;
    const found = /^packageManager:\s*['"]?pnpm@(\d+)\./m.exec(readFileSync(path, 'utf8'));
    return found?.[1] === undefined ? undefined : Number(found[1]);
  } catch {
    return undefined;
  }
}

/** The package a pnpm virtual store entry holds: `@scope/name` from `@scope+name@1.2.3_peer`. */
function storeEntryName(entry: string): string | undefined {
  const at = entry.indexOf('@', 1);
  if (at === -1) return undefined;
  const name = entry.slice(0, at).replace('+', '/');
  return PACKAGE_NAME.test(name) ? name : undefined;
}

/** Whether the package installed at `dir` has something pnpm would build: an install script or a binding.gyp. */
function needsBuild(dir: string): boolean {
  const manifest = readData(join(dir, 'package.json'));
  if (isRecord(manifest) && isRecord(manifest['scripts'])) {
    const scripts = manifest['scripts'];
    if (INSTALL_SCRIPTS.some((script) => typeof scripts[script] === 'string')) return true;
  }
  try {
    return lstatSync(join(dir, 'binding.gyp')).isFile();
  } catch {
    return false;
  }
}

export interface UnbuiltPackages {
  /** The packages, by name. */
  readonly names: string[];
  /** Set when pnpm 9 or earlier made the install and built everything by default: its major version. */
  readonly legacyPnpmMajor: number | undefined;
}

/**
 * The packages the project allows to build (`allowBuilds`) that a `--ignore-scripts` install left
 * unbuilt in the pnpm virtual store at `<root>/node_modules/.pnpm`, by name. A package the project
 * allows but that has no install script is not named: there is nothing it lacks. When the project
 * allows every build, every package in the store with something to build is named, less the ones
 * it never builds. Under pnpm 9 and earlier (the version that made the copy's `node_modules`) a
 * project with no onlyBuiltDependencies list allows every build, so the same holds there.
 */
export function unbuiltAllowedPackages(root: string): UnbuiltPackages {
  const major = installedPnpmMajor(root);
  const legacy = major !== undefined && major < 10;
  const policy = buildPolicy(root, legacy);
  const unbuilt = (names: string[]): UnbuiltPackages => ({
    names,
    legacyPnpmMajor: legacy && policy.all ? major : undefined,
  });
  if (!policy.all && policy.allowed.length === 0) return unbuilt([]);
  const store = join(root, 'node_modules', '.pnpm');
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return unbuilt([]);
  }
  const candidates = policy.all
    ? valid(new Set(entries.flatMap((entry) => storeEntryName(entry) ?? [])))
    : policy.allowed;
  const allowed = candidates.filter((name) => !policy.denied.includes(name));
  return unbuilt(
    allowed.filter((name) => {
      const prefix = `${name.replace('/', '+')}@`;
      return entries.some(
        (entry) => entry.startsWith(prefix) && needsBuild(join(store, entry, 'node_modules', name)),
      );
    }),
  );
}
