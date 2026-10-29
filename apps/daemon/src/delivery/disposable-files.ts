/**
 * Git-ignored files a tool rewrites on its next run and nobody makes by hand, so a finished worktree
 * that holds them may still be removed. The list is short and by exact name, so a builder's or a
 * lane's loose work doesn't match it: anything not on it keeps the worktree.
 */

/** Files by last component: Finder's folder state and eslint's `--cache` file. */
const DISPOSABLE_NAMES: readonly string[] = ['.DS_Store', '.eslintcache'];

/** The suffix of the build info `tsc` writes for an incremental or `--build` typecheck. */
const BUILD_INFO_SUFFIX = '.tsbuildinfo';

/**
 * Directories build tools write into: bundles (`dist`), cargo (`target`), coverage reports
 * (`coverage`) and a gate's own logs (`.gate`).
 */
const OUTPUT_DIRECTORIES: readonly string[] = ['dist', 'target', 'coverage', '.gate'];

/**
 * True when the worktree-relative `file` is tool output: a disposable name, build info, or a file
 * under a build-output directory. A file that only bears an output directory's name is not.
 */
export function isDisposable(file: string): boolean {
  const parts = file.split('/');
  const name = parts.at(-1) ?? '';
  if (DISPOSABLE_NAMES.includes(name) || name.endsWith(BUILD_INFO_SUFFIX)) return true;
  return parts.slice(0, -1).some((dir) => OUTPUT_DIRECTORIES.includes(dir));
}
