import { z } from 'zod';
import {
  InvalidError,
  ProjectWatchpoints,
  revisedWatchpoints,
  withWatchpointEntry,
  WatchpointProposalScope,
  INITIAL_WATCHPOINTS,
  STARTER_REVISION,
  YourWatchpoints,
  type Watchpoint,
  type WatchpointProposal,
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

/**
 * Writes an accepted watchpoint proposal into its list: the entry replaces the one with its key, or is added. A list
 * the change would leave invalid (more than the limit) refuses it, so the card stays open.
 */
export function applyWatchpointProposal(
  ctx: WriteContext,
  projectId: ProjectId,
  proposal: WatchpointProposal,
): void {
  switch (proposal.scope) {
    case WatchpointProposalScope.Project: {
      const next = ProjectWatchpoints.safeParse(
        withWatchpointEntry(readProjectWatchpoints(ctx.tx, projectId), proposal.entry),
      );
      if (!next.success) throw new InvalidError(`The project's watchpoints can't take this change`);
      writeProjectWatchpoints(ctx, projectId, next.data);
      return;
    }
    case WatchpointProposalScope.You: {
      const next = YourWatchpoints.safeParse(
        withWatchpointEntry(readYourWatchpoints(ctx.tx), proposal.entry),
      );
      if (!next.success) throw new InvalidError(`Your watchpoints can't take this change`);
      writeYourWatchpoints(ctx, next.data);
      return;
    }
  }
}
