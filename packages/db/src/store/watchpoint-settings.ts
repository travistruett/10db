import { z } from 'zod';
import {
  ProjectWatchpoints,
  revisedWatchpoints,
  INITIAL_WATCHPOINTS,
  STARTER_REVISION,
  YourWatchpoints,
  type Watchpoint,
  type ProjectWatchpointEntry,
  type ProjectId,
} from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

/** The builder's watchpoints, applying in every project. */
const YOUR_WATCHPOINTS_KEY = 'watchpoints.you';
/** The starter revision the builder's list was last saved at; absent on a list saved before revisions. */
const YOUR_REVISION_KEY = 'watchpoints.you.revision';
const projectKey = (projectId: ProjectId): string => `watchpoints.${projectId}`;

/**
 * The builder's watchpoints: the initial starters until the list is first saved. A setting that doesn't parse reads as
 * none: it is a boundary, and a bad value must never stop a run.
 */
export function readYourWatchpoints(db: DbReader): Watchpoint[] {
  const stored = getAppSetting(db, YOUR_WATCHPOINTS_KEY);
  if (stored === undefined) return [...INITIAL_WATCHPOINTS];
  const parsed = YourWatchpoints.safeParse(stored);
  if (!parsed.success) return [];
  const savedAt = z.number().int().safeParse(getAppSetting(db, YOUR_REVISION_KEY));
  return revisedWatchpoints(parsed.data, savedAt.success ? savedAt.data : 1);
}

export function writeYourWatchpoints(ctx: WriteContext, watchpoints: readonly Watchpoint[]): void {
  setAppSetting(ctx, YOUR_WATCHPOINTS_KEY, YourWatchpoints.parse(watchpoints));
  setAppSetting(ctx, YOUR_REVISION_KEY, STARTER_REVISION);
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
