import type { BatchId, CopyId, ProjectDto } from '@10db/contracts';
import { join } from 'node:path';
import type { Clock } from '../clock';
import type { GateResult, GateRunner } from '../verify';
import type { Logger } from '../log';
import type { PermissionRuleDto } from '@10db/contracts';

/** Runs a copy's pinned teardown command. */
export interface CopyTeardown {
  /**
   * Runs `command` in `project.repoPath` (a scratch worktree of the pinned commit) under the gate's
   * sandbox, with the copy's id in its environment. It takes no gate slot: a long gate never holds a
   * teardown, as the dev login's run doesn't.
   */
  run(input: {
    readonly project: ProjectDto;
    readonly batchId: BatchId;
    readonly copyId: CopyId | null;
    readonly command: string;
    readonly signal: AbortSignal;
  }): Promise<GateResult>;
}

export interface CopyTeardownDeps {
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
}

export function createCopyTeardown(deps: CopyTeardownDeps): CopyTeardown {
  return {
    async run(input) {
      const logPath = join(
        deps.dataDir,
        'logs',
        'teardown',
        `batch-${input.batchId}-${String(deps.clock.now().getTime())}.log`,
      );
      deps.logger.info({ batchId: input.batchId, logPath }, 'copy teardown started');
      return deps.gate.run({
        project: input.project,
        command: input.command,
        copyId: input.copyId,
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
