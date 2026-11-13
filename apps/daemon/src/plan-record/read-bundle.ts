import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PlanBundle, type PlanImportIssue } from '@10db/contracts';
import { equalOrUnder } from '../git';
import { realPathOf } from '../guard';
import { daemonRoots, forbiddenPlaceOf } from './forbidden-places';

// Reading a bundle from disk: only regular files, the bundle and its bodies anywhere outside 10db's
// data dir, its worktree root and the sandbox's roots, each body inside the bundle's own folder, every file opened once, the whole read capped, and the text as is.

/** The most a bundle and its body files may hold together. */
export const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;

export type BundleRead =
  | { ok: true; bundle: PlanBundle; bodies: ReadonlyMap<string, string> }
  | { ok: false; errors: PlanImportIssue[] };

const refuse = (path: string, message: string): BundleRead => ({
  ok: false,
  errors: [{ path, message }],
});

const refOf = (document: string, number: number): string => `${document}#${String(number)}`;

/** Decodes UTF-8, refusing invalid bytes and keeping a byte order mark. */
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The real path a path names, or null when it can't be resolved. */
function realOrNull(path: string): string | null {
  try {
    return realPathOf(path);
  } catch {
    return null;
  }
}

/**
 * Opens a real path without following a last link and without blocking on a FIFO, refuses a file with
 * more than one hard link, one no longer at that real path, or one whose size moves while it is read,
 * and reads at most
 * `budget + 1` bytes. Answers the bytes, or why it can't.
 */
async function readCapped(
  realPath: string,
  budget: number,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; why: 'not_file' | 'hard_link' | 'moved' | 'changed' | 'too_big' | 'unreadable' }
> {
  let handle;
  try {
    handle = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, why: 'not_file' };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, why: 'not_file' };
    // A hard link's real path is its own, so another name of it could be any file on the volume.
    if (stat.nlink > 1) return { ok: false, why: 'hard_link' };
    // O_NOFOLLOW guards only the last name: a folder above it swapped for a link after the real path
    // was read would open another file, so the path must still be real and name the file opened.
    const named = await lstat(realPath);
    if (realOrNull(realPath) !== realPath || named.dev !== stat.dev || named.ino !== stat.ino)
      return { ok: false, why: 'moved' };
    if (stat.size > budget) return { ok: false, why: 'too_big' };
    const buffer = Buffer.alloc(Math.min(stat.size, budget) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > budget) return { ok: false, why: 'too_big' };
    if (filled !== stat.size) return { ok: false, why: 'changed' };
    return { ok: true, bytes: buffer.subarray(0, filled) };
  } catch {
    return { ok: false, why: 'unreadable' };
  } finally {
    await handle.close();
  }
}

function decode(bytes: Buffer): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

const WHY = {
  not_file: 'is not a regular file',
  hard_link: 'has another hard link, so where it lies cannot be told; copy it instead',
  moved: 'was moved or linked elsewhere while it was opened',
  changed: 'changed while it was read; import it again',
  too_big: 'takes the bundle past 16 MiB',
  unreadable: 'could not be read',
} as const;

/**
 * The body files a bundle names, one per distinct real path, with the revisions (`doc#number`) that
 * name it, so a file two revisions or a link and its target name is read once.
 */
export function bodyFilesToRead(
  bundle: PlanBundle,
  realPath: (relative: string) => string,
): { realPath: string; refs: string[] }[] {
  const files = new Map<string, string[]>();
  for (const document of bundle.documents)
    for (const revision of document.revisions) {
      if (revision.bodyPath === undefined) continue;
      const real = realPath(revision.bodyPath);
      const refs = files.get(real) ?? [];
      refs.push(refOf(document.key, revision.number));
      files.set(real, refs);
    }
  return [...files].map(([path, refs]) => ({ realPath: path, refs }));
}

function parsed(
  text: string,
  where: string,
): { ok: true; bundle: PlanBundle } | { ok: false; errors: PlanImportIssue[] } {
  let json: unknown;
  try {
    // A byte order mark before the JSON is not part of it; record text keeps its own.
    json = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    return { ok: false, errors: [{ path: 'bundlePath', message: `${where} is not JSON` }] };
  }
  const bundle = PlanBundle.safeParse(json);
  if (bundle.success) return { ok: true, bundle: bundle.data };
  return {
    ok: false,
    errors: bundle.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? 'bundle' : issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** The places a bundle and its bodies are never read from. */
export interface BundleReadRules {
  readonly dataDir: string;
  readonly worktreeRoot: string;
  readonly sandboxRoots: readonly string[];
}

/** Reads a bundle file and its body files under the rules above. */
export async function readBundleFile(path: string, rules: BundleReadRules): Promise<BundleRead> {
  if (!isAbsolute(path)) return refuse('bundlePath', 'The bundle path must be absolute');
  const real = realOrNull(path);
  if (real === null) return refuse('bundlePath', `${path} could not be resolved`);
  const forbidden = daemonRoots(rules);
  const bundlePlace = forbiddenPlaceOf([resolve(path), real], forbidden);
  if (bundlePlace !== null)
    return refuse('bundlePath', `${real} lies at or under ${bundlePlace.what}`);
  const head = await readCapped(real, BUNDLE_MAX_BYTES);
  if (!head.ok)
    return refuse(
      'bundlePath',
      head.why === 'too_big' ? `${real} is over 16 MiB` : `${real} ${WHY[head.why]}`,
    );
  const text = decode(head.bytes);
  if (text === null) return refuse('bundlePath', `${real} is not valid UTF-8`);
  const read = parsed(text, real);
  if (!read.ok) return read;
  const bundle = read.bundle;

  const folder = dirname(real);
  const errors: PlanImportIssue[] = [];
  const reals = new Map<string, string>();
  for (const document of bundle.documents)
    for (const revision of document.revisions) {
      const bodyPath = revision.bodyPath;
      if (bodyPath === undefined || reals.has(bodyPath)) continue;
      const where = `Document ${document.key}, revision ${String(revision.number)}, bodyPath`;
      if (isAbsolute(bodyPath)) {
        errors.push({
          path: where,
          message: `${bodyPath} must be relative to the bundle's folder`,
        });
        continue;
      }
      const target = realOrNull(join(folder, bodyPath));
      if (target === null || !equalOrUnder(target, folder)) {
        errors.push({ path: where, message: `${bodyPath} lies outside the bundle's folder` });
        continue;
      }
      const bodyPlace = forbiddenPlaceOf([resolve(folder, bodyPath), target], forbidden);
      if (bodyPlace !== null) {
        errors.push({ path: where, message: `${bodyPath} lies at or under ${bodyPlace.what}` });
        continue;
      }
      reals.set(bodyPath, target);
    }
  if (errors.length > 0) return { ok: false, errors };

  const bodies = new Map<string, string>();
  for (const document of bundle.documents)
    for (const revision of document.revisions)
      if (revision.body !== undefined)
        bodies.set(refOf(document.key, revision.number), revision.body);
  let budget = BUNDLE_MAX_BYTES - head.bytes.length;
  // Every path was resolved above, so each lookup holds.
  for (const file of bodyFilesToRead(bundle, (p) => reals.get(p) ?? p)) {
    const where = `Body file for ${file.refs.join(', ')}`;
    const got = await readCapped(file.realPath, budget);
    if (!got.ok) {
      errors.push({ path: where, message: `${file.realPath} ${WHY[got.why]}` });
      if (got.why === 'too_big') break;
      continue;
    }
    budget -= got.bytes.length;
    const body = decode(got.bytes);
    if (body === null) {
      errors.push({ path: where, message: `${file.realPath} is not valid UTF-8` });
      continue;
    }
    for (const ref of file.refs) bodies.set(ref, body);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bundle, bodies };
}

/** An inline bundle's bodies; a `bodyPath` needs a bundle file to be relative to. */
export function inlineBundle(bundle: PlanBundle): BundleRead {
  const errors: PlanImportIssue[] = [];
  const bodies = new Map<string, string>();
  for (const document of bundle.documents)
    for (const revision of document.revisions) {
      const where = `Document ${document.key}, revision ${String(revision.number)}`;
      if (revision.body === undefined)
        errors.push({ path: where, message: 'bodyPath needs bundlePath' });
      else bodies.set(refOf(document.key, revision.number), revision.body);
    }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, bundle, bodies };
}
