import { BoardStatus, TaskStatus, type GoalSummaryDto, type TaskDto } from '@10db/contracts';
import { ActionIcon, Box, Button, Group, Menu, Text } from '@mantine/core';
import { IconChevronRight, IconDots, IconTrash } from '@tabler/icons-react';
import { useRemoveDraftGoalAction } from '../shape/remove-draft-goal';
import { GOAL_STATUS_LOOK } from './goal-status';

/** The goal's open tasks sitting in Ready: what Start Ready would propose. */
export function readyCountOf(goalId: GoalSummaryDto['goal']['id'], tasks: readonly TaskDto[]) {
  return tasks.filter(
    (t) =>
      t.goalId === goalId && t.status === TaskStatus.Open && t.boardStatus === BoardStatus.Ready,
  ).length;
}

/** "Idle · 4 in review · 1 ready": the status, then each count that is more than none. */
export function goalLineText(summary: GoalSummaryDto, ready: number): string {
  const { inReview } = summary.digest.progress;
  return [
    GOAL_STATUS_LOOK[summary.digest.status].label,
    inReview > 0 ? `${String(inReview)} in review` : null,
    ready > 0 ? `${String(ready)} ready` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

interface GoalLineProps {
  readonly summary: GoalSummaryDto;
  /** How many of the goal's tasks are in Ready. */
  readonly ready: number;
  /** Opens the batch sheet over this goal's ready tasks. */
  readonly onStartReady: () => void;
  /** Goes to Factory with this goal open: its detail lives there, not on the Board. */
  readonly onOpenFactory: () => void;
}

/**
 * The one line beside the Goal select once a goal is chosen: where it stands, the action that moves
 * its ready tasks, and the way into Factory, where goals are read.
 */
export function GoalLine({ summary, ready, onStartReady, onOpenFactory }: GoalLineProps) {
  const look = GOAL_STATUS_LOOK[summary.digest.status];
  const removal = useRemoveDraftGoalAction(summary);
  return (
    <Group gap="sm" wrap="nowrap" data-testid="goal-line">
      <Box
        data-testid="goal-dot"
        data-color={look.color}
        w={8}
        h={8}
        style={{
          flex: 'none',
          borderRadius: '50%',
          background: `var(--mantine-color-${look.color}-filled)`,
        }}
      />
      <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {goalLineText(summary, ready)}
      </Text>
      <Button variant="default" size="compact-sm" disabled={ready === 0} onClick={onStartReady}>
        Start Ready
      </Button>
      <Button
        variant="subtle"
        size="compact-sm"
        rightSection={<IconChevronRight size={14} stroke={1.5} />}
        onClick={onOpenFactory}
      >
        Open in Factory
      </Button>
      {removal.offer === 'available' ? (
        <>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="More goal actions">
                <IconDots size={16} stroke={1.5} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={16} stroke={1.5} />}
                onClick={removal.open}
              >
                Remove Draft Goal
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {removal.modal}
        </>
      ) : null}
    </Group>
  );
}
