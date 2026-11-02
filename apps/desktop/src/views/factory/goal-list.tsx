import type { GoalSummaryDto } from '@10db/contracts';
import { Badge, Stack, Table, Text, Title } from '@mantine/core';
import { GOAL_STATUS_COLORS, GOAL_STATUS_LABELS } from './goal-status';

/** The project's goals, one line each: title, status, progress and how much is new since the builder last looked. */
export function GoalList({ goals }: { readonly goals: readonly GoalSummaryDto[] }) {
  return (
    <Stack gap="xs">
      <Title order={3}>Goals</Title>
      {goals.length === 0 ? (
        <Text c="dimmed">No goals yet.</Text>
      ) : (
        <Table highlightOnHover verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Goal</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Progress</Table.Th>
              <Table.Th>New</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {goals.map(({ goal, digest, newItems }) => (
              <Table.Tr key={goal.id}>
                <Table.Td>
                  <Text size="sm">{goal.title}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={GOAL_STATUS_COLORS[digest.status]} variant="light" size="sm">
                    {GOAL_STATUS_LABELS[digest.status]}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">
                    {`${String(digest.progress.done)} of ${String(digest.progress.total)} tasks done`}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {newItems > 0 ? <Text size="sm">{`${String(newItems)} new`}</Text> : null}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
