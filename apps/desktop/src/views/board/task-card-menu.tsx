import { BoardStatus, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import type { DropTarget, MenuMove } from './drop-rules';
import type { HoldOption } from './task-hold';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];
/**
 * An open task whose latest workstream was cancelled, or finished and was reopened after its pull
 * request closed, can run again; a failed one blocks the task and is retried from the Factory.
 */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Cancelled, WorkstreamState.Done];

/**
 * A Backlog task queues until its dependencies finish; a parked task never starts; a held one
 * queues again. A failed run shipped anyway whose pull request then closed without merging
 * (`shippedAnywayClosed`) sits in Blocked with nothing to retry, so it starts afresh from there.
 */
export function canStart(
  task: TaskDto,
  latest: WorkstreamState | undefined,
  shippedAnywayClosed = false,
): boolean {
  if (task.boardColumnId !== null || task.status !== TaskStatus.Open) return false;
  if (latest === WorkstreamState.Held) return true;
  if (shippedAnywayClosed && latest === WorkstreamState.Failed)
    return task.boardStatus === BoardStatus.Blocked;
  if (!STARTABLE.includes(task.boardStatus)) return false;
  return task.workstreamId === null || (latest !== undefined && RESTARTABLE.includes(latest));
}

export interface TaskCardMenuProps {
  readonly task: TaskDto;
  readonly latest: WorkstreamState | undefined;
  /** The latest run failed, shipped anyway, and its pull request closed without merging. */
  readonly shippedAnywayClosed?: boolean;
  /** A Start for this task is out; asking again would only repeat it. */
  readonly starting?: boolean;
  /** Title of an unfinished dependency parked in a human column, which would keep a started task queued for ever. */
  readonly parkedDependency: string | null;
  readonly moves: readonly MenuMove[];
  readonly onMove: (target: DropTarget) => void;
  readonly onStart: () => void;
  /** Present when the task waits for a lane; it goes first in line. */
  readonly onRunNext?: () => void;
  /** Hold for a started task that has not run, or why it can't be held; absent when there is nothing to hold. */
  readonly hold?: HoldOption | null;
  readonly onHold?: () => void;
  /** Present for a held task: removing it deletes its worktree and branch. */
  readonly onRemove?: () => void;
  /** Present when the task's workstream failed and the daemon will retry it. */
  readonly onRetry?: () => void;
  /** Present when the task's batch is open or not shipped; abandoning keeps the branch and cancels its unfinished tasks. */
  readonly onAbandon?: () => void;
  /** Why Abandon is held back: a run on the branch is live, and the daemon won't cut it short. */
  readonly abandonRefusal?: string | null;
  /** Present when the task's run failed or its pull request closed; closing takes the task off the Board. */
  readonly onCloseTask?: () => void;
  /** Present when the task's pull request closed without merging; reopening plans the task again. */
  readonly onReopenTask?: () => void;
  /** The line under Close: what becomes of the task's branch or worktree. */
  readonly closeLine?: string;
}

export function TaskCardMenu({
  task,
  latest,
  shippedAnywayClosed = false,
  starting = false,
  parkedDependency,
  moves,
  onMove,
  onStart,
  onRunNext,
  hold = null,
  onHold,
  onRemove,
  onRetry,
  onAbandon,
  abandonRefusal = null,
  onCloseTask,
  onReopenTask,
  closeLine,
}: TaskCardMenuProps) {
  const startable = canStart(task, latest, shippedAnywayClosed);
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Actions for ${task.title}`}
        >
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {moves.map((m) => (
          <Menu.Item
            key={m.label}
            disabled={m.target === null || m.refusal !== null}
            onClick={() => {
              if (m.target && m.refusal === null) onMove(m.target);
            }}
          >
            {m.refusal === null ? m.label : `${m.label} (${m.refusal})`}
          </Menu.Item>
        ))}
        {moves.length > 0 && startable ? <Menu.Divider /> : null}
        {startable ? (
          <Menu.Item disabled={starting || parkedDependency !== null} onClick={onStart}>
            {starting
              ? 'Starting…'
              : parkedDependency === null
                ? 'Start'
                : `Start (${parkedDependency} is parked; move it to Backlog or Ready first)`}
          </Menu.Item>
        ) : null}
        {onRunNext ? (
          <>
            {moves.length > 0 ? <Menu.Divider /> : null}
            <Menu.Item onClick={onRunNext}>Run Next</Menu.Item>
          </>
        ) : null}
        {hold ? (
          <Menu.Item
            disabled={hold.kind === 'refused'}
            onClick={() => {
              if (hold.kind === 'hold') onHold?.();
            }}
          >
            {hold.kind === 'hold' ? 'Hold' : `Hold (${hold.reason.replace(/\.$/, '')})`}
          </Menu.Item>
        ) : null}
        {onRemove ? (
          <Menu.Item color="red" onClick={onRemove}>
            Remove
          </Menu.Item>
        ) : null}
        {onRetry || onAbandon || onCloseTask || onReopenTask ? <Menu.Divider /> : null}
        {onRetry ? <Menu.Item onClick={onRetry}>Retry</Menu.Item> : null}
        {onReopenTask ? <Menu.Item onClick={onReopenTask}>Reopen</Menu.Item> : null}
        {onCloseTask ? (
          <>
            <Menu.Item onClick={onCloseTask}>Close</Menu.Item>
            {closeLine ? <Menu.Label tt="none">{closeLine}</Menu.Label> : null}
          </>
        ) : null}
        {onAbandon ? (
          <Menu.Item color="red" disabled={abandonRefusal !== null} onClick={onAbandon}>
            {abandonRefusal === null ? 'Abandon' : `Abandon (${abandonRefusal.replace(/\.$/, '')})`}
          </Menu.Item>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  );
}
