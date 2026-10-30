import { z } from 'zod';
import { BoardColumnId, ProjectId, TaskId } from './ids';
import { BoardStatus } from './states';

/** The human column every new project starts with. */
export const DEFAULT_BOARD_COLUMN = 'Icebox';

/** The labels of the derived columns; a human column can't take one. */
export const SYSTEM_COLUMN_LABEL: Readonly<Record<BoardStatus, string>> = {
  [BoardStatus.Backlog]: 'Backlog',
  [BoardStatus.Ready]: 'Ready',
  [BoardStatus.InProgress]: 'In progress',
  [BoardStatus.InReview]: 'In review',
  [BoardStatus.Blocked]: 'Blocked',
  [BoardStatus.Done]: 'Done',
};

/** Latin look-alikes from other scripts, folded so a name can't pass as a system label or another column. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0430': 'a',
  '\u0435': 'e',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u0456': 'i',
  '\u0455': 's',
  '\u0458': 'j',
  '\u03bf': 'o',
  '\u03b1': 'a',
  '\u03b9': 'i',
  '\u03c1': 'p',
};

/** Bidi controls, the zero-width space and the byte-order mark: invisible, and never part of a real name. */
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/** The stored form: invisible junk removed and whitespace collapsed, but joiners, digits and letters kept as typed. */
export function cleanColumnName(name: string): string {
  return name.replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

/** What two names must differ in to be different columns: case, look-alike letters, width forms and spacing do not count. */
export function columnNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/./gsu, (c) => LOOKALIKES[c] ?? c);
}

/**
 * Cleaned first, then limited, so trailing spaces never count against the 40. JSON Schema can't say
 * "after cleanup", so the published schema checks one typed character and states the limit in words.
 */
export const BoardColumnName = z
  .string()
  .min(1, 'Enter a name')
  .transform(cleanColumnName)
  .pipe(z.string().min(1, 'Enter a name').max(40, 'Use at most 40 characters'))
  .meta({
    description:
      'At most 40 characters once invisible characters are removed, whitespace runs become one space and the ends are trimmed.',
  });

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

/** Where a deleted column's tasks go: another human column, or the literal 'planned'. A caller must say which; there is no default. */
export const BoardColumnDelete = z.object({
  moveTasksTo: z.union([BoardColumnId, z.literal('planned')]),
});
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
