import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** The most result files looked at, bytes of one, and bytes of all. */
const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 32_000_000;

/** The folders of an `evals` directory that hold results, by name. */
const RESULT_ROOTS = ['reports', 'lane-pipeline/baselines'] as const;

export interface ResultFiles {
  /** Repository-relative paths of the `.json` files found, in a stable order. */
  readonly paths: readonly string[];
  /** Files left out: past a cap, or over the size of one. */
  readonly skipped: number;
  /** Changes when a result file is added, removed or rewritten. */
  readonly signature: string;
  read(path: string): Promise<string | null>;
}

/** Every directory `X/evals` a tracked path sits under. */
export function evalsDirs(tracked: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of tracked) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (parts[i] === 'evals') dirs.add(parts.slice(0, i + 1).join('/'));
    }
  }
  return [...dirs].sort();
}

/** The most files collected before sorting, so a huge folder is not listed whole. */
const MAX_COLLECTED = 10_000;

/** Real `.json` files and folders only: a symlink inside a root is never followed. */
async function walk(
  real: string,
  rel: string,
  out: Map<string, string>,
  depth: number,
): Promise<boolean> {
  const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = `${rel}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith('.json')) {
      if (out.size >= MAX_COLLECTED) return true;
      out.set(path, join(real, entry.name));
    } else if (entry.isDirectory() && depth < 2) {
      if (await walk(join(real, entry.name), path, out, depth + 1)) return true;
    }
  }
  return false;
}

/** A root counts only when its real location, links resolved, is inside the checkout's. */
async function realRoot(repoReal: string, rel: string): Promise<string | null> {
  const real = await realpath(join(repoReal, rel)).catch(() => null);
  return real !== null && (real === repoReal || real.startsWith(`${repoReal}${sep}`)) ? real : null;
}

/**
 * The result files under each `evals/reports` and `evals/lane-pipeline/baselines` of the checkout's
 * working tree: they are a project's local output, often kept out of git. A root that is a link out of
 * the checkout is skipped. The newest files are kept when a cap bites. Nothing is written.
 */
export async function findResultFiles(
  repoPath: string,
  dirs: readonly string[],
): Promise<ResultFiles> {
  const repoReal = await realpath(repoPath).catch(() => null);
  const found = new Map<string, string>();
  let skipped = 0;
  if (repoReal !== null) {
    for (const dir of dirs) {
      for (const sub of RESULT_ROOTS) {
        const rel = `${dir}/${sub}`;
        const real = await realRoot(repoReal, rel);
        if (real !== null && (await walk(real, rel, found, 0))) skipped += 1;
      }
    }
  }
  // File names lead with a UTC time, so the newest sort first.
  const ordered = [...found.keys()].sort(
    (a, b) =>
      (b.split('/').at(-1) ?? '').localeCompare(a.split('/').at(-1) ?? '') || a.localeCompare(b),
  );
  skipped += Math.max(0, ordered.length - MAX_FILES);
  const paths: string[] = [];
  const sizes = new Map<string, number>();
  let newest = 0;
  for (const path of ordered.slice(0, MAX_FILES)) {
    const stat = await lstat(found.get(path) ?? '').catch(() => null);
    if (stat === null || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    paths.push(path);
    sizes.set(path, stat.size);
    newest = Math.max(newest, stat.mtimeMs);
  }
  let total = 0;
  return {
    paths,
    skipped,
    signature: `${String(paths.length)}:${String(newest)}`,
    async read(path) {
      total += sizes.get(path) ?? 0;
      if (total > MAX_TOTAL_BYTES) return null;
      return readFile(found.get(path) ?? '', 'utf8').catch(() => null);
    },
  };
}
