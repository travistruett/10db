import type { ProjectDto, TaskId } from '@10db/contracts';
import {
  findOpenTaskByFirstLine,
  getAppSetting,
  iceboxColumnId,
  insertTask,
  listActiveProjects,
  moveTask,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { CheckoutPin, projectPinKey } from '../git';
import { githubRepoOf } from '../github';

/** 10db's own GitHub repository, as `owner/name`: the project a defect task is filed in pushes there. */
export const TENDB_REPOSITORY = 'travistruett/10db';

/** The `owner/name` a pinned push URL names, or null when it names no GitHub repository or doesn't parse. */
function githubOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return githubRepoOf(url);
  } catch {
    return null;
  }
}

/**
 * 10db's own project on this Mac: the first project not archived whose pinned checkout pushes to
 * `TENDB_REPOSITORY`. The pin is read, not git, so this runs inside a write. A checkout never pinned reads
 * as none.
 */
export function tenDbProject(db: DbReader): ProjectDto | null {
  const wanted = TENDB_REPOSITORY.toLowerCase();
  return (
    listActiveProjects(db).find((project) => {
      // The stored pin is JSON read back from the database: a boundary, so parse it.
      const pin = CheckoutPin.safeParse(getAppSetting(db, projectPinKey(project.id)));
      return pin.success && githubOf(pin.data.pushUrl)?.toLowerCase() === wanted;
    }) ?? null
  );
}

/** The first line of a defect task's description, which repeats of the same defect fold on. */
export const defectSignatureLine = (signature: string): string => `Defect signature: ${signature}`;

/**
 * Files a defect in 10db's own project, parked in its Icebox and never started here, inside the caller's
 * write. Null, with nothing filed, when 10db's project is not on this Mac or has no area, or an open task
 * there already carries the signature.
 */
export function fileDefect(
  w: WriteContext,
  input: { readonly signature: string; readonly title: string; readonly description: string },
): TaskId | null {
  const project = tenDbProject(w.tx);
  const area = project?.areas[0]?.name;
  if (project === null || area === undefined) return null;
  const line = defectSignatureLine(input.signature);
  if (findOpenTaskByFirstLine(w.tx, project.id, line) !== null) return null;
  const task = insertTask(w, project.id, {
    title: input.title,
    description: `${line}\n\n${input.description}`,
    acceptanceCriteria: ['This defect no longer recurs.'],
    areas: [area],
  });
  const icebox = iceboxColumnId(w.tx, project.id);
  if (icebox !== null) moveTask(w, task.id, { to: icebox, after: null, before: null });
  return task.id;
}
