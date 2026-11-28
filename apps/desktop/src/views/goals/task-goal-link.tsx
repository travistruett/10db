import type { TaskDto } from '@10db/contracts';
import { Anchor, Group, Text } from '@mantine/core';
import { IconTarget } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useGoals } from '../../daemon/goal-queries';

/** "Goal · Review links" under a task's title, a link to the goal's page; nothing for a task in no goal. */
export function TaskGoalLink({ task }: { readonly task: Pick<TaskDto, 'goalId' | 'projectId'> }) {
  const goals = useGoals(task.goalId == null ? null : task.projectId);
  const goal = goals.data?.goals.find((g) => g.goal.id === task.goalId)?.goal;
  if (goal === undefined) return null;
  return (
    <Group gap={6} wrap="nowrap">
      <IconTarget size={14} stroke={1.5} aria-hidden style={{ flex: 'none' }} />
      <Text size="sm" c="dimmed" style={{ minWidth: 0 }} truncate>
        {'Goal · '}
        <Anchor
          size="sm"
          renderRoot={(props) => <Link {...props} to="/goals" search={{ goal: goal.id }} />}
        >
          {goal.title}
        </Anchor>
      </Text>
    </Group>
  );
}
