import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AGENT_PLATFORM, type PinnedRelease } from './agent-pins';

const TAR = '/usr/bin/tar';
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const MANIFEST = '.pin.json';
const WRITABLE_BY_OTHERS = 0o022;

/** A pinned copy that can't be used: the message names the tool and the reason, and is shown to the builder. */
export class PinnedToolError extends Error {
  override readonly name = 'PinnedToolError';
  readonly pin: PinnedRelease;
  constructor(pin: PinnedRelease, reason: string) {
    super(`${pin.label} ${pin.version} was refused: ${reason}`);
    this.pin = pin;
  }
}

/** Writes the bytes at `url` to `to`. */
export type Download = (url: string, to: string) => Promise<void>;
/** Unpacks the kept part of the tarball `file` into `into`. */
export type Extract = (file: string, into: string, pin: PinnedRelease) => Promise<void>;

export const downloadFile: Download = async (url, to) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || response.body === null)
    throw new Error(`${url} answered ${String(response.status)}`);
  // The response body is a web stream; node's pipeline takes the node kind.
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
};

function untar(flags: string, file: string, into: string, pin: PinnedRelease): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      TAR,
      [
        flags,
        file,
        '-C',
        into,
        '--strip-components',
        String(pin.strip),
        '--no-same-owner',
        pin.member,
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(`tar failed: ${stderr.trim() || error.message}`));
        else resolve();
      },
    );
  });
}

/** Unpacks an npm tarball (gzip). */
export const extractWithTar: Extract = (file, into, pin) => untar('-xzf', file, into, pin);

/** Unpacks a zip, as Chrome for Testing ships: macOS's tar (bsdtar) reads zip by itself. */
export const extractZipWithTar: Extract = (file, into, pin) => untar('-xf', file, into, pin);

const Manifest = z.object({
  tool: z.string(),
  version: z.string(),
  tarballSha512: z.string(),
  treeSha256: z.string(),
});

async function fileDigest(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest('base64');
}

/** The npm integrity string of a tarball: `sha512-` and the base64 digest. */
export async function tarballIntegrity(path: string): Promise<string> {
  return `sha512-${await fileDigest(path, 'sha512')}`;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(dir, entry.name);
    found.push(path);
    if (entry.isDirectory()) found.push(...(await walk(path)));
  }
  return found;
}

/** One digest over every path, kind, executable bit, link target and file content below `dir`, but for the manifest. */
export async function treeDigest(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await walk(dir)) {
    const name = relative(dir, path);
    if (name === MANIFEST) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink()) hash.update(`l ${name} ${await readlink(path)}\n`);
    else if (info.isDirectory()) hash.update(`d ${name}\n`);
    else {
      hash.update(
        `f ${name} ${info.mode & 0o111 ? 'x' : '-'} ${await fileDigest(path, 'sha256')}\n`,
      );
    }
  }
  return hash.digest('base64');
}

/** Nothing below `dir` stays writable, so not even the daemon's own user changes a file by accident. */
async function lockDown(dir: string): Promise<void> {
  for (const path of (await walk(dir)).reverse()) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    await chmod(path, info.mode & ~0o222 & 0o7777);
  }
  await chmod(dir, 0o555);
}

/** The reverse of `lockDown`, for removing a copy. */
async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const path of await walk(dir)) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    await chmod(path, info.isDirectory() ? 0o755 : info.mode | 0o200);
  }
}

/** Removes a pinned copy, read-only as it is. */
export async function removePinned(dir: string): Promise<void> {
  try {
    await unlock(dir);
  } catch {
    // Nothing to unlock when the copy is gone or partly gone.
  }
  await rm(dir, { recursive: true, force: true });
}

/** The folder every pinned copy lives in: under the data dir, which no lane command reads or writes. */
export function pinnedToolsRoot(dataDir: string): string {
  return join(dataDir, 'tools');
}

/** Where one pin's copy lives. */
export function pinnedDir(dataDir: string, pin: PinnedRelease): string {
  return join(pinnedToolsRoot(dataDir), `${pin.tool}-${pin.version}-${AGENT_PLATFORM}`);
}

export function pinnedExecutable(dataDir: string, pin: PinnedRelease): string {
  return join(pinnedDir(dataDir, pin), pin.executable);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function refuseWritableByOthers(pin: PinnedRelease, path: string): Promise<void> {
  const info = await stat(path);
  if (info.mode & WRITABLE_BY_OTHERS)
    throw new PinnedToolError(
      pin,
      `${path} is writable by a group or others, so a command could have changed what it runs`,
    );
}

/**
 * Checks an installed copy against the checksum recorded for the pin: the manifest names this pin and the
 * checksum of the tarball it came from, the files still hash to what was installed, and nothing in the
 * path to the executable is writable by anyone but the owner.
 */
export async function verifyPinned(dataDir: string, pin: PinnedRelease): Promise<string> {
  const dir = pinnedDir(dataDir, pin);
  const exe = pinnedExecutable(dataDir, pin);
  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
  } catch {
    throw new PinnedToolError(pin, `${dir} has no readable record of what it was installed from`);
  }
  if (manifest.tool !== pin.tool || manifest.version !== pin.version)
    throw new PinnedToolError(pin, `${dir} holds ${manifest.tool} ${manifest.version}`);
  if (manifest.tarballSha512 !== pin.sha512)
    throw new PinnedToolError(
      pin,
      `its recorded checksum is ${pin.sha512}, but ${dir} was installed from a download with ${manifest.tarballSha512}`,
    );
  if ((await treeDigest(dir)) !== manifest.treeSha256)
    throw new PinnedToolError(
      pin,
      `the files in ${dir} no longer match the checksum recorded when they were installed from the download with ${pin.sha512}`,
    );
  await refuseWritableByOthers(pin, pinnedToolsRoot(dataDir));
  await refuseWritableByOthers(pin, dir);
  await refuseWritableByOthers(pin, exe);
  return exe;
}

export interface InstallDeps {
  readonly download: Download;
  readonly extract: Extract;
}

/**
 * Downloads the pin's tarball, refuses it unless it hashes to the recorded checksum, unpacks the part
 * 10db runs, records what was installed, makes it read-only and moves it into place in one rename.
 */
export async function installPinned(
  dataDir: string,
  pin: PinnedRelease,
  deps: InstallDeps,
): Promise<void> {
  const root = pinnedToolsRoot(dataDir);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const staging = join(root, `.staging-${randomBytes(6).toString('hex')}`);
  const unpacked = join(staging, 'copy');
  await mkdir(unpacked, { recursive: true });
  try {
    const tarball = join(staging, 'download.tgz');
    try {
      await deps.download(pin.tarballUrl, tarball);
    } catch (error) {
      throw new PinnedToolError(
        pin,
        `the download from ${pin.tarballUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const got = await tarballIntegrity(tarball);
    if (got !== pin.sha512)
      throw new PinnedToolError(
        pin,
        `the download from ${pin.tarballUrl} has checksum ${got}, not the recorded ${pin.sha512}; nothing was installed`,
      );
    try {
      await deps.extract(tarball, unpacked, pin);
    } catch (error) {
      throw new PinnedToolError(
        pin,
        `the download can't be unpacked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!(await exists(join(unpacked, pin.executable))))
      throw new PinnedToolError(pin, `the download holds no ${pin.executable}`);
    const manifest = {
      tool: pin.tool,
      version: pin.version,
      tarballSha512: pin.sha512,
      treeSha256: await treeDigest(unpacked),
    };
    await writeFile(join(unpacked, MANIFEST), `${JSON.stringify(manifest)}\n`, { mode: 0o444 });
    // Moved before it is locked: a read-only folder can't be renamed.
    try {
      await rename(unpacked, pinnedDir(dataDir, pin));
    } catch (error) {
      // Another install of the same pin got there first: its copy is verified like any other.
      if (!(await exists(pinnedDir(dataDir, pin)))) throw error;
    }
  } finally {
    await removePinned(staging);
  }
}

/**
 * Removes the copies of other releases of the same tool, once the pinned one is in place. Only the daemon
 * calls it, for its own data dir: a live test of a newer pin must not take the copy the running app runs.
 */
export async function prunePinned(dataDir: string, pin: PinnedRelease): Promise<void> {
  const root = pinnedToolsRoot(dataDir);
  const keep = pinnedDir(dataDir, pin);
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if (name.startsWith(`${pin.tool}-`) && path !== keep) await removePinned(path);
  }
}

export interface EnsureOptions {
  /**
   * Remove a copy that fails its check and fetch it again, as the builder's recheck does. The fresh
   * download is checked against the recorded checksum like the first one; without this a refused copy
   * stays refused.
   */
  readonly replaceRefused?: boolean;
}

/**
 * The pinned copy's executable: verified when it is installed, installed first when it is not. Throws a
 * `PinnedToolError` for a copy or a download that fails its checksum.
 */
export async function ensurePinned(
  dataDir: string,
  pin: PinnedRelease,
  deps: InstallDeps,
  options: EnsureOptions = {},
): Promise<string> {
  const dir = pinnedDir(dataDir, pin);
  if (!(await exists(dir))) await installPinned(dataDir, pin, deps);
  let exe: string;
  try {
    exe = await verifyPinned(dataDir, pin);
  } catch (error) {
    if (!options.replaceRefused || !(error instanceof PinnedToolError)) throw error;
    await removePinned(dir);
    await installPinned(dataDir, pin, deps);
    exe = await verifyPinned(dataDir, pin);
  }
  // A copy that was verified is made read-only, which also finishes an install that stopped before it.
  await lockDown(dir);
  return exe;
}
