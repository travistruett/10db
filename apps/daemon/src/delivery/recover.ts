import { BatchFailure, BatchState, type BatchId } from '@10db/contracts';
import {
  deleteCuttingBatch,
  getBatchRow,
  getProject,
  listBatches,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { startCards, wrongBranchCard } from './cards';
import { raise } from './context';
import type { Shipper } from './ship';

/** Kills a recorded process (group) only while its start time still matches (recovery/processes.ts). */
export interface GateTerminator {
  terminate(target: {
    readonly pid: number;
    readonly startedAt: string;
    readonly group?: boolean;
  }): Promise<unknown>;
}

export interface BatchRecoveryReport {
  readonly deleted: BatchId[];
  readonly failed: BatchId[];
  readonly resumed: BatchId[];
}

/**
 * Batch delivery spec §5 and §6 at startup, after workstream recovery and before the scheduler: a
 * CUTTING row is deleted (a branch the crash left stays, and the next cut uses a new name); an
 * orphaned shipping gate is killed; an unfinished batch off its branch fails; a SHIPPING batch
 * re-runs from step 0; an OPEN batch whose work all settled ships.
 */
export async function recoverBatches(deps: {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly processes: GateTerminator;
  readonly shipper: Shipper;
  readonly logger: Logger;
}): Promise<BatchRecoveryReport> {
  const db = deps.state.db;
  const report: BatchRecoveryReport = { deleted: [], failed: [], resumed: [] };

  for (const batch of listBatches(db, { states: [BatchState.Cutting] })) {
    deps.state.write((w) => {
      deleteCuttingBatch(w, batch.id, 'the daemon restarted while cutting the branch');
    });
    // The API answered 202 for its tasks; say they didn't start.
    raise(deps.inbox, batch.projectId, startCards.cutInterrupted(batch));
    report.deleted.push(batch.id);
  }

  for (const batch of listBatches(db, { states: [BatchState.Shipping] })) {
    const row = getBatchRow(db, batch.id);
    if (row.gatePid === null || row.gatePidStart === null) continue;
    await deps.processes.terminate({ pid: row.gatePid, startedAt: row.gatePidStart, group: true });
    deps.state.write((w) => patchBatch(w, batch.id, { gatePid: null, gatePidStart: null }));
  }

  for (const batch of listBatches(db, { states: [BatchState.Open, BatchState.Shipping] })) {
    const project = getProject(db, batch.projectId);
    const current = await deps.git.currentBranch(project.repoPath).catch(() => null);
    if (current !== batch.branch) {
      const card = wrongBranchCard(batch, current, project.repoPath, 'failed');
      deps.state.write((w) =>
        transitionBatch(w, batch.id, {
          to: BatchState.Failed,
          patch: { failure: BatchFailure.WrongBranch },
          reason: card.title,
        }),
      );
      raise(deps.inbox, project.id, card);
      report.failed.push(batch.id);
      continue;
    }
    if (batch.state === BatchState.Shipping) {
      deps.shipper.resume(batch.id);
      report.resumed.push(batch.id);
    }
  }

  deps.shipper.checkOpenBatches();
  deps.logger.info({ ...report }, 'batch recovery complete');
  return report;
}
