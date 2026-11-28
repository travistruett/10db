import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, constants, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { surelyInside } from '../git';
import { isBuildOutput } from './build-output';

/** The mode of every folder a save makes: nobody but the builder reads what a worktree held. */
export const KEPT_DIR_MODE = 0o700;

/** The permission bits a saved file keeps from its source. */
const FILE_MODE_BITS = 0o7777;

/** Generated files a tool writes again on its next run, beside what `isBuildOutput` names. */
const REWRITTEN_NAMES: ReadonlySet<string> = new Set(['next-env.d.ts', '.DS_Store']);

/** A saved copy that is not the file it came from, or a save that could not be made whole. */
export class KeptCopyError extends Error {
  override readonly name = 'KeptCopyError';
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`The saved copy of ${file} is not good: ${detail}.`);
    this.file = file;
  }
}

/** A name or path that would land outside the kept folder. */
export class KeptPathError extends Error {
  override readonly name = 'KeptPathError';
}

/** Where saved files go: beside the worktree base, never pruned by 10db. */
export function keptRoot(): string {
  return join(homedir(), '.10db', 'kept');
}

/** True for a file a tool writes again and nobody makes by hand: build output, `next-env.d.ts`, `.DS_Store`. */
export function isRewritten(file: string): boolean {
  return isBuildOutput(file) || REWRITTEN_NAMES.has(basename(file));
}

/** The SHA-256 of a file's bytes, hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

type HashFile = (path: string) => Promise<string>;

/** Whether the checkout holds the same thing at the same path; any trouble reading counts as no. */
async function sameInCheckout(
  worktree: string,
  checkout: string,
  file: string,
  hash: HashFile,
): Promise<boolean> {
  try {
    const here = await lstat(join(worktree, file));
    const there = await lstat(join(checkout, file));
    if (here.isSymbolicLink()) {
      return (
        there.isSymbolicLink() &&
        (await readlink(join(worktree, file))) === (await readlink(join(checkout, file)))
      );
    }
    if (!here.isFile() || !there.isFile() || here.size !== there.size) return false;
    return (await hash(join(worktree, file))) === (await hash(join(checkout, file)));
  } catch {
    return false;
  }
}

/**
 * The worktree-relative `files` that exist nowhere else: not rewritten by a tool, and with no identical
 * file (same size and SHA-256; a link by its target text) at the same path in `checkout`. A file that
 * cannot be read counts as only here, so it is never dropped on a guess.
 */
export async function onlyHere(input: {
  readonly worktree: string;
  readonly checkout: string;
  readonly files: readonly string[];
  readonly hash?: HashFile;
}): Promise<string[]> {
  const hash = input.hash ?? sha256File;
  const kept: string[] = [];
  for (const file of input.files) {
    if (isRewritten(file)) continue;
    if (await sameInCheckout(input.worktree, input.checkout, file, hash)) continue;
    kept.push(file);
  }
  return kept;
}

/** `YYYYMMDD-HHmmss` in UTC. */
function stamp(at: Date): string {
  const text = at.toISOString();
  return `${text.slice(0, 10).replaceAll('-', '')}-${text.slice(11, 19).replaceAll(':', '')}`;
}

/** Refuses, before anything is written, a name or relative path that could leave the kept folder. */
function refuseEscapes(name: string, files: readonly string[]): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new KeptPathError(`${JSON.stringify(name)} is not a folder name under the kept folder.`);
  }
  for (const file of files) {
    const clean = normalize(file);
    if (
      file === '' ||
      isAbsolute(file) ||
      clean === '.' ||
      clean === '..' ||
      clean.startsWith(`..${sep}`)
    ) {
      throw new KeptPathError(`${file} would be saved outside the kept folder.`);
    }
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: KEPT_DIR_MODE });
  await chmod(path, KEPT_DIR_MODE);
}

/** A new folder for this save, never an earlier one: a clash in the same second gets a counter. */
async function newSaveFolder(parent: string, at: Date): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const dir = join(parent, attempt === 1 ? stamp(at) : `${stamp(at)}-${String(attempt)}`);
    try {
      await mkdir(dir, { mode: KEPT_DIR_MODE });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      throw error;
    }
    await chmod(dir, KEPT_DIR_MODE);
    return dir;
  }
}

async function copyOne(worktree: string, dir: string, file: string): Promise<void> {
  const from = join(worktree, file);
  const to = join(dir, file);
  const source = await lstat(from);
  const parent = dirname(to);
  await mkdir(parent, { recursive: true, mode: KEPT_DIR_MODE });
  if (!surelyInside(parent, dir)) {
    throw new KeptPathError(`${file} would be saved outside the kept folder.`);
  }
  if (source.isSymbolicLink()) {
    await symlink(await readlink(from), to);
    return;
  }
  if (!source.isFile()) throw new KeptCopyError(file, 'it is not a file or a link');
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await chmod(to, source.mode & FILE_MODE_BITS);
}

async function verifyOne(
  worktree: string,
  dir: string,
  file: string,
  hash: HashFile,
): Promise<void> {
  const from = join(worktree, file);
  const to = join(dir, file);
  const source = await lstat(from);
  const copy = await lstat(to);
  if (source.isSymbolicLink()) {
    if (!copy.isSymbolicLink() || (await readlink(from)) !== (await readlink(to))) {
      throw new KeptCopyError(file, 'the link does not point where the original does');
    }
    return;
  }
  if (!copy.isFile() || source.size !== copy.size) {
    throw new KeptCopyError(
      file,
      `its size is ${String(copy.size)}, the original's is ${String(source.size)}`,
    );
  }
  if ((await hash(from)) !== (await hash(to))) {
    throw new KeptCopyError(file, 'its SHA-256 differs from the original');
  }
}

/**
 * Copies each worktree-relative file to `<root>/<name>/<time>/<file>`: every folder 0700, each file
 * with its source's mode, a link as a link. Then reads every copy back, and throws `KeptCopyError`
 * naming the first file whose size or SHA-256 differs from its source's as the source is now. What is
 * already copied stays. Nothing in the worktree is touched, and nothing is removed.
 */
export async function saveKept(input: {
  readonly root: string;
  readonly name: string;
  readonly worktree: string;
  readonly files: readonly string[];
  readonly at: Date;
  readonly hash?: HashFile;
}): Promise<{ readonly dir: string; readonly saved: readonly string[] }> {
  const hash = input.hash ?? sha256File;
  refuseEscapes(input.name, input.files);
  await privateDirectory(input.root);
  const named = join(input.root, input.name);
  await privateDirectory(named);
  if (!surelyInside(named, input.root)) {
    throw new KeptPathError(`${input.name} would be saved outside the kept folder.`);
  }
  const dir = await newSaveFolder(named, input.at);
  for (const file of input.files) {
    try {
      await copyOne(input.worktree, dir, file);
    } catch (error) {
      if (error instanceof KeptCopyError || error instanceof KeptPathError) throw error;
      throw new KeptCopyError(file, error instanceof Error ? error.message : 'the copy failed');
    }
  }
  for (const file of input.files) {
    try {
      await verifyOne(input.worktree, dir, file, hash);
    } catch (error) {
      if (error instanceof KeptCopyError) throw error;
      throw new KeptCopyError(file, error instanceof Error ? error.message : 'the check failed');
    }
  }
  return { dir, saved: [...input.files] };
}
