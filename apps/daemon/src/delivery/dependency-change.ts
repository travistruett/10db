import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchId } from '@10db/contracts';
import { getBatch, getProject } from '@10db/db';
import type { BaseUpdates } from './base-update';
import type { DeliveryContext } from './context';
import { checkInstall, describeBroken } from './install-health';
import { recordInstall } from './installed-lockfile';
import { raiseInstallHostCards } from './worktree-dependencies';

/** What installing a lane's dependency change came to. */
export type DependencyChange =
  /** The manifests are resolved, the lockfile is written and every package resolves; `changed` is what to commit. */
  | { readonly kind: 'installed'; readonly changed: readonly string[]; readonly logPath: string }
  /** Nothing ran: the change is not one 10db installs, and `reason` says what to do. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The install ran and did not leave a working copy; `summary` is the end of its output or what is missing. */
  | { readonly kind: 'failed'; readonly summary: string; readonly logPath: string | null }
  /** Shutdown or a cancel stopped it. */
  | { readonly kind: 'aborted' };

export interface DependencyChanges {
  /**
   * Installs the dependency change a lane made in its copy's manifests. The lane cannot run pnpm
   * itself (its sandbox has no store lock and no registry), and no one else should have to: the
   * daemon runs the install under the gate sandbox, with scripts and the pnpmfile off, resolving
   * what the manifests say and writing the lockfile. It runs as a gate does, in the batch's turn.
   * `decisions/2026-11-03-a-lane-installs-through-the-daemon.md`.
   */
  install(batchId: BatchId, signal: AbortSignal): Promise<DependencyChange>;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** `1.2.3`, with an optional pre-release and build part. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** References that are not a version range: a package of the workspace, a catalog entry, a path. */
const REFERENCE = /^(?:workspace:|catalog:|link:|file:|npm:)/;

/** The pinned form of a specifier: an exact version, or a reference. `npm:` aliases must pin their version too. */
function pinned(specifier: string): boolean {
  if (specifier.startsWith('npm:')) {
    const at = specifier.lastIndexOf('@');
    return at > 4 && EXACT_VERSION.test(specifier.slice(at + 1));
  }
  return EXACT_VERSION.test(specifier) || REFERENCE.test(specifier);
}

/** A manifest past this is not read for its pins. */
const MAX_MANIFEST = 1024 * 1024;

type Manifest = Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, unknown>>>;

function parseManifest(text: string | null): Manifest {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function createDependencyChanges(
  ctx: DeliveryContext,
  updates: Pick<BaseUpdates, 'gate'>,
): DependencyChanges {
  const db = ctx.state.db;

  /** The specifiers a lane added or changed in its manifests that are not pinned, as `file: name (spec)`. */
  async function unpinned(path: string, base: string | null): Promise<string[]> {
    const touched = new Set([
      ...(base === null ? [] : await ctx.git.changedFilesSince(path, base)),
      ...(await ctx.git.changedPaths(path)),
    ]);
    const found: string[] = [];
    for (const file of [...touched].sort()) {
      if (file !== 'package.json' && !file.endsWith('/package.json')) continue;
      let now: string;
      try {
        now = readFileSync(join(path, file), 'utf8');
      } catch {
        // Deleted or unreadable: nothing to pin.
        continue;
      }
      const atBase = base === null ? null : await ctx.git.fileAt(path, base, file, MAX_MANIFEST);
      const was = parseManifest(atBase?.kind === 'file' ? atBase.text : null);
      const after = parseManifest(now);
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, specifier] of Object.entries(after[field] ?? {})) {
          if (was[field]?.[name] === specifier) continue;
          if (typeof specifier !== 'string' || !pinned(specifier))
            found.push(
              `${file}: ${name} (${typeof specifier === 'string' ? specifier : 'not a string'})`,
            );
        }
      }
    }
    return found;
  }

  async function run(batchId: BatchId, signal: AbortSignal): Promise<DependencyChange> {
    const batch = getBatch(db, batchId);
    const path = batch.worktreePath;
    if (path === null)
      return {
        kind: 'refused',
        reason:
          'This task works in the builder’s own checkout, which 10db never installs into. Ask the builder with ask_human to add the dependency, or have the task started in a copy of its own.',
      };
    const pins = await unpinned(path, batch.baseSha);
    if (pins.length > 0)
      return {
        kind: 'refused',
        reason: `Dependencies are pinned exactly, with no range. Change ${pins.join('; ')} to the exact version (for example 1.2.3), then call install_dependencies again.`,
      };
    const project = getProject(db, batch.projectId);
    const installed = await ctx.dependencies.refresh({
      batch,
      project,
      path,
      signal,
      mode: 'update',
      // A dependency change is an install by definition, whatever the seed left.
      seeded: false,
    });
    await recordInstall(ctx, batch.id, path, installed);
    switch (installed.kind) {
      case 'aborted':
        return { kind: 'aborted' };
      case 'skipped':
        return {
          kind: 'refused',
          reason: 'This project has no pnpm lockfile, so 10db has nothing to install.',
        };
      case 'failed':
        await raiseInstallHostCards(ctx, project.id, installed);
        return {
          kind: 'failed',
          summary: installed.timedOut
            ? 'The install timed out.'
            : `The install failed (exit ${String(installed.exitCode)}): ${installed.tail}`,
          logPath: installed.logPath,
        };
      case 'installed': {
        const health = checkInstall(path);
        if (health.kind === 'broken')
          return {
            kind: 'failed',
            summary: `The install ran, but ${describeBroken(health)}.`,
            logPath: installed.logPath,
          };
        const changed = await ctx.git.changedPaths(path);
        return { kind: 'installed', changed, logPath: installed.logPath };
      }
    }
  }

  return {
    async install(batchId, signal) {
      const done = await updates.gate(batchId, signal, () => run(batchId, signal));
      return done ?? { kind: 'aborted' };
    },
  };
}
