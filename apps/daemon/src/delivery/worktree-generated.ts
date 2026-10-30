import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, ProjectDto } from '@10db/contracts';
import type { WorktreeDependenciesDeps } from './worktree-dependencies';

/**
 * The directories made by a generator, never merged by hand (the root AGENTS.md), and the workspace
 * package whose `generate` script makes each. In the order they are generated: the database package
 * reads the contracts.
 */
export const GENERATED = [
  { dir: 'packages/contracts/generated/', filter: '@10db/contracts' },
  { dir: 'packages/db/drizzle/', filter: '@10db/db' },
] as const;

/** The generated directories, as `Git.mergeIntoBranch` is told them. */
export const GENERATED_DIRS: readonly string[] = GENERATED.map((g) => g.dir);

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The command that regenerates `dirs`: each one's package's `generate` script, with the pnpm the
 * daemon resolved (`pnpm`, an absolute path outside every checkout). Like the install, the program
 * is fixed here and the repository's own config can't choose it.
 */
export function generateCommand(pnpm: string, dirs: readonly string[]): string {
  const env =
    'pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0';
  return GENERATED.filter((g) => dirs.includes(g.dir))
    .map((g) => `${env} ${quoted(pnpm)} --filter ${quoted(g.filter)} generate`)
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
  /** Runs the generators of `dirs` (members of `GENERATED_DIRS`) in the batch's worktree. */
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
