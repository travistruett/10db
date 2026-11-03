import { Alert, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useSearch } from '@tanstack/react-router';
import { useGoals } from '../../daemon/goal-queries';
import { useSelectedProject } from '../../shell/selected-project';
import { AdoptPlanButton, AdoptProblem, RefusalModal, TypedPathModal } from './adopt-plan';
import { BenchmarkSyncNote } from './benchmark-sync-note';
import { GoalList } from './goal-list';
import { useAdoptPlan } from './use-adopt-plan';

/** Factory: the project's goals, each opening to its digest, sessions and pull requests (goals spec §8). */
export function FactoryView() {
  const { project } = useSelectedProject();
  // Keyed by project so a refusal, an open form or a failure never carries into another one.
  return <Factory key={project?.id ?? 'none'} />;
}

function Factory() {
  const { project } = useSelectedProject();
  const goals = useGoals(project?.id ?? null);
  const adoption = useAdoptPlan(project?.id ?? null);
  const { goal: linkedGoalId } = useSearch({ from: '/factory' });

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
        <AdoptPlanButton adoption={adoption} />
      </Group>
      {/* An open modal shows the problem itself, so it is not shown twice. */}
      {adoption.refusal === null && !adoption.typing ? <AdoptProblem adoption={adoption} /> : null}
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
      {goals.isSuccess ? <GoalList list={goals.data} linkedGoalId={linkedGoalId} /> : null}

      <RefusalModal adoption={adoption} />
      <TypedPathModal adoption={adoption} />
    </Stack>
  );
}
