import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** File clones in flight at once; directories are walked one at a time. */
const CLONE_CONCURRENCY = 16;

/** The mode bits a directory carries, setuid and sticky included. */
const MODE_BITS = 0o7777;

/** Owner write, which a directory needs while its children are being made. */
const OWNER_WRITE = 0o200;

/**
 * The ignored directories whose last component is one of `names`, none inside another: copying
 * `node_modules` already carries what lies in the `node_modules` inside it.
 */
export function seedDirs(ignored: readonly string[], names: readonly string[]): string[] {
  const matching = ignored
    .map((dir) => dir.replace(/\/+$/, ''))
    .filter((dir) => dir !== '' && names.includes(dir.slice(dir.lastIndexOf('/') + 1)));
  return matching.filter(
    (dir) => !matching.some((other) => other !== dir && dir.startsWith(`${other}/`)),
  );
}

export interface SeedResult {
  readonly files: number;
  readonly links: number;
  /** What was not copied: a FIFO, socket or device, or a seed directory whose parent is not in the worktree. */
  readonly skipped: readonly string[];
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copies the ignored directories `dirs` (relative paths) from `from` into `to`, which must not hold
 * them yet. This only copies data: regular files are cloned (copy-on-write where the volume has it),
 * links are copied as links and never followed, and nothing from the source runs. Any entry that
 * cannot be read or written fails the whole seed after every clone in flight has finished, so the
 * caller removes a worktree that is not whole. Rejects with the signal's reason when it aborts.
 */
export async function seedWorktree(input: {
  readonly from: string;
  readonly to: string;
  readonly dirs: readonly string[];
  readonly signal: AbortSignal;
}): Promise<SeedResult> {
  let files = 0;
  let links = 0;
  const skipped: string[] = [];
  const active = new Set<Promise<void>>();
  const directories: { readonly path: string; readonly mode: number }[] = [];
  // Set by the first clone that fails; nothing else is started after it, and it is thrown once
  // every clone in flight has ended.
  const first: { failure: { readonly error: unknown } | null } = { failure: null };

  const checkpoint = (): void => {
    input.signal.throwIfAborted();
    if (first.failure) throw first.failure.error;
  };

  async function clone(src: string, dst: string): Promise<void> {
    while (active.size >= CLONE_CONCURRENCY) await Promise.race(active);
    checkpoint();
    // A job never rejects: its failure is recorded, so a race over `active` cannot lose it.
    const job: Promise<void> = copyFile(
      src,
      dst,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    )
      .then(() => {
        files += 1;
      })
      .catch((error: unknown) => {
        first.failure ??= { error };
      })
      .finally(() => {
        active.delete(job);
      });
    active.add(job);
  }

  async function walk(src: string, dst: string): Promise<void> {
    checkpoint();
    const st = await lstat(src);
    if (st.isSymbolicLink()) {
      await symlink(await readlink(src), dst);
      links += 1;
    } else if (st.isDirectory()) {
      // Writable while it fills; its own mode is applied once every clone into it has finished.
      await mkdir(dst, { mode: (st.mode & MODE_BITS) | OWNER_WRITE });
      directories.push({ path: dst, mode: st.mode & MODE_BITS });
      for (const name of await readdir(src)) await walk(join(src, name), join(dst, name));
    } else if (st.isFile()) {
      await clone(src, dst);
    } else {
      skipped.push(src);
    }
  }

  let walkFailure: { readonly error: unknown } | null = null;
  try {
    for (const dir of input.dirs) {
      if (!(await isPlainDirectory(dirname(join(input.to, dir))))) {
        skipped.push(dir);
        continue;
      }
      await walk(join(input.from, dir), join(input.to, dir));
    }
  } catch (error) {
    walkFailure = { error };
  }
  await Promise.all(active);
  if (first.failure) throw first.failure.error;
  if (walkFailure) throw walkFailure.error;
  input.signal.throwIfAborted();
  // Children before parents, so a parent without search permission doesn't hide its children.
  for (const { path, mode } of directories.reverse()) await chmod(path, mode);
  return { files, links, skipped };
}
