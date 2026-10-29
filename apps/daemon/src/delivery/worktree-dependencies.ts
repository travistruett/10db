import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, PermissionRuleDto, ProjectDto } from '@10db/contracts';
import type { Clock } from '../clock';
import type { GateRunner } from '../verify';

/** The lockfile that says a project's packages are pnpm's. */
const PNPM_LOCKFILE = 'pnpm-lock.yaml';

/**
 * What the builder is told runs. The real command (`installCommand`) also fixes the program, the
 * store and the directories, which the repository's own config could otherwise choose.
 */
export const INSTALL_SUMMARY = 'pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile';

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Brings a seeded `node_modules` in line with the worktree's own lockfile, with a pnpm the daemon
 * resolved (`pnpm`, an absolute path outside every checkout). The scripts and the pnpmfile are off: a
 * worktree install runs no code from the repository, and the root `prepare` script (`lefthook
 * install`) would otherwise write git hooks into the main checkout's git directory, which every
 * worktree shares. The repository does not choose the program (`packageManager` and corepack are
 * switched off) or where pnpm writes (`.npmrc` and workspace settings can name a store, a modules
 * directory and a virtual store, so all three are given on the command line).
 */
export function installCommand(pnpm: string): string {
  return [
    // A blocked registry host answers every request with a refusal; the default retries, a minute
    // apart, would keep the cut waiting for minutes before it says so.
    'pnpm_config_fetch_retries=1 pnpm_config_fetch_retry_mintimeout=1000 pnpm_config_fetch_retry_maxtimeout=5000',
    'pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0',
    quoted(pnpm),
    'install --frozen-lockfile --ignore-scripts --ignore-pnpmfile',
    '--store-dir "$pnpm_config_store_dir" --modules-dir node_modules --virtual-store-dir node_modules/.pnpm',
  ].join(' ');
}

export type DependencyRefresh =
  /** Nothing to do: the project is not pnpm's, or the seed left no `node_modules`. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'installed'; readonly logPath: string; readonly durationMs: number }
  | {
      readonly kind: 'failed';
      readonly exitCode: number;
      readonly timedOut: boolean;
      /** The end of the install's output. */
      readonly tail: string;
      readonly logPath: string;
    }
  /** Shutdown stopped the install. */
  | { readonly kind: 'aborted' };

export interface WorktreeDependencies {
  refresh(input: {
    readonly batch: BatchDto;
    readonly project: ProjectDto;
    /** The worktree, after its seed. */
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<DependencyRefresh>;
}

export interface WorktreeDependenciesDeps {
  /** Runs the install under the gate sandbox. */
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly dataDir: string;
  /** The env the install starts from, the session env a gate has. */
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  /** The project's stored rules: the registry host opens as it does for a gate. */
  rules(project: ProjectDto): readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  /** Every registered checkout and live worktree, which the install can't write. */
  checkouts(): readonly string[];
  readonly timeoutMs: number;
  /** The absolute path of a real pnpm program to run, found outside every checkout; null when none is trustworthy. */
  resolvePnpm(
    env: Readonly<Record<string, string>>,
    checkouts: readonly string[],
  ): Promise<string | null>;
}

/**
 * A new worktree's `node_modules` is a copy of the main checkout's, which holds whatever the builder
 * last installed there, not what the worktree's lockfile names; a gate in the worktree then fails on
 * types and tests of packages that moved. This runs pnpm's own check-and-repair against the
 * worktree's lockfile under the gate's sandbox (the registry host a project allows, no secret, no
 * write outside the worktree and the run's temp dir), so nothing from the repository runs outside
 * the sandbox.
 */
export function createWorktreeDependencies(deps: WorktreeDependenciesDeps): WorktreeDependencies {
  return {
    async refresh({ batch, project, path, signal }) {
      if (!existsSync(join(path, PNPM_LOCKFILE)) || !existsSync(join(path, 'node_modules')))
        return { kind: 'skipped' };
      const logPath = join(
        deps.dataDir,
        'logs',
        'install',
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
        command: installCommand(pnpm),
        logPath,
        timeoutMs: deps.timeoutMs,
        env,
        rules: deps.rules(project),
        checkouts,
        signal,
        packageInstall: true,
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
      return { kind: 'installed', logPath: result.logPath, durationMs: result.durationMs };
    },
  };
}
