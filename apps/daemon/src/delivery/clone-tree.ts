import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/** The python that ships with macOS's developer tools; the daemon has no native code of its own. */
const PYTHON = '/usr/bin/python3';

/** `clonefile(2)` flag: a link at the top of the source is cloned as a link, not followed. */
const CLONE_NOFOLLOW = 1;

/**
 * Calls libc's `clonefile` for each (from, to) pair of its arguments and prints the index of every
 * pair it cloned, one per line. A pair the call refuses (a target that is there, another volume, a
 * file system without clones, a file kind it can't clone) is left out and the rest still run. One
 * process for all pairs, because starting python costs far more than a clone under load.
 */
const CLONEFILE_SCRIPT = [
  'import ctypes, os, sys',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'args = sys.argv[1:]',
  'for i in range(0, len(args), 2):',
  `    if libc.clonefile(os.fsencode(args[i]), os.fsencode(args[i + 1]), ${String(CLONE_NOFOLLOW)}) == 0:`,
  '        print(i // 2)',
].join('\n');

export interface TreeClone {
  readonly from: string;
  readonly to: string;
}

/**
 * Clones each directory `from` to its `to` with one `clonefile(2)` per tree, so the file system
 * shares the data blocks and makes the tree without copying a file at a time: a `node_modules` of
 * some 80,000 files takes about a second where `cp -c` walks it for most of a minute under load.
 * Links inside a tree are cloned as links. macOS only. Answers the clones that were made, as
 * indices into `clones`; one that can't be made (`to` is there, another volume, no APFS, no
 * python, a file `clonefile` refuses) leaves nothing at its `to`.
 */
export async function cloneWholeTrees(input: {
  readonly clones: readonly TreeClone[];
  readonly signal: AbortSignal;
}): Promise<ReadonlySet<number>> {
  if (process.platform !== 'darwin' || input.clones.length === 0) return new Set();
  try {
    const { stdout } = await execFileAsync(
      PYTHON,
      ['-I', '-c', CLONEFILE_SCRIPT, ...input.clones.flatMap(({ from, to }) => [from, to])],
      { signal: input.signal },
    );
    const done = z
      .array(z.coerce.number().int().min(0).lt(input.clones.length))
      .parse(stdout.split('\n').filter((line) => line !== ''));
    return new Set(done);
  } catch {
    return new Set();
  }
}
