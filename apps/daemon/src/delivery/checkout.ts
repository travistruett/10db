import {
  LANE_STATES,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  listLiveWorktrees,
  listProjects,
  listWorkstreams,
  type DbReader,
} from '@10db/db';

/** Where a workstream works: its batch's worktree when it has one, else the project's checkout. */
export function checkoutOf(
  db: DbReader,
  ws: { readonly projectId: ProjectId; readonly batchId: BatchId | null },
): string {
  if (ws.batchId !== null) {
    const batch = getBatch(db, ws.batchId);
    if (batch.worktreePath !== null) return batch.worktreePath;
  }
  return getProject(db, ws.projectId).repoPath;
}

/**
 * Workstreams with work in hand in the project's own checkout: the lanes that write the files a
 * branch switch would move. A lane in a separate copy edits other files and is not counted
 * (task placement spec, P6). Counted as Abandon counts them: a lane state, a taken-over session, or
 * a waiting one that still holds a session.
 */
export function lanesInProjectCheckout(db: DbReader, project: ProjectDto): number {
  return listWorkstreams(db, { projectId: project.id }).filter(
    (w) =>
      (LANE_STATES.includes(w.state) ||
        w.state === WorkstreamState.TakenOver ||
        (w.state === WorkstreamState.WaitingHuman && w.currentSessionId !== null)) &&
      checkoutOf(db, w) === project.repoPath,
  ).length;
}

/**
 * The batch whose copy a workstream's area and per-copy hazard claims belong to: its batch when that batch has a worktree, since
 * each worktree is its own checkout; otherwise none, and its areas are exclusive across the project.
 * Other hazards are project-wide (`copyHazardNames` says which are per copy).
 */
export function claimScopeOf(
  db: DbReader,
  ws: { readonly batchId: BatchId | null },
): BatchId | undefined {
  if (ws.batchId === null) return undefined;
  return getBatch(db, ws.batchId).worktreePath !== null ? ws.batchId : undefined;
}

/** Where a batch's work, gate and checks run: its worktree while it has one, else its project's checkout. */
export function batchCheckout(db: DbReader, batch: BatchDto): string {
  return batch.worktreePath ?? getProject(db, batch.projectId).repoPath;
}

/** Every registered checkout and every live worktree: what every sandbox denies writes to. */
export function allCheckouts(db: DbReader): string[] {
  return [
    ...listProjects(db).map((project) => project.repoPath),
    ...listLiveWorktrees(db).flatMap((batch) => (batch.worktreePath ? [batch.worktreePath] : [])),
  ];
}

/** The project as the sandboxes and the gate see it from a checkout: only `repoPath` differs. */
export function projectAtCheckout<P extends { readonly repoPath: string }>(
  project: P,
  checkout: string,
): P {
  return checkout === project.repoPath ? project : { ...project, repoPath: checkout };
}
