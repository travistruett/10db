import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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

/** Real files and folders only: a symlink is never followed out of the checkout. */
async function walk(root: string, rel: string, out: string[], depth: number): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = `${rel}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
    else if (entry.isDirectory() && depth < 2) await walk(root, path, out, depth + 1);
  }
}

/**
 * The result files under each `evals/reports` and `evals/lane-pipeline/baselines` of the checkout's
 * working tree: they are a project's local output, often kept out of git. Nothing is written.
 */
export async function findResultFiles(
  repoPath: string,
  dirs: readonly string[],
): Promise<ResultFiles> {
  const found: string[] = [];
  for (const dir of dirs)
    for (const sub of RESULT_ROOTS) await walk(repoPath, `${dir}/${sub}`, found, 0);
  found.sort();
  let skipped = Math.max(0, found.length - MAX_FILES);
  const paths: string[] = [];
  const sizes = new Map<string, number>();
  let newest = 0;
  for (const path of found.slice(0, MAX_FILES)) {
    const stat = await lstat(join(repoPath, path)).catch(() => null);
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
      return readFile(join(repoPath, path), 'utf8').catch(() => null);
    },
  };
}
