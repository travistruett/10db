import { Alert, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useGoalList } from '../../daemon/goal-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { GoalList } from './goal-list';

/** Factory: the project's goals, each opening to its digest, sessions and pull requests (goals spec §8). */
export function FactoryView() {
  const { project } = useSelectedProject();
  const goals = useGoalList(project?.id ?? null);

  return (
    <Stack>
      <Stack gap={2}>
        <Group gap="md">
          <Title order={2}>Factory</Title>
          <BenchmarkSyncNote />
        </Group>
        <Text size="sm" c="dimmed">
          Goals 10db is pursuing in this project
        </Text>
      </Stack>
      {goals.isError ? (
        <Alert color="red" title="Couldn't load the goals">
          {goals.error.message}
        </Alert>
      ) : null}
      {goals.isLoading ? <Loader size="sm" aria-label="Loading goals" /> : null}
      {goals.isSuccess && goals.data.goals.length === 0 ? (
        <Text size="sm" c="dimmed">
          Goals are outcomes 10db pursues across many tasks. Adopt a plan to start one, or ask
          Claude Code to with the 10db-task skill.
        </Text>
      ) : null}
      {goals.isSuccess ? <GoalList list={goals.data} /> : null}
    </Stack>
  );
}
