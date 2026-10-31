import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, ProjectDto } from '@10db/contracts';
import type { Git } from '../git';
import type { WorktreeDependenciesDeps } from './worktree-dependencies';

/**
 * A directory made by a generator, never merged by hand (10db's root AGENTS.md): the workspace
 * package whose `generate` script makes it, and where that package's manifest is.
 */
export interface Generated {
  readonly dir: string;
  readonly manifest: string;
  readonly name: string;
}

/**
 * 10db's own generated directories, in the order they are generated: the database package reads the
 * contracts. They count in a project only where its manifests name these packages (`generatedIn`):
 * in any other project the same paths are just files.
 */
export const GENERATED: readonly Generated[] = [
  {
    dir: 'packages/contracts/generated/',
    manifest: 'packages/contracts/package.json',
    name: '@10db/contracts',
  },
  { dir: 'packages/db/drizzle/', manifest: 'packages/db/package.json', name: '@10db/db' },
];

/** A manifest past this is not a workspace package's: it is not read. */
const MANIFEST_MAX_BYTES = 256 * 1024;

/** Whether `manifest`, a package.json's text, is the package that makes `generated` with a generate script. */
export function makesDir(generated: Generated, manifest: string | null): boolean {
  if (manifest === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const { name, scripts } = parsed as { name?: unknown; scripts?: unknown };
  if (name !== generated.name || typeof scripts !== 'object' || scripts === null) return false;
  return typeof (scripts as { generate?: unknown }).generate === 'string';
}

/**
 * The generated directories of the project checked out at `repo`: those whose package makes them in
 * each of `revs`, read from the commits, so nothing uncommitted counts.
 */
export async function generatedIn(
  git: Pick<Git, 'fileAt'>,
  repo: string,
  revs: readonly string[],
): Promise<string[]> {
  const dirs: string[] = [];
  for (const generated of GENERATED) {
    const manifests = await Promise.all(
      revs.map(async (rev) => {
        const found = await git.fileAt(repo, rev, generated.manifest, MANIFEST_MAX_BYTES);
        return found.kind === 'file' ? found.text : null;
      }),
    );
    if (manifests.every((manifest) => makesDir(generated, manifest))) dirs.push(generated.dir);
  }
  return dirs;
}

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The command that regenerates `dirs`: each one's package's `generate` script, with the pnpm the
 * daemon resolved (`pnpm`, an absolute path outside every checkout). Like the install, the program
 * is fixed here and the repository's own config can't choose it. A filter that matches no package
 * fails the command: pnpm would otherwise run nothing and exit 0.
 */
export function generateCommand(pnpm: string, dirs: readonly string[]): string {
  const env =
    'pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0';
  return GENERATED.filter((g) => dirs.includes(g.dir))
    .map((g) => `${env} ${quoted(pnpm)} --filter ${quoted(g.name)} --fail-if-no-match generate`)
    .join(' && ');
}

export type Regeneration =
  /** The generators ran; their files are in the worktree, uncommitted. */
  | { readonly kind: 'done'; readonly logPath: string }
  | {
      readonly kind: 'failed';
      readonly exitCode: number;
      readonly timedOut: boolean;
      readonly tail: string;
      readonly logPath: string;
    }
  /** Shutdown stopped it. */
  | { readonly kind: 'aborted' };

export interface WorktreeGenerators {
  /** Runs the generators of `dirs` (directories of `GENERATED`) in the batch's worktree. */
  regenerate(input: {
    readonly batch: BatchDto;
    readonly project: ProjectDto;
    readonly path: string;
    readonly dirs: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<Regeneration>;
}

/**
 * Runs a worktree's generators under the gate's sandbox, as the install is run: the repository's
 * scripts execute, so nothing from it runs outside the sandbox, and it can write only the worktree
 * and the run's temp dir. Its files are left uncommitted for the caller to commit.
 */
export function createWorktreeGenerators(deps: WorktreeDependenciesDeps): WorktreeGenerators {
  return {
    async regenerate({ batch, project, path, dirs, signal }) {
      const logPath = join(
        deps.dataDir,
        'logs',
        'generate',
        `batch-${batch.id}-${String(deps.clock.now().getTime())}.log`,
      );
      const env = deps.sessionEnv(project);
      const checkouts = [...new Set([...deps.checkouts(), path])];
      const pnpm = await deps.resolvePnpm(env, checkouts);
      if (pnpm === null) {
        const tail =
          "No trustworthy pnpm was found on the login shell's PATH: it must be a program outside the project's checkouts, not a script and not a version manager's shim.";
        mkdirSync(dirname(logPath), { recursive: true });
        writeFileSync(logPath, `${tail}\n`);
        return { kind: 'failed', exitCode: 127, timedOut: false, tail, logPath };
      }
      const result = await deps.gate.run({
        project: { repoPath: path, sandboxLoopback: project.sandboxLoopback },
        command: generateCommand(pnpm, dirs),
        logPath,
        timeoutMs: deps.timeoutMs,
        env,
        rules: deps.rules(project),
        checkouts,
        signal,
      });
      if (result.aborted) return { kind: 'aborted' };
      if (result.exitCode !== 0 || result.timedOut)
        return {
          kind: 'failed',
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          tail: result.tail,
          logPath: result.logPath,
        };
      return { kind: 'done', logPath: result.logPath };
    },
  };
}
