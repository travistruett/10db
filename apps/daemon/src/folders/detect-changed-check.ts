import { posix } from 'node:path';
import { z } from 'zod';
import { shellWord } from './shell-word';

// Workbench setup: the check 10db runs after each turn, made of the UI package's own typecheck and
// lint scripts, run by the package manager its nearest lockfile names.

/** Said beside the suggestion: why this check suits a turn. */
export const CHANGED_CHECK_NOTE =
  "Reads the files on disk, so it sees a turn's work before sign-off";

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'tsc'];
const LINT_SCRIPTS = ['lint', 'eslint'];
/** Dependencies that make a package a web app's. */
const WEB_FRAMEWORKS = [
  'next',
  'vite',
  'react-scripts',
  '@remix-run/dev',
  'astro',
  'nuxt',
  '@sveltejs/kit',
];

/** Lockfiles in the order they are looked for in one folder, each with how its manager runs a script. */
const MANAGERS: readonly { lockfile: string; run: (dir: string, script: string) => string }[] = [
  { lockfile: 'pnpm-lock.yaml', run: (dir, s) => `pnpm --dir ${dir} run ${s}` },
  { lockfile: 'package-lock.json', run: (dir, s) => `npm --prefix ${dir} run ${s}` },
  { lockfile: 'yarn.lock', run: (dir, s) => `yarn --cwd ${dir} ${s}` },
  { lockfile: 'bun.lock', run: (dir, s) => `bun run --cwd ${dir} ${s}` },
  { lockfile: 'bun.lockb', run: (dir, s) => `bun run --cwd ${dir} ${s}` },
];

const PackageJson = z.looseObject({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function packageOf(text: string): z.infer<typeof PackageJson> | null {
  try {
    const parsed = PackageJson.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const dirOf = (path: string): string => {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
};

const holds = (unit: string, path: string): boolean =>
  unit === '' || path === unit || path.startsWith(`${unit}/`);

/** The folder a glob names before its first wildcard or class. */
const literalFolder = (glob: string): string => {
  const cut = glob.search(/[*?[{]/);
  return dirOf(cut === -1 ? glob : glob.slice(0, cut) + 'x');
};

/**
 * The package folder (`''` for the root) that holds the app's pages: the deepest package holding
 * each page's globs, the one most pages are in (the first on a tie). With no page, the shallowest
 * package whose `package.json` (texts by path) depends on a web framework. Null when neither finds one.
 * Pure.
 */
export function uiUnitOf(
  files: readonly string[],
  pageGlobs: readonly (readonly string[])[],
  packageJsons: ReadonlyMap<string, string>,
): string | null {
  const units = files.filter((f) => posix.basename(f) === 'package.json').map(dirOf);
  const counts = new Map<string, number>();
  for (const globs of pageGlobs) {
    const folder = globs[0] === undefined ? null : literalFolder(globs[0]);
    if (folder === null) continue;
    const unit = units.filter((u) => holds(u, folder)).sort((a, b) => b.length - a.length)[0];
    if (unit !== undefined) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [unit, count] of counts)
    if (best === null || count > (counts.get(best) ?? 0)) best = unit;
  if (best !== null) return best;
  const web = [...packageJsons]
    .filter(([, text]) => {
      const pkg = packageOf(text);
      const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
      return WEB_FRAMEWORKS.some((name) => name in deps);
    })
    .map(([path]) => dirOf(path))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return web[0] ?? null;
}

/**
 * The changed-files check for the UI package at `unit`: its typecheck and lint scripts (either alone
 * when it has one), each run by the manager of the nearest lockfile from `unit` up to the root among
 * the tracked `files`, joined by ` && `, with the bodies of the scripts it runs (`scripts`), which is
 * what a reader of what the check does looks at, never the command 10db wrote. Null with no such
 * script or no lockfile. Pure.
 */
export function changedCheckFor(
  unit: string,
  packageJson: string,
  files: readonly string[],
): {
  readonly command: string;
  readonly source: string;
  readonly scripts: readonly string[];
} | null {
  const scripts = packageOf(packageJson)?.scripts ?? {};
  const picked = [TYPECHECK_SCRIPTS, LINT_SCRIPTS]
    .map((names) => names.find((name) => name in scripts))
    .filter((name): name is string => name !== undefined);
  if (picked.length === 0) return null;
  const tracked = new Set(files);
  let manager: (typeof MANAGERS)[number] | undefined;
  for (
    let dir: string | null = unit;
    dir !== null && manager === undefined;
    dir = dir === '' ? null : dirOf(dir)
  ) {
    const at = dir;
    manager = MANAGERS.find((m) => tracked.has(at === '' ? m.lockfile : `${at}/${m.lockfile}`));
  }
  if (manager === undefined) return null;
  const dir = shellWord(unit === '' ? '.' : unit);
  const run = manager.run;
  const pkg = unit === '' ? 'package.json' : `${unit}/package.json`;
  return {
    command: picked.map((script) => run(dir, script)).join(' && '),
    source: `from ${pkg}: its ${picked.join(' and ')} ${picked.length === 1 ? 'script' : 'scripts'}`,
    scripts: picked.map((script) => scripts[script] ?? ''),
  };
}
