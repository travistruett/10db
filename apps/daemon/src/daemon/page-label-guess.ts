import { AreaRole, ProjectId, TaskStatus } from '@10db/contracts';
import {
  getAppSetting,
  getProject,
  listProjects,
  listTasks,
  patchProject,
  setAppSetting,
  type DbReader,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { proposeSetupAreas, withGuessedLabels } from '../folders';
import type { Git } from '../git';
import type { Logger } from '../log';

/** The projects whose pages have had their labels guessed, each once. */
export const PAGE_LABELS_GUESSED_KEY = 'workbench.page_labels_guessed';

const Guessed = z.array(ProjectId);

export interface PageLabelGuessDeps {
  readonly state: StateStore;
  readonly git: Pick<Git, 'survey' | 'surveyTexts'>;
  readonly logger: Pick<Logger, 'warn'>;
}

function guessedIds(db: DbReader): ProjectId[] {
  const parsed = Guessed.safeParse(getAppSetting(db, PAGE_LABELS_GUESSED_KEY) ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * Gives each project's pages that have no label the label the Workbench setup guesses from the
 * app's nav, once per project: a label the builder clears later is never guessed again, and one
 * the builder set is never replaced. A project whose repository can't be read is tried again at
 * the next start. Reads git's object store only, as the setup does.
 */
export async function guessPageLabelsOnce(
  deps: PageLabelGuessDeps,
  signal?: AbortSignal,
): Promise<void> {
  const done = new Set(guessedIds(deps.state.db));
  for (const project of listProjects(deps.state.db)) {
    if (done.has(project.id)) continue;
    signal?.throwIfAborted();
    const unlabelled = project.areas.some((a) => a.role === AreaRole.Page && a.label === undefined);
    let proposed: Awaited<ReturnType<typeof proposeSetupAreas>>['proposed'] = [];
    if (unlabelled) {
      const open = listTasks(deps.state.db, project.id).filter((t) => t.status === TaskStatus.Open);
      try {
        proposed = (await proposeSetupAreas({ git: deps.git }, project, open, signal)).proposed;
      } catch (error) {
        if (signal?.aborted === true) throw error;
        deps.logger.warn({ err: error, projectId: project.id }, 'page labels not guessed');
        continue;
      }
    }
    try {
      deps.state.write((ctx) => {
        // The areas are read again here: the builder may have saved them while the setup read git.
        const areas = withGuessedLabels(getProject(ctx.tx, project.id).areas, proposed);
        if (areas !== null) patchProject(ctx, project.id, { areas });
        setAppSetting(ctx, PAGE_LABELS_GUESSED_KEY, [...guessedIds(ctx.tx), project.id]);
      });
    } catch (error) {
      deps.logger.warn({ err: error, projectId: project.id }, 'page labels not saved');
    }
  }
}
