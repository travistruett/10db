import {
  EvalCoverageState,
  EvidenceKind,
  type EvalCoverageSuiteDto,
  type WorkstreamId,
} from '@10db/contracts';
import { newestEvidenceOfKind, newestEvidenceOfKindIn, type DbReader } from '@10db/db';
import { coverageLines } from './coverage';
import type { CoverageQuery, EvalsService } from './service';

/**
 * The suites each task's change touched, with where each stands against the checkout's results as read now.
 * The touched suites are the newest `eval_coverage` row's, matched against the manifest as the run began;
 * a task with none is absent from the answer. One read of the results serves every task.
 */
export async function suitesOfTasks(
  db: DbReader,
  evals: Pick<EvalsService, 'standing'>,
  repoPath: string,
  tasks: readonly { readonly id: string; readonly workstreamId: WorkstreamId | null }[],
): Promise<Map<string, EvalCoverageSuiteDto[]>> {
  const found: {
    taskId: string;
    key: string;
    label: string;
    paths: string[];
    liveCommand: string | null;
  }[] = [];
  const queries: CoverageQuery[] = [];
  const rows = newestEvidenceOfKindIn(
    db,
    tasks.flatMap((t) => (t.workstreamId === null ? [] : [t.workstreamId])),
    EvidenceKind.EvalCoverage,
  );
  for (const task of tasks) {
    if (task.workstreamId === null) continue;
    const row = rows.get(task.workstreamId);
    if (row?.kind !== EvidenceKind.EvalCoverage) continue;
    const { suites, matched, baseAt, headAt } = row.detail;
    for (const m of matched ?? []) {
      const suite = suites.find((s) => s.key === m.key);
      found.push({
        taskId: task.id,
        key: m.key,
        label: suite?.label ?? m.key,
        paths: m.paths,
        liveCommand: suite?.liveCommand ?? null,
      });
      queries.push({ key: m.key, baseAt, headAt });
    }
  }
  const out = new Map<string, EvalCoverageSuiteDto[]>();
  if (found.length === 0) return out;
  const standing = await evals.standing(repoPath, queries);
  found.forEach((f, i) => {
    const at = standing[i];
    const dto: EvalCoverageSuiteDto = {
      suiteKey: f.key,
      label: f.label,
      state: at?.state ?? EvalCoverageState.NotRun,
      paths: f.paths,
      liveCommand: f.liveCommand,
      before: at?.before ?? null,
      after: at?.after ?? null,
    };
    out.set(f.taskId, [...(out.get(f.taskId) ?? []), dto]);
  });
  return out;
}

/** The lines a run's Inbox cards add for the eval suites its change touched; none when it touched none. */
export function coverageLinesOf(db: DbReader, workstreamId: WorkstreamId): string[] {
  const held = newestEvidenceOfKind(db, workstreamId, EvidenceKind.EvalCoverage);
  return held?.kind === EvidenceKind.EvalCoverage ? coverageLines(held.detail) : [];
}
