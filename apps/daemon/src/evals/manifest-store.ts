import { EventType, StoredEvalManifest, type ProjectId } from '@10db/contracts';
import {
  getAppSetting,
  setAppSetting,
  type DbReader,
  type Json,
  type WriteContext,
} from '@10db/db';

const key = (projectId: ProjectId): string => `evals-manifest:${projectId}`;

/** The manifest an agent last recorded for a project; null when none, or one that no longer parses. */
export function readEvalManifest(db: DbReader, projectId: ProjectId): StoredEvalManifest | null {
  const stored = StoredEvalManifest.safeParse(getAppSetting(db, key(projectId)));
  return stored.success ? stored.data : null;
}

export function writeEvalManifest(
  ctx: WriteContext,
  projectId: ProjectId,
  stored: StoredEvalManifest,
): void {
  // The manifest is validated JSON, so it is a Json value.
  setAppSetting(ctx, key(projectId), stored as unknown as Json);
  // The Evals view refetches on the project's change, as it does for a hazard addition.
  ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: projectId });
}
