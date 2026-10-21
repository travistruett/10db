import { z } from 'zod';
import { BoardColumnId, ProjectId, TaskId } from './ids';

/** The human column every new project starts with. */
export const DEFAULT_BOARD_COLUMN = 'Icebox';

export const BoardColumnName = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(40, 'Use at most 40 characters');

/**
 * A column the builder names and orders. A task in one is parked: never picked and never launched.
 * Later fields (a linked person, an on-drop behavior) arrive as nullable additions.
 */
export const BoardColumnDto = z.object({
  id: BoardColumnId,
  projectId: ProjectId,
  name: z.string(),
  position: z.int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BoardColumnDto = z.infer<typeof BoardColumnDto>;

export const BoardColumnInput = z.object({ name: BoardColumnName });
export type BoardColumnInput = z.infer<typeof BoardColumnInput>;

export const BoardColumnPatch = z
  .object({ name: BoardColumnName, position: z.int().min(0) })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type BoardColumnPatch = z.infer<typeof BoardColumnPatch>;

/** Where a deleted column's tasks go: another human column, or null for planned. */
export const BoardColumnDelete = z.object({ moveTasksTo: BoardColumnId.nullable() });
export type BoardColumnDelete = z.infer<typeof BoardColumnDelete>;

/**
 * Where a dragged task lands: in human column `to`, or planned when `to` is null, directly below
 * `after` and directly above `before`. The daemon computes the stored order from the neighbours.
 */
export const TaskMove = z
  .object({ to: BoardColumnId.nullable(), after: TaskId.nullable(), before: TaskId.nullable() })
  .refine((m) => m.after === null || m.after !== m.before, {
    message: 'after and before must be different tasks',
    path: ['before'],
  });
export type TaskMove = z.infer<typeof TaskMove>;
