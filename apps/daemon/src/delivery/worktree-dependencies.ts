import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, PermissionRuleDto, ProjectDto, ProjectId } from '@10db/contracts';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { raiseGateHostCards, type InboxService } from '../inbox';
import type { Logger } from '../log';
import { takeFoundHostsReading } from '../registries';
import { BlockedRun, type GateRunner } from '../verify';
import { checkInstall, foreignInstall, PNPM_LOCKFILE, removeBrokenInstall } from './install-health';

export { PNPM_LOCKFILE };

/**
 * What the builder is told runs. The real command (`installCommand`) also fixes the program, the
 * store and the directories, which the repository's own config could otherwise choose.
 */
export const INSTALL_SUMMARY = 'pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile';

/**
 * `frozen` brings the packages in line with the lockfile as it is. `update` is a lane's dependency
 * change (`install_dependencies`): pnpm resolves the manifests the lane edited and writes the lockfile.
 */
export type InstallMode = 'frozen' | 'update';

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
export function installCommand(pnpm: string, mode: InstallMode = 'frozen'): string {
  return [
    // A blocked registry host answers every request with a refusal; the default retries, a minute
    // apart, would keep the cut waiting for minutes before it says so.
    'pnpm_config_fetch_retries=1 pnpm_config_fetch_retry_mintimeout=1000 pnpm_config_fetch_retry_maxtimeout=5000',
    'pnpm_config_manage_package_manager_versions=false COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_AUTO_PIN=0',
    quoted(pnpm),
    `install ${mode === 'update' ? '--no-frozen-lockfile' : '--frozen-lockfile'} --ignore-scripts --ignore-pnpmfile`,
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
      /** The hosts the sandbox refused the install, lower case, each once: each gets a card. */
      readonly blockedHosts: readonly string[];
    }
  /** Shutdown stopped the install. */
  | { readonly kind: 'aborted' };

/**
 * Asks the builder about each host the sandbox refused a failed install: one card per host for the
 * project, naming the install, which folds into a blocked gate's card for the same host.
 */
export async function raiseInstallHostCards(
  deps: {
    readonly state: StateStore;
    readonly inbox: InboxService;
    readonly git: Pick<Git, 'commitAt' | 'folderAt' | 'fileAt'>;
    readonly logger: Logger;
  },
  projectId: ProjectId,
  failure: Extract<DependencyRefresh, { readonly kind: 'failed' }>,
): Promise<void> {
  // A project added before 10db kept a reading of its package files gets one, so the card can name the file.
  if (failure.blockedHosts.length > 0) await takeFoundHostsReading(deps, projectId);
  raiseGateHostCards(deps, {
    projectId,
    run: BlockedRun.Install,
    command: INSTALL_SUMMARY,
    hosts: failure.blockedHosts,
  });
}

export interface WorktreeDependencies {
  refresh(input: {
    readonly batch: BatchDto;
    readonly project: ProjectDto;
    /** The worktree, after its seed. */
    readonly path: string;
    readonly signal: AbortSignal;
    /**
     * False when the cut skipped the seed (a shared batch was unfinished): a missing `node_modules`
     * is then expected, and the install makes it. Default true.
     */
    readonly seeded?: boolean;
    /** Default `frozen`. */
    readonly mode?: InstallMode;
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
  /**
   * The version of that pnpm, or null when it can't be read. Without it, a copy made by another pnpm
   * is told from the daemon's only by its store, or by the install that fails on it.
   */
  readonly pnpmVersion?: (
    pnpm: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<string | null>;
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
    async refresh({ batch, project, path, signal, seeded = true, mode = 'frozen' }) {
      // Not pnpm's, or (seeded) the main checkout had no install to bring in line.
      if (!existsSync(join(path, PNPM_LOCKFILE))) return { kind: 'skipped' };
      if (seeded && !existsSync(join(path, 'node_modules'))) return { kind: 'skipped' };
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
        return { kind: 'failed', exitCode: 127, timedOut: false, tail, logPath, blockedHosts: [] };
      }
      // pnpm repairs an install that is out of date, but not one that is pruned or was made by another
      // pnpm and store: it decides to remove `node_modules/.pnpm`, the sandbox refuses part way, and the
      // copy is left holding a fifth of its packages. A copy whose dependencies do not resolve, or
      // whose install another pnpm or store made (a seed cloned from a main checkout the builder
      // installed with their own pnpm), starts over, as the first install of a copy does, which
      // works. Sources are not touched.
      const foreign = foreignInstall(path, {
        version: (await deps.pnpmVersion?.(pnpm, env)) ?? null,
        storeDir: env['pnpm_config_store_dir'],
      });
      if (foreign !== null || checkInstall(path).kind === 'broken') removeBrokenInstall(path);
      const install = async (): Promise<DependencyRefresh> => {
        const result = await deps.gate.run({
          project: { repoPath: path, sandboxLoopback: project.sandboxLoopback },
          command: installCommand(pnpm, mode),
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
            blockedHosts: result.blockedHosts,
          };
        return { kind: 'installed', logPath: result.logPath, durationMs: result.durationMs };
      };
      const first = await install();
      // An install the sandbox stopped part way leaves packages missing. Once is enough to start
      // over: a copy with nothing in node_modules installs as a new one does. Not after a timeout
      // (it would only wait again) or a refused host (the same refusal would come back).
      if (
        first.kind === 'failed' &&
        !first.timedOut &&
        first.blockedHosts.length === 0 &&
        checkInstall(path).kind === 'broken'
      ) {
        removeBrokenInstall(path);
        return install();
      }
      return first;
    },
  };
}
