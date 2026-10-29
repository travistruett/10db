/**
 * Git-ignored files a build tool rewrites on its next run and nobody makes by hand, so a finished
 * worktree that holds them may still be removed. Matched by exact name, case included, so anything
 * else keeps the worktree. Output directories need no entry: git lists a wholly ignored one as a
 * single directory, which never counts as loose work.
 */

/** eslint's `--cache` file. */
const ESLINT_CACHE = '.eslintcache';

/** The suffix of the build info `tsc` writes for an incremental or `--build` typecheck. */
const BUILD_INFO_SUFFIX = '.tsbuildinfo';

/** True when the worktree-relative `file` is eslint's cache or tsc's build info. */
export function isBuildOutput(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name === ESLINT_CACHE || name.endsWith(BUILD_INFO_SUFFIX);
}

/** `files` without build output: the loose work that keeps a finished worktree. */
export function looseWork(files: readonly string[]): string[] {
  return files.filter((file) => !isBuildOutput(file));
}
