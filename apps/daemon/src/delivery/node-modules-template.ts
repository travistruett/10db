import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { chmod, lstat, readFile, readdir, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../log';
import {
  checkInstall,
  INSTALL_SUMMARY,
  insideCopy,
  lockfileImporters,
  PNPM_LOCKFILE,
} from './install-health';
import { seedWorktree } from './worktree-seed';

/** The file a finished template holds beside its tree, written last: a template without it is unfinished. */
const MARKER = 'template.json';

/** The directory in a template that holds the `node_modules` directories, at their paths in the copy. */
const TREE = 'tree';

/** The name a capture builds under before it renames the result to its key. */
const STAGING_PREFIX = '.staging-';

/** How many hex characters of the sha256 name a template. */
const KEY_LENGTH = 32;

/** The files besides each workspace package's manifest whose bytes decide what pnpm installs. */
const KEY_FILES = [PNPM_LOCKFILE, 'pnpm-workspace.yaml', '.npmrc', 'package.json'] as const;

const NODE_MODULES = 'node_modules';

const TemplateMarker = z.object({
  key: z.string(),
  dirs: z
    .array(z.string().refine((dir) => insideCopy(dir) && basename(dir) === NODE_MODULES))
    .min(1),
});

/** A template that can't be cloned whole: what is wrong with it. */
class DamagedTemplate extends Error {
  override readonly name = 'DamagedTemplate';
}

/** Where the daemon keeps its `node_modules` templates: inside its data dir, which no sandbox reads or writes. */
export function templatesRoot(dataDir: string): string {
  return join(dataDir, 'node-modules');
}

/**
 * The name of the template a copy at `path` can use: a hash of the pnpm that installs, the install
 * command, and the bytes of every file that decides what it installs (the lockfile, the workspace
 * file, `.npmrc`, the root manifest and each workspace package's). Null when the copy has no
 * lockfile, the pnpm's version is unknown, or one of those files is not a regular file (a link
 * could name a file that changes outside the copy). Reads files only; nothing runs.
 */
export function templateKey(path: string, pnpmVersion: string | null): string | null {
  if (pnpmVersion === null || !existsSync(join(path, PNPM_LOCKFILE))) return null;
  const files = new Set<string>(KEY_FILES);
  for (const importer of lockfileImporters(path))
    files.add(normalize(join(importer, 'package.json')));
  const hash = createHash('sha256').update(`pnpm@${pnpmVersion}\n${INSTALL_SUMMARY}\n`);
  for (const file of [...files].sort()) {
    const at = join(path, file);
    let digest = '-';
    try {
      if (!lstatSync(at).isFile()) return null;
      digest = createHash('sha256').update(readFileSync(at)).digest('hex');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
    }
    hash.update(`${file}\0${digest}\n`);
  }
  return hash.digest('hex').slice(0, KEY_LENGTH);
}

/**
 * The copy's `node_modules` directories pnpm makes: the root's and each workspace package's, those
 * that are directories (not links), none inside another.
 */
export function nodeModulesDirs(path: string): string[] {
  const named = new Set([
    NODE_MODULES,
    ...lockfileImporters(path).map((importer) => normalize(join(importer, NODE_MODULES))),
  ]);
  const dirs = [...named].filter((dir) => {
    try {
      return lstatSync(join(path, dir)).isDirectory();
    } catch {
      return false;
    }
  });
  return dirs
    .filter((dir) => !dirs.some((other) => other !== dir && dir.startsWith(`${other}/`)))
    .sort();
}

/** What a clone of a template into a copy came to. */
export type CloneOutcome =
  /** The copy holds the template's `node_modules`, and every dependency resolves. */
  | 'cloned'
  /** There is no usable template: the copy is as it was, or without its `node_modules`. */
  | 'none'
  /** Shutdown stopped the clone; what it cloned is removed. */
  | 'aborted';

export interface NodeModulesTemplates {
  /** Replaces the copy's `node_modules` with the template's; a template that turns out damaged is removed. */
  cloneInto(input: {
    readonly key: string;
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<CloneOutcome>;
  /** Makes the template `key` from the copy's `node_modules`, unless one exists. Logs and never throws. */
  capture(input: { readonly key: string; readonly path: string }): Promise<void>;
  /** Removes every template and leftover staging directory not in `keep` and not in use. */
  sweep(keep: ReadonlySet<string>): Promise<void>;
}

/**
 * The daemon's `node_modules` templates, one per key, under `root`. Only the daemon writes them: a
 * copy gets a copy-on-write clone (`seedWorktree`), so nothing a lane or gate writes in its copy
 * reaches a template or another copy.
 */
export function createNodeModulesTemplates(deps: {
  readonly root: string;
  readonly logger: Logger;
}): NodeModulesTemplates {
  /** Templates and staging directories being read or written, which a sweep leaves alone. */
  const busy = new Map<string, number>();
  const hold = (name: string): void => {
    busy.set(name, (busy.get(name) ?? 0) + 1);
  };
  const release = (name: string): void => {
    const left = (busy.get(name) ?? 1) - 1;
    if (left > 0) busy.set(name, left);
    else busy.delete(name);
  };

  /** Removes a tree the daemon made, opening any directory whose mode keeps its children from it. */
  async function removeTree(dir: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      await openUp(dir);
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function openUp(dir: string): Promise<void> {
    try {
      if (!(await lstat(dir)).isDirectory()) return;
      await chmod(dir, 0o700);
      for (const name of await readdir(dir)) await openUp(join(dir, name));
    } catch {
      // The removal that follows says what is left.
    }
  }

  async function readMarker(dir: string, key: string): Promise<readonly string[]> {
    const marker = TemplateMarker.parse(JSON.parse(await readFile(join(dir, MARKER), 'utf8')));
    if (marker.key !== key) throw new DamagedTemplate(`its ${MARKER} names ${marker.key}`);
    return marker.dirs;
  }

  return {
    async cloneInto({ key, path, signal }) {
      const dir = join(deps.root, key);
      hold(key);
      let cloned: readonly string[] = [];
      const removeCloned = (): Promise<unknown> =>
        Promise.all(cloned.map((name) => rm(join(path, name), { recursive: true, force: true })));
      try {
        if (!existsSync(dir)) return 'none';
        const dirs = await readMarker(dir, key);
        for (const name of nodeModulesDirs(path))
          await rm(join(path, name), { recursive: true, force: true });
        cloned = dirs;
        const result = await seedWorktree({ from: join(dir, TREE), to: path, dirs, signal });
        if (result.skipped.length > 0)
          throw new DamagedTemplate(`it could not clone ${result.skipped.join(', ')}`);
        const health = checkInstall(path);
        if (health.kind !== 'whole')
          throw new DamagedTemplate(`the clone does not resolve every dependency`);
        return 'cloned';
      } catch (error) {
        await removeCloned().catch(() => undefined);
        if (signal.aborted) return 'aborted';
        deps.logger.warn(
          { key, path, err: error instanceof Error ? error.message : String(error) },
          'node_modules template damaged: removed it, and the copy installs instead',
        );
        await removeTree(dir).catch((removal: unknown) => {
          deps.logger.warn(
            { key, err: removal },
            'could not remove a damaged node_modules template',
          );
        });
        return 'none';
      } finally {
        release(key);
      }
    },

    async capture({ key, path }) {
      const target = join(deps.root, key);
      if (existsSync(target)) return;
      const name = `${STAGING_PREFIX}${randomUUID()}`;
      const staging = join(deps.root, name);
      hold(name);
      hold(key);
      try {
        const dirs = nodeModulesDirs(path);
        if (dirs.length === 0) return;
        const tree = join(staging, TREE);
        for (const dir of dirs) await mkdir(dirname(join(tree, dir)), { recursive: true });
        const result = await seedWorktree({
          from: path,
          to: tree,
          dirs,
          signal: new AbortController().signal,
        });
        if (result.skipped.length > 0)
          throw new DamagedTemplate(`it could not copy ${result.skipped.join(', ')}`);
        await writeFile(join(staging, MARKER), `${JSON.stringify({ key, dirs })}\n`);
        try {
          await rename(staging, target);
          deps.logger.info({ key, path, dirs }, 'node_modules template made');
        } catch (error) {
          // Another capture of the same key finished first; its template stands.
          if (!existsSync(target)) throw error;
        }
      } catch (error) {
        deps.logger.warn(
          { key, path, err: error instanceof Error ? error.message : String(error) },
          'could not make a node_modules template',
        );
      } finally {
        if (existsSync(staging)) await removeTree(staging).catch(() => undefined);
        release(name);
        release(key);
      }
    },

    async sweep(keep) {
      let names: string[];
      try {
        names = await readdir(deps.root);
      } catch {
        return;
      }
      for (const name of names) {
        if (keep.has(name) || busy.has(name)) continue;
        try {
          await removeTree(join(deps.root, name));
          deps.logger.info({ template: name }, 'removed a node_modules template no copy uses');
        } catch (error) {
          deps.logger.warn(
            { template: name, err: error },
            'could not remove a node_modules template',
          );
        }
      }
    },
  };
}
