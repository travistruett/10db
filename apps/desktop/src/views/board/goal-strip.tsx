import { TaskStatus, type GoalSummaryDto, type TaskDto } from '@10db/contracts';
import { Box, Group, Paper, Text, UnstyledButton } from '@mantine/core';
import { useId } from 'react';
import { GOAL_STATUS_LOOK } from './goal-status';

/** A goal earns a strip while any of its tasks is open; a goal with all its tasks finished or cancelled has none. */
export function goalsWithOpenTasks(
  goals: readonly GoalSummaryDto[],
  tasks: readonly TaskDto[],
): GoalSummaryDto[] {
  const open = new Set(tasks.filter((t) => t.status === TaskStatus.Open).map((t) => t.goalId));
  return goals.filter((g) => open.has(g.goal.id));
}

/** "6 of 11 tasks": the tasks merged out of those not cancelled; a task in review is not counted. */
export function progressLine(summary: GoalSummaryDto): string {
  const { merged, total } = summary.digest.progress;
  return `${String(merged)} of ${String(total)} ${total === 1 ? 'task' : 'tasks'}`;
}

/** One slim line for a goal: the status dot, its title and how far along it is. Opens the goal's drawer. */
export function GoalStrip({
  summary,
  onOpen,
}: {
  readonly summary: GoalSummaryDto;
  readonly onOpen: () => void;
}) {
  const summaryId = useId();
  const look = GOAL_STATUS_LOOK[summary.digest.status];
  return (
    <Paper withBorder px="sm" py={4} data-testid="goal-strip">
      <UnstyledButton
        onClick={onOpen}
        aria-label={summary.goal.title}
        aria-describedby={summaryId}
        w="100%"
      >
        <Group gap="sm" wrap="nowrap">
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
          <Text size="sm" fw={500} truncate="end" style={{ minWidth: 0 }}>
            {summary.goal.title}
          </Text>
          <Group id={summaryId} gap="xs" wrap="nowrap" ml="auto" style={{ flex: 'none' }}>
            <Text size="sm" c="dimmed">
              {progressLine(summary)}
            </Text>
            <Text size="sm" c="dimmed">
              {look.label}
            </Text>
          </Group>
        </Group>
      </UnstyledButton>
    </Paper>
  );
}
