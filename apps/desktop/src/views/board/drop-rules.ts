import {
  ACTIVE_STATES,
  BoardStatus,
  SYSTEM_COLUMN_LABEL,
  type BoardColumnId,
  type TaskDto,
  type TaskId,
  type TaskMove,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { columnKeyId, sameColumn, type ColumnKey, type LayoutColumn } from './board-layout';

export type DropAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'refuse'; readonly reason: string }
  | {
      readonly kind: 'move';
      readonly taskId: TaskId;
      readonly move: TaskMove;
      /** The client's estimate of the stored order, for the optimistic placement only. */
      readonly order: number;
      readonly note: string | null;
    }
  | { readonly kind: 'start'; readonly taskId: TaskId };

export interface DropTarget {
  readonly key: ColumnKey;
  readonly index: number;
}

export interface MenuMove {
  readonly label: string;
  /** Null when the move would do nothing. */
  readonly target: DropTarget | null;
  /** Why the move is refused; null when it is allowed. */
  readonly refusal: string | null;
}

/**
 * For each task, the title of a dependent that has started (its latest workstream is queued or further,
 * and not finished). The daemon refuses to park such a task: parked, it never finishes and the dependent
 * would stay queued for ever.
 */
export function startedDependents(
  tasks: readonly TaskDto[],
  workstreams: ReadonlyMap<WorkstreamId, Pick<WorkstreamDto, 'state'>>,
): Map<TaskId, string> {
  const held = new Map<TaskId, string>();
  for (const task of tasks) {
    const state = task.workstreamId ? workstreams.get(task.workstreamId)?.state : undefined;
    if (state === undefined || !ACTIVE_STATES.includes(state)) continue;
    for (const id of task.dependsOn) if (!held.has(id)) held.set(id, task.title);
  }
  return held;
}

function parkRefusal(task: TaskDto, dependent: string): string {
  return `${dependent} has started and waits on ${task.title}; park it once ${dependent} finishes`;
}

const LOCKED_DROP =
  'Blocked, In review and Done follow the task’s state; cards can’t be dropped there';

/** Why cards in a column can't be dragged; null when they can. */
export function dragRefusal(key: ColumnKey): string | null {
  if (key.kind === 'human') return null;
  switch (key.status) {
    case BoardStatus.Backlog:
    case BoardStatus.Ready:
      return null;
    case BoardStatus.InProgress:
      return 'In progress cards follow their workstream; they can’t be dragged';
    case BoardStatus.InReview:
      return 'In review cards follow their pull request; they can’t be dragged';
    case BoardStatus.Blocked:
      return 'Blocked cards wait for a retry or an answer; they can’t be dragged';
    case BoardStatus.Done:
      return 'Done cards stay where they finished; they can’t be dragged';
  }
}

function locate(layout: readonly LayoutColumn[], taskId: TaskId) {
  for (const column of layout) {
    const index = column.tasks.findIndex((t) => t.id === taskId);
    const task = column.tasks[index];
    if (task) return { column, index, task };
  }
  return null;
}

function place(
  layout: readonly LayoutColumn[],
  task: TaskDto,
  from: ColumnKey,
  fromIndex: number,
  to: DropTarget,
  boardColumnId: BoardColumnId | null,
  note: string | null,
): DropAction {
  const target = layout.find((c) => sameColumn(c.key, to.key));
  if (!target) return { kind: 'none' };
  const rest = target.tasks.filter((t) => t.id !== task.id);
  const index = Math.max(0, Math.min(to.index, rest.length));
  if (sameColumn(from, to.key) && fromIndex === index) return { kind: 'none' };
  const after = index > 0 ? rest[index - 1] : undefined;
  const before = rest[index];
  const order =
    after && before
      ? (after.boardOrder + before.boardOrder) / 2
      : after
        ? after.boardOrder + 1
        : before
          ? before.boardOrder - 1
          : task.boardOrder;
  return {
    kind: 'move',
    taskId: task.id,
    move: { to: boardColumnId, after: after?.id ?? null, before: before?.id ?? null },
    order,
    note,
  };
}

/**
 * The board's drag rules: free among human columns and planned work, a start into In progress, nothing
 * else. `started` is `startedDependents` for the board's tasks.
 */
export function resolveDrop(
  layout: readonly LayoutColumn[],
  taskId: TaskId,
  to: DropTarget,
  started: ReadonlyMap<TaskId, string>,
): DropAction {
  const found = locate(layout, taskId);
  if (!found) return { kind: 'none' };
  const { column, index, task } = found;
  const refusal = dragRefusal(column.key);
  if (refusal) return { kind: 'refuse', reason: refusal };
  if (to.key.kind === 'human') {
    const dependent = started.get(task.id);
    if (dependent !== undefined) return { kind: 'refuse', reason: parkRefusal(task, dependent) };
    return place(layout, task, column.key, index, to, to.key.id, null);
  }
  switch (to.key.status) {
    case BoardStatus.InProgress:
      if (column.key.kind === 'human')
        return {
          kind: 'refuse',
          reason: `Move ${task.title} to Backlog or Ready before starting it`,
        };
      return column.key.status === BoardStatus.Ready
        ? { kind: 'start', taskId }
        : {
            kind: 'refuse',
            reason:
              'Only a Ready card starts by dragging; use Start in its menu to queue it until its dependencies finish',
          };
    case BoardStatus.InReview:
    case BoardStatus.Blocked:
    case BoardStatus.Done:
      return { kind: 'refuse', reason: LOCKED_DROP };
    case BoardStatus.Backlog:
    case BoardStatus.Ready: {
      // The derived column decides: a task's dependencies, not the drop, put it in Backlog or Ready.
      const lands = task.boardStatus;
      const note =
        lands !== to.key.status
          ? `${task.title} ${lands === BoardStatus.Backlog ? 'waits on its dependencies, so it is in Backlog' : 'has no unfinished dependencies, so it is in Ready'}`
          : null;
      return place(layout, task, column.key, index, to, null, note);
    }
  }
}

/** A dnd-kit `over.id`: a card's task ID, or `column:<columnKeyId>` for a column's empty space. */
export function dropTarget(
  layout: readonly LayoutColumn[],
  overId: string | null,
): DropTarget | null {
  if (overId === null) return null;
  for (const column of layout) {
    if (overId === `column:${columnKeyId(column.key)}`)
      return { key: column.key, index: column.tasks.length };
    const index = column.tasks.findIndex((t) => t.id === overId);
    if (index >= 0) return { key: column.key, index };
  }
  return null;
}

/** The card menu's moves: the same rules as a drag, without a pointer (WCAG 2.2 SC 2.5.7). */
export function menuMoves(
  layout: readonly LayoutColumn[],
  taskId: TaskId,
  started: ReadonlyMap<TaskId, string>,
): MenuMove[] {
  const found = locate(layout, taskId);
  if (!found || dragRefusal(found.column.key)) return [];
  const { column, index, task } = found;
  const dependent = started.get(task.id);
  // Every move into a human column parks the task, a reorder inside one included.
  const refusalFor = (key: ColumnKey): string | null =>
    key.kind === 'human' && dependent !== undefined ? parkRefusal(task, dependent) : null;
  const last = column.tasks.length - 1;
  const at = (i: number): DropTarget | null => (i === index ? null : { key: column.key, index: i });
  const moves: MenuMove[] = [
    { label: 'Move to top', target: at(0) },
    { label: 'Move up', target: index > 0 ? at(index - 1) : null },
    { label: 'Move down', target: index < last ? at(index + 1) : null },
    { label: 'Move to bottom', target: at(last) },
  ].map((m) => ({ ...m, refusal: refusalFor(column.key) }));
  for (const other of layout) {
    if (other.key.kind !== 'human' || sameColumn(other.key, column.key)) continue;
    moves.push({
      label: `Move to ${other.label}`,
      target: { key: other.key, index: 0 },
      refusal: refusalFor(other.key),
    });
  }
  if (column.key.kind === 'human') {
    const status =
      task.boardStatus === BoardStatus.Backlog ? BoardStatus.Backlog : BoardStatus.Ready;
    moves.push({
      label: `Move to ${SYSTEM_COLUMN_LABEL[status]}`,
      target: { key: { kind: 'system', status }, index: 0 },
      refusal: null,
    });
  }
  return moves;
}

/** The task list with one task placed, sorted as the daemon sorts it. */
export function placeLocally(
  tasks: readonly TaskDto[],
  taskId: TaskId,
  order: number,
  boardColumnId: BoardColumnId | null,
): TaskDto[] {
  return tasks
    .map((t) => (t.id === taskId ? { ...t, boardOrder: order, boardColumnId } : t))
    .sort((x, y) => x.boardOrder - y.boardOrder);
}
