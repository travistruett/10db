import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `name` from `name`, `name@1.2.3` or `@scope/name@1.2.3`. */
function nameOf(entry: string): string {
  const at = entry.indexOf('@', 1);
  return at === -1 ? entry : entry.slice(0, at);
}

/**
 * The packages the project lets run their install scripts: `allowBuilds` entries set to true
 * (pnpm-workspace.yaml) and the older `onlyBuiltDependencies` lists (pnpm-workspace.yaml and
 * package.json's `pnpm` field). Read as data from the copy's own files, which hold the base's
 * content at the cut; nothing in them runs.
 */
export function allowedBuilds(root: string): string[] {
  const names = new Set<string>();
  const workspace = readData(join(root, 'pnpm-workspace.yaml'));
  const manifest = readData(join(root, 'package.json'));
  const lists: unknown[] = [];
  if (isRecord(workspace)) {
    const allow = workspace['allowBuilds'];
    if (isRecord(allow))
      for (const [name, value] of Object.entries(allow))
        if (value === true) names.add(nameOf(name));
    lists.push(workspace['onlyBuiltDependencies']);
  }
  if (isRecord(manifest) && isRecord(manifest['pnpm']))
    lists.push(manifest['pnpm']['onlyBuiltDependencies']);
  for (const list of lists)
    if (Array.isArray(list))
      for (const name of list) if (typeof name === 'string') names.add(nameOf(name));
  return [...names].filter((name) => PACKAGE_NAME.test(name)).sort();
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

/**
 * The packages the project allows to build (`allowBuilds`) that a `--ignore-scripts` install left
 * unbuilt in the pnpm virtual store at `<root>/node_modules/.pnpm`, by name. A package the project
 * allows but that has no install script is not named: there is nothing it lacks.
 */
export function unbuiltAllowedPackages(root: string): string[] {
  const allowed = allowedBuilds(root);
  if (allowed.length === 0) return [];
  const store = join(root, 'node_modules', '.pnpm');
  let entries: string[];
  try {
    entries = readdirSync(store);
  } catch {
    return [];
  }
  return allowed.filter((name) => {
    const prefix = `${name.replace('/', '+')}@`;
    return entries.some(
      (entry) => entry.startsWith(prefix) && needsBuild(join(store, entry, 'node_modules', name)),
    );
  });
}
