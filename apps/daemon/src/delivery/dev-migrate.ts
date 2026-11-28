import type { BatchId, PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { join } from 'node:path';
import type { Clock } from '../clock';
import type { Logger } from '../log';
import type { GateResult, GateRunner } from '../verify';

/** Runs a project's declared migrate command against its dev database after a landing brings migrations. */
export interface DevMigrate {
  /**
   * Runs `command` in `project.repoPath`, the builder's own folder, under the gate's sandbox with
   * localhost allowed and no copy id: the database it reaches is the project's dev database, never a
   * copy's, a worktree's or anything 10db points it at. It takes no gate slot, as a copy's teardown
   * doesn't.
   */
  run(input: {
    readonly project: ProjectDto;
    readonly batchId: BatchId;
    readonly command: string;
    readonly signal: AbortSignal;
  }): Promise<GateResult>;
}

export interface DevMigrateDeps {
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly dataDir: string;
  readonly logger: Logger;
  readonly timeoutMs: number;
  readonly sessionEnv: () => Readonly<Record<string, string>>;
  readonly rules: (
    project: ProjectDto,
  ) => readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly checkouts: () => readonly string[];
  /** Whether the command is seen to call Docker, so a dev database in a container is reachable. */
  readonly usesDocker: (project: ProjectDto, command: string) => Promise<boolean>;
}

/** The longest a migrate command may run. */
export const DEV_MIGRATE_TIMEOUT_MS = 10 * 60_000;

export function createDevMigrate(deps: DevMigrateDeps): DevMigrate {
  return {
    async run(input) {
      const logPath = join(
        deps.dataDir,
        'logs',
        'migrate',
        `batch-${input.batchId}-${String(deps.clock.now().getTime())}.log`,
      );
      const docker =
        input.project.sandboxDocker || (await deps.usesDocker(input.project, input.command));
      deps.logger.info({ batchId: input.batchId, logPath, docker }, 'dev migrate started');
      return deps.gate.run({
        // No project id: the run never turns the project's Docker switch on or leaves its note. A local
        // dev database answers on loopback, so localhost is allowed whatever the project's switch says.
        project: {
          repoPath: input.project.repoPath,
          sandboxLoopback: true,
          sandboxDocker: docker,
        },
        command: input.command,
        logPath,
        timeoutMs: deps.timeoutMs,
        env: deps.sessionEnv(),
        rules: deps.rules(input.project),
        checkouts: deps.checkouts(),
        signal: input.signal,
      });
    },
  };
}
