import { BoardStatus, TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';
import { ActionIcon, Menu } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';

const STARTABLE: readonly BoardStatus[] = [BoardStatus.Ready, BoardStatus.Backlog];
/** A task whose latest workstream ended without finishing can run again. */
const RESTARTABLE: readonly WorkstreamState[] = [WorkstreamState.Failed, WorkstreamState.Cancelled];

/** A Backlog task queues until its dependencies finish; a parked task never starts. */
export function canStart(task: TaskDto, latest: WorkstreamState | undefined): boolean {
  if (task.boardColumnId !== null) return false;
  if (task.status !== TaskStatus.Open || !STARTABLE.includes(task.boardStatus)) return false;
  return task.workstreamId === null || (latest !== undefined && RESTARTABLE.includes(latest));
}

export interface TaskCardMenuProps {
  readonly task: TaskDto;
  readonly latest: WorkstreamState | undefined;
  readonly onStart: () => void;
}

export function TaskCardMenu({ task, latest, onStart }: TaskCardMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={`Actions for ${task.title}`}>
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canStart(task, latest) ? <Menu.Item onClick={onStart}>Start</Menu.Item> : null}
      </Menu.Dropdown>
    </Menu>
  );
}
