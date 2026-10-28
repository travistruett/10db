import type { BatchDto, BatchId, ProjectId } from '@10db/contracts';
import { getBatch, getProject, listLiveWorktrees, listProjects, type DbReader } from '@10db/db';

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
