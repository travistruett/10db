import { BoardStatus, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import type { DropTarget, MenuMove } from './drop-rules';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];
/** A task whose latest workstream was cancelled can run again; a failed one blocks the task and is retried from the Factory. */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Cancelled];

/** A Backlog task queues until its dependencies finish; a parked task never starts. */
export function canStart(task: TaskDto, latest: WorkstreamState | undefined): boolean {
  if (task.boardColumnId !== null) return false;
  if (task.status !== TaskStatus.Open || !STARTABLE.includes(task.boardStatus)) return false;
  return task.workstreamId === null || (latest !== undefined && RESTARTABLE.includes(latest));
}

export interface TaskCardMenuProps {
  readonly task: TaskDto;
  readonly latest: WorkstreamState | undefined;
  /** A Start for this task is out; asking again would only repeat it. */
  readonly starting?: boolean;
  /** Title of an unfinished dependency parked in a human column, which would keep a started task queued for ever. */
  readonly parkedDependency: string | null;
  readonly moves: readonly MenuMove[];
  readonly onMove: (target: DropTarget) => void;
  readonly onStart: () => void;
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
  starting = false,
  parkedDependency,
  moves,
  onMove,
  onStart,
  onRetry,
  onAbandon,
  abandonRefusal = null,
  onCloseTask,
  onReopenTask,
  closeLine,
}: TaskCardMenuProps) {
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
        {moves.length > 0 && canStart(task, latest) ? <Menu.Divider /> : null}
        {canStart(task, latest) ? (
          <Menu.Item disabled={starting || parkedDependency !== null} onClick={onStart}>
            {starting
              ? 'Starting…'
              : parkedDependency === null
                ? 'Start'
                : `Start (${parkedDependency} is parked; move it to Backlog or Ready first)`}
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
