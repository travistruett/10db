import {
  ProjectWatchpoints,
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
 * The builder's watchpoints. A setting that is missing or doesn't parse reads as none: it is a boundary, and a bad
 * value must never stop a run.
 */
export function readYourWatchpoints(db: DbReader): Watchpoint[] {
  const parsed = YourWatchpoints.safeParse(getAppSetting(db, YOUR_WATCHPOINTS_KEY));
  return parsed.success ? parsed.data : [];
}

/** Whether the builder's list has ever been saved, so a fresh install can start from the starters. */
export function hasYourWatchpoints(db: DbReader): boolean {
  return getAppSetting(db, YOUR_WATCHPOINTS_KEY) !== undefined;
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
