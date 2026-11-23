import { AreaRole, ProjectId, TaskStatus, type AreaDef } from '@10db/contracts';
import {
  getAppSetting,
  listActiveProjects,
  listTasks,
  patchProject,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { proposeSetupAreas, withGuessedLabels } from '../folders';
import type { Git } from '../git';
import type { Logger } from '../log';

/**
 * The projects whose pages still wait for a label guess. It is set once, to the projects there
 * are then, and only ever shrinks.
 */
export const PAGE_LABELS_PENDING_KEY = 'workbench.page_labels_pending';

const Pending = z.array(ProjectId);

export interface PageLabelGuessDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'survey' | 'surveyTexts'>;
  readonly logger: Pick<Logger, 'warn'>;
}

function pendingIds(db: DbReader): ProjectId[] | undefined {
  const stored = getAppSetting(db, PAGE_LABELS_PENDING_KEY);
  if (stored === undefined) return undefined;
  const parsed = Pending.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** Takes a project off the pending list: its pages are guessed, or the builder saved its areas. */
export function dropPendingPageLabels(ctx: WriteContext, id: ProjectId): void {
  const pending = pendingIds(ctx.tx);
  if (pending?.includes(id) === true)
    setAppSetting(
      ctx,
      PAGE_LABELS_PENDING_KEY,
      pending.filter((p) => p !== id),
    );
}

/**
 * Lists every project there is as waiting for a label guess, the first time it runs and never
 * again: a project added later is set up with its labels, so it never waits. Runs at start, before
 * the API serves.
 */
export function seedPendingPageLabels(state: StateStore): void {
  if (pendingIds(state.db) !== undefined) return;
  state.write((ctx) => {
    setAppSetting(
      ctx,
      PAGE_LABELS_PENDING_KEY,
      listActiveProjects(ctx.tx).map((p) => p.id),
    );
  });
}

/**
 * Gives the pages of each pending project that have no label the label the Workbench setup guesses
 * from the app's nav, then takes the project off the list. A label the builder set is never
 * replaced, and a project whose areas the builder saved meanwhile is left as saved. A project whose
 * repository can't be read stays pending for the next start. Reads git's object store only, as the
 * setup does.
 */
export async function guessPendingPageLabels(
  deps: PageLabelGuessDeps,
  signal?: AbortSignal,
): Promise<void> {
  for (const id of pendingIds(deps.state.db) ?? []) {
    signal?.throwIfAborted();
    const project = listActiveProjects(deps.state.db).find((p) => p.id === id);
    const unlabelled =
      project?.areas.some((a) => a.role === AreaRole.Page && a.label === undefined) === true;
    let proposed: AreaDef[] = [];
    if (project !== undefined && unlabelled) {
      const open = listTasks(deps.state.db, id).filter((t) => t.status === TaskStatus.Open);
      try {
        proposed = (await proposeSetupAreas({ git: deps.git }, project, open, signal)).proposed;
      } catch (error) {
        if (signal?.aborted === true) throw error;
        deps.logger.warn({ err: error, projectId: id }, 'page labels not guessed');
        continue;
      }
    }
    try {
      deps.state.write((ctx) => {
        // Still pending means the builder has not saved the areas while the setup read git.
        if (pendingIds(ctx.tx)?.includes(id) !== true) return;
        const current = listActiveProjects(ctx.tx).find((p) => p.id === id);
        if (current !== undefined) {
          const areas = withGuessedLabels(current.areas, proposed);
          if (areas !== null) patchProject(ctx, id, { areas });
        }
        dropPendingPageLabels(ctx, id);
      });
    } catch (error) {
      deps.logger.warn({ err: error, projectId: id }, 'page labels not saved');
    }
  }
}
