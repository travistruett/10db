import {
  BoardStatus,
  type BoardColumnDto,
  type BoardColumnId,
  type TaskDto,
} from '@10db/contracts';
import { BOARD_STATUS } from './board-status';

export type ColumnKey =
  | { readonly kind: 'human'; readonly id: BoardColumnId }
  | { readonly kind: 'system'; readonly status: BoardStatus };

export interface LayoutColumn {
  readonly key: ColumnKey;
  readonly label: string;
  readonly tasks: readonly TaskDto[];
}

/** Spec §10's derived columns, in order; they sit right of the human columns. */
export const SYSTEM_COLUMNS: readonly BoardStatus[] = [
  BoardStatus.Backlog,
  BoardStatus.Ready,
  BoardStatus.InProgress,
  BoardStatus.Blocked,
  BoardStatus.Done,
];

/** Done cards shown before "Show all"; the column only grows. */
export const DONE_LIMIT = 20;

export function columnKeyId(key: ColumnKey): string {
  switch (key.kind) {
    case 'human':
      return `human:${key.id}`;
    case 'system':
      return `system:${key.status}`;
  }
}

export function sameColumn(a: ColumnKey, b: ColumnKey): boolean {
  return columnKeyId(a) === columnKeyId(b);
}

const byOrder = (a: TaskDto, b: TaskDto) => a.boardOrder - b.boardOrder;
const recentFirst = (a: TaskDto, b: TaskDto) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * The board's columns: the builder's human columns by position, then the system columns. A parked
 * task sits in its human column; every other task, and one whose column is gone, in its derived one.
 */
export function boardLayout(
  columns: readonly BoardColumnDto[],
  tasks: readonly TaskDto[],
): LayoutColumn[] {
  const human = [...columns].sort((a, b) => a.position - b.position);
  const known = new Set(human.map((c) => c.id));
  const parkedIn = (task: TaskDto) =>
    task.boardColumnId !== null && known.has(task.boardColumnId) ? task.boardColumnId : null;
  return [
    ...human.map((column): LayoutColumn => ({
      key: { kind: 'human', id: column.id },
      label: column.name,
      tasks: tasks.filter((t) => parkedIn(t) === column.id).sort(byOrder),
    })),
    ...SYSTEM_COLUMNS.map((status): LayoutColumn => ({
      key: { kind: 'system', status },
      label: BOARD_STATUS[status].label,
      tasks: tasks
        .filter((t) => parkedIn(t) === null && t.boardStatus === status)
        .sort(status === BoardStatus.Done ? recentFirst : byOrder),
    })),
  ];
}
