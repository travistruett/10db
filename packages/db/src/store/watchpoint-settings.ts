import {
  ProjectWatchpoints,
  revisedWatchpoints,
  STARTER_WATCHPOINTS,
  YourWatchpoints,
  type Watchpoint,
  type ProjectWatchpointEntry,
  type ProjectId,
} from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

/** The builder's watchpoints, applying in every project. */
const YOUR_WATCHPOINTS_KEY = 'watchpoints.you';
const projectKey = (projectId: ProjectId): string => `watchpoints.${projectId}`;

/**
 * The builder's watchpoints: the starters until the list is first saved. A setting that doesn't parse reads as
 * none: it is a boundary, and a bad value must never stop a run.
 */
export function readYourWatchpoints(db: DbReader): Watchpoint[] {
  const stored = getAppSetting(db, YOUR_WATCHPOINTS_KEY);
  if (stored === undefined) return [...STARTER_WATCHPOINTS];
  const parsed = YourWatchpoints.safeParse(stored);
  return parsed.success ? revisedWatchpoints(parsed.data) : [];
}

export function writeYourWatchpoints(ctx: WriteContext, watchpoints: readonly Watchpoint[]): void {
  setAppSetting(ctx, YOUR_WATCHPOINTS_KEY, YourWatchpoints.parse(watchpoints));
}

/** A project's own watchpoints and the `off` entries that drop the builder's there. */
export function readProjectWatchpoints(
  db: DbReader,
  projectId: ProjectId,
): ProjectWatchpointEntry[] {
  const parsed = ProjectWatchpoints.safeParse(getAppSetting(db, projectKey(projectId)));
  return parsed.success ? parsed.data : [];
}

export function writeProjectWatchpoints(
  ctx: WriteContext,
  projectId: ProjectId,
  entries: readonly ProjectWatchpointEntry[],
): void {
  setAppSetting(ctx, projectKey(projectId), ProjectWatchpoints.parse(entries));
}
