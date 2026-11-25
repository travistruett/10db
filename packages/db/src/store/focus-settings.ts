import {
  ProjectFocuses,
  YourFocuses,
  type Focus,
  type ProjectFocusEntry,
  type ProjectId,
} from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

/** The builder's focuses, applying in every project. */
const YOUR_FOCUSES_KEY = 'focuses.you';
const projectKey = (projectId: ProjectId): string => `focuses.${projectId}`;

/**
 * The builder's focuses. A setting that is missing or doesn't parse reads as none: it is a boundary, and a bad
 * value must never stop a run.
 */
export function readYourFocuses(db: DbReader): Focus[] {
  const parsed = YourFocuses.safeParse(getAppSetting(db, YOUR_FOCUSES_KEY));
  return parsed.success ? parsed.data : [];
}

/** Whether the builder's list has ever been saved, so a fresh install can start from the starters. */
export function hasYourFocuses(db: DbReader): boolean {
  return getAppSetting(db, YOUR_FOCUSES_KEY) !== undefined;
}

export function writeYourFocuses(ctx: WriteContext, focuses: readonly Focus[]): void {
  setAppSetting(ctx, YOUR_FOCUSES_KEY, YourFocuses.parse(focuses));
}

/** A project's own focuses and the `off` entries that drop the builder's there. */
export function readProjectFocuses(db: DbReader, projectId: ProjectId): ProjectFocusEntry[] {
  const parsed = ProjectFocuses.safeParse(getAppSetting(db, projectKey(projectId)));
  return parsed.success ? parsed.data : [];
}

export function writeProjectFocuses(
  ctx: WriteContext,
  projectId: ProjectId,
  entries: readonly ProjectFocusEntry[],
): void {
  setAppSetting(ctx, projectKey(projectId), ProjectFocuses.parse(entries));
}
