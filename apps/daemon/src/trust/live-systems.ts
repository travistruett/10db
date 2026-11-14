import { LIVE_SYSTEMS_MAX, LiveSystem, type ProjectId } from '@10db/contracts';
import { getAppSetting, setAppSetting, type DbReader, type WriteContext } from '@10db/db';
import { z } from 'zod';

const LiveSystems = z.array(LiveSystem).max(LIVE_SYSTEMS_MAX);

const settingKey = (projectId: ProjectId): string => `trust-live.${projectId}`;

/**
 * The hosts, cloud profiles and namespaces the builder named live for the project (Settings › Project ›
 * Live systems). A stored value that is not that shape reads as none, and `onInvalid` is told.
 */
export function projectLiveSystems(
  db: DbReader,
  projectId: ProjectId,
  onInvalid: (stored: unknown) => void = () => undefined,
): string[] {
  const stored = getAppSetting(db, settingKey(projectId));
  if (stored === undefined) return [];
  const parsed = LiveSystems.safeParse(stored);
  if (parsed.success) return parsed.data;
  onInvalid(stored);
  return [];
}

/** Stores the project's live systems, trimmed and without duplicates; throws a ZodError on a bad entry. */
export function setProjectLiveSystems(
  ctx: WriteContext,
  projectId: ProjectId,
  entries: readonly string[],
): void {
  const parsed = LiveSystems.parse(entries);
  setAppSetting(ctx, settingKey(projectId), [...new Set(parsed)]);
}
