import { fromTaskRow, TaskRowDto, type ProjectId } from '@10db/contracts';
import { z } from 'zod';

/**
 * The schema for `GET /projects/:id/tasks`: the rows the route sends, read back as the desktop reads them.
 * A row leaves out the description, the criteria text and the rigor's reasons, and a done and merged task's
 * kinds and rigor; a test that needs one of those reads the task whole (`GET /tasks/:taskId`).
 */
export const taskListOf = (projectId: ProjectId | string) =>
  z
    .array(TaskRowDto)
    .transform((rows) => rows.map((row) => fromTaskRow(projectId as ProjectId, row)));
