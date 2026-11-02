import { Alert, Button, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useGoals } from '../../daemon/goal-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { GoalList } from './goal-list';

/** Factory: the project's goals, each opening to its digest, sessions and pull requests (goals spec §8). */
export function FactoryView() {
  const { project } = useSelectedProject();
  // Keyed by project so an open row or a failure never carries into another one.
  return <Factory key={project?.id ?? 'none'} />;
}

function Factory() {
  const { project } = useSelectedProject();
  const goals = useGoals(project?.id ?? null);

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Group gap="md">
            <Title order={2}>Factory</Title>
            <BenchmarkSyncNote />
          </Group>
          <Text size="sm" c="dimmed">
            Goals 10db is pursuing in this project
          </Text>
        </Stack>
        {/* Shape Work… opens a new conversation (Shape spec §4); a brief made elsewhere is still adopted by the route. */}
        <Button component={Link} to="/shape">
          Shape Work…
        </Button>
      </Group>
      {goals.isError ? (
        <Alert color="red" title="Couldn't load the goals">
          {goals.error.message}
        </Alert>
      ) : null}
      {goals.isLoading ? <Loader size="sm" aria-label="Loading goals" /> : null}
      {goals.isSuccess && goals.data.goals.length === 0 ? (
        <Text size="sm" c="dimmed">
          Goals are outcomes 10db pursues across many tasks. Shape Work… to start one, or ask Claude
          Code to with the 10db-task skill.
        </Text>
      ) : null}
      {goals.isSuccess ? <GoalList list={goals.data} /> : null}
    </Stack>
  );
}
