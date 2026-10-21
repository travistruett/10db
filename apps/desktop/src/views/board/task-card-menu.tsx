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
  readonly moves: readonly MenuMove[];
  readonly onMove: (target: DropTarget) => void;
  readonly onStart: () => void;
}

export function TaskCardMenu({ task, latest, moves, onMove, onStart }: TaskCardMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${task.title}`}>
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {moves.map((m) => (
          <Menu.Item
            key={m.label}
            disabled={m.target === null}
            onClick={() => {
              if (m.target) onMove(m.target);
            }}
          >
            {m.label}
          </Menu.Item>
        ))}
        {moves.length > 0 && canStart(task, latest) ? <Menu.Divider /> : null}
        {canStart(task, latest) ? <Menu.Item onClick={onStart}>Start</Menu.Item> : null}
      </Menu.Dropdown>
    </Menu>
  );
}
