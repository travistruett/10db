import {
  BoardStatus,
  SYSTEM_COLUMN_LABEL,
  TaskStatus,
  type GoalSummaryDto,
  type TaskDto,
} from '@10db/contracts';
import { Badge, Box, Button, Drawer, Group, List, Stack, Text } from '@mantine/core';
import { GOAL_STATUS_LOOK } from './goal-status';
import { progressLine } from './goal-strip';

interface GoalDrawerProps {
  readonly summary: GoalSummaryDto;
  /** The goal's tasks on the Board, whichever column they are in. */
  readonly tasks: readonly TaskDto[];
  /** Opens the batch sheet over this goal's ready tasks. */
  readonly onStartReady: () => void;
  readonly onClose: () => void;
}

interface Blocker {
  readonly key: string;
  readonly title: string;
  readonly reason: string;
}

/**
 * What holds the goal up: a card waiting on someone, and any task parked in Blocked that has no
 * card of its own to say why (a failed run, a pull request closed without merging).
 */
function blockersOf(summary: GoalSummaryDto, tasks: readonly TaskDto[]): Blocker[] {
  const { recent, earlier } = summary.digest.waitingOn;
  const cards = [...recent, ...earlier].map((card): Blocker => ({
    key: card.inboxItemId,
    title: card.title,
    reason: `Waiting on ${card.assigneeName}`,
  }));
  const carded = new Set([...recent, ...earlier].map((card) => card.taskId));
  const stuck = tasks
    .filter((t) => t.boardStatus === BoardStatus.Blocked && !carded.has(t.id))
    .map((t): Blocker => ({ key: t.id, title: t.title, reason: 'Blocked' }));
  return [...cards, ...stuck];
}

function taskLine(task: TaskDto): string {
  return task.status === TaskStatus.Cancelled ? 'Cancelled' : SYSTEM_COLUMN_LABEL[task.boardStatus];
}

/** A goal's brief at a glance: the objective, its criteria (read-only), its tasks and what blocks it. */
export function GoalDrawer({ summary, tasks, onStartReady, onClose }: GoalDrawerProps) {
  const { goal, digest } = summary;
  const look = GOAL_STATUS_LOOK[digest.status];
  const ready = tasks.filter(
    (t) => t.status === TaskStatus.Open && t.boardStatus === BoardStatus.Ready,
  ).length;
  const blockers = blockersOf(summary, tasks);
  return (
    <Drawer opened onClose={onClose} position="right" size={520} title="Goal" padding="lg">
      <Stack gap="lg">
        <Stack gap={4}>
          <Text fw={600} size="lg">
            {goal.title}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Box
              w={8}
              h={8}
              style={{
                flex: 'none',
                borderRadius: '50%',
                background: `var(--mantine-color-${look.color}-filled)`,
              }}
            />
            <Text size="sm">{look.label}</Text>
            <Text size="sm" c="dimmed">
              {progressLine(summary)}
            </Text>
          </Group>
        </Stack>

        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Objective
          </Text>
          <Text size="sm">{goal.objective}</Text>
          {goal.caresMost ? (
            <Text size="sm" c="dimmed">{`Cares most about: ${goal.caresMost}`}</Text>
          ) : null}
        </Stack>

        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Criteria
          </Text>
          {goal.criteria.length === 0 ? (
            <Text size="sm" c="dimmed">
              None yet.
            </Text>
          ) : (
            <List size="sm" spacing={4}>
              {goal.criteria.map((c) => (
                <List.Item key={c.id}>{c.text}</List.Item>
              ))}
            </List>
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Tasks
          </Text>
          <Stack gap={6}>
            {tasks.map((t) => (
              <Group key={t.id} justify="space-between" wrap="nowrap" gap="sm">
                <Text size="sm">{t.title}</Text>
                <Badge size="sm" variant="light" color="gray" tt="none" fw={500}>
                  {taskLine(t)}
                </Badge>
              </Group>
            ))}
          </Stack>
        </Stack>

        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Blockers
          </Text>
          {blockers.length === 0 ? (
            <Text size="sm" c="dimmed">
              Nothing is blocking this goal.
            </Text>
          ) : (
            <Stack gap={6}>
              {blockers.map((b) => (
                <Group key={b.key} justify="space-between" wrap="nowrap" gap="sm">
                  <Text size="sm">{b.title}</Text>
                  <Text size="sm" c="yellow">
                    {b.reason}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>

        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {ready === 0 ? 'Nothing in Ready' : `${String(ready)} ready`}
          </Text>
          <Button disabled={ready === 0} onClick={onStartReady}>
            Start Ready Tasks…
          </Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
